import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './extension-fixture.mjs';
import {image} from './ocr-fixture.mjs';
import {pointerEvent} from './mouse-selection.mjs';
import {pangoSelection, dragPoints} from './pango-selection-fixture.mjs';

const text = '第一行中文文字\n第二行中文文字\n第三行中文文字\n最后一行中文末字';
function open(options = {}, action = 'ocr', value = text) {
    const f = fixture({ocr: action === 'ocr'}); f.extension._closeUI();
    const window = f.createWindow('source', action, action === 'ocr' ? {ocrImage: image()} : {});
    const label = window._resultLabel, layout = pangoSelection(f, window, label, value, options);
    return {...f, window, label, layout};
}

test('2x render scale: fourth-line pointer selects fourth-line text immediately, not the second line', () => {
    const f = open({resourceScale: 2});
    f.pointer([...f.layout.start, 256]);
    f.window._resultContainer.emit('captured-event', pointerEvent(f, f.layout.actor, f.layout.start));
    const point = f.layout.point(25, 3); f.pointer([...point, 256]);
    // Real motion handler only: no frame tick, idle or delay can hide a wrong mapping.
    f.layout.actor.emit('motion-event', pointerEvent(f, f.layout.actor, point));
    assert.equal(f.window._getOutputSelection(), text.slice(0, text.lastIndexOf('\n') + 1) + '最后一');
    assert.equal(f.window._selectionState.selecting, true);
    f.manager.disable();
});

for (const resourceScale of [1.25, 1.5, 1.75, 2, 3]) {
    test(`every visual line tracks the pointer at resource scale ${resourceScale}`, () => {
        const f = open({resourceScale}, 'translate');
        f.pointer([...f.layout.start, 256]);
        f.window._resultContainer.emit('captured-event', pointerEvent(f, f.layout.actor, f.layout.start));
        const lines = text.split('\n');
        for (let row = 0; row < lines.length; row++) {
            const point = f.layout.point(15, row); f.pointer([...point, 256]);
            f.layout.actor.emit('motion-event', pointerEvent(f, f.layout.actor, point));
            const prefix = row ? lines.slice(0, row).join('\n') + '\n' : '';
            assert.equal(f.window._getOutputSelection(), prefix + lines[row].slice(0, 2));
        }
        f.manager.disable();
    });
}

test('resource scale is independent of actor transform and uses render-space layout offsets', () => {
    const f = open({resourceScale: 2, scale: 1.5, offsets: [7, 9]});
    dragPoints(f, f.window, f.label, f.layout.start, f.layout.end);
    assert.equal(f.window._getOutputSelection(), text);
    assert.deepEqual(f.layout.hits.at(-1), [(f.layout.rows.at(-1).glyphs.length * 10 + 35) * 2 * 1024, 70 * 2 * 1024]);
    f.manager.disable();
});

test('scroll offset and resource scale do not double-shift the selected line', () => {
    const f = open({resourceScale: 2, offsets: [3, -20], scale: 1.25});
    dragPoints(f, f.window, f.label, f.layout.point(0, 1), f.layout.end);
    assert.equal(f.window._getOutputSelection(), text.slice(text.indexOf('\n') + 1));
    f.manager.disable();
});

test('native frame fallback outside the text uses the same scaled mapping as motion events', () => {
    const f = open({resourceScale: 2});
    dragPoints(f, f.window, f.label, f.layout.start, f.layout.end, {outsideRelease: true});
    assert.equal(f.window._getOutputSelection(), text);
    assert.equal(f.window._selectionLoop, null); f.manager.disable();
});

test('render-scale change during a live selection is read dynamically rather than cached from press', () => {
    const f = open({resourceScale: 1});
    f.pointer([...f.layout.start, 256]);
    f.window._resultContainer.emit('captured-event', pointerEvent(f, f.layout.actor, f.layout.start));
    f.layout.actor._hitResourceScale = 2;
    f.pointer([...f.layout.end, 256]);
    f.layout.actor.emit('motion-event', pointerEvent(f, f.layout.actor, f.layout.end));
    assert.equal(f.window._getOutputSelection(), text); f.manager.disable();
});

test('ASCII keeps its proven native coordinate path even when the backing render scale is 2', () => {
    const value = 'first line\nsecond line\nthird line\nfinal Western line';
    const f = open({resourceScale: 2}, 'translate', value);
    dragPoints(f, f.window, f.label, f.layout.start, f.layout.end);
    assert.equal(f.window._getOutputSelection(), value); assert.equal(f.layout.hits.length, 0);
    f.manager.disable();
});

test('metadata diagnostics record scale once per window/change, never pointer motion or selected text', () => {
    const f = open({resourceScale: 2}), state = f.window._ensureSelectionState(f.label);
    for (let count = 0; count < 20; count++)
        f.window._outputPositionAt(state, ...f.layout.point(15, 2));
    assert.deepEqual(f.logs.filter(line => line.includes('selection resource-scale')), ['[PopupLLM] selection resource-scale=2']);
    f.layout.actor._hitResourceScale = 1;
    f.window._outputPositionAt(state, ...f.layout.point(15, 2));
    assert.equal(f.logs.filter(line => line.includes('selection resource-scale')).length, 2);
    assert.doesNotMatch(f.logs.join('\n'), /第一行|第二行|最后一行/); f.manager.disable();
});
