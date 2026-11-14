// Contract regression: real button events have no get_source() actor.
// This still uses GI doubles, not a running compositor.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './extension-fixture.mjs';
import {mouseSelect, pointAt, pointerEvent} from './mouse-selection.mjs';

function open(options = {}) {
    const f = fixture(options); f.extension._closeUI();
    const window = f.createWindow('external original', 'translate');
    window._setResultText('before chosen phrase after');
    return {...f, window, label: window._resultLabel, text: window._resultLabel.get_clutter_text()};
}

for (const target of ['label', 'text']) {
    test(`stage event actor creates selection before native text can consume the press (${target})`, () => {
        const f = open(); const from = pointAt(f.text, 7), to = pointAt(f.text, 20);
        const press = pointerEvent(f, f[target], from);
        assert.equal(press.get_source(), null);
        f.pointer([...from, 256]);
        // No label/text bubble fallback: native read-only text may consume it.
        assert.equal(f.window._resultContainer.emit('captured-event', press), f.Clutter.EVENT_STOP);
        assert.ok(f.eventActorQueries.includes(press));
        f.pointer([...to, 256]); f.frames();
        f.pointer([...to, 0]); f.frames(); f.flushIdles();
        assert.equal(f.window._getOutputSelection(), 'chosen phrase');
        assert.equal(f.text.attributes.items[0].start_index, 7);
        assert.equal(f.text.attributes.items[0].end_index, 20);
        assert.equal(f.manager._popupSource.window, f.window);
    });
}

test('button capture never calls the crossing-only get_source method', () => {
    const f = open(), press = pointerEvent(f, f.text, pointAt(f.text, 7));
    press.get_source = () => {throw new Error('not valid for a button event');};
    assert.equal(f.window._resultContainer.emit('captured-event', press), f.Clutter.EVENT_STOP);
    f.window._clearOutputSelection();
});

test('popup root explicitly receives events rather than relying on a nonreactive container', () => {
    const f = open(); assert.equal(f.window._resultContainer.reactive, true);
});

test('resolve the picked actor before changing the popup stacking order', () => {
    const f = open(); let activated = false;
    const original = f.manager._activateWindow.bind(f.manager);
    f.manager._activateWindow = window => {activated = true; original(window);};
    const lookup = f.stage.get_event_actor;
    f.stage.get_event_actor = event => {assert.equal(activated, false); return lookup(event);};
    const press = pointerEvent(f, f.text, pointAt(f.text, 7));
    assert.equal(f.window._resultContainer.emit('captured-event', press), f.Clutter.EVENT_STOP);
    assert.equal(activated, true); f.window._clearOutputSelection();
});

test('GNOME 51 text cursor is assigned to both possible text pick actors only', () => {
    const f = open();
    assert.equal(f.label.cursor_type, f.Clutter.CursorType.TEXT);
    assert.equal(f.text.cursor_type, f.Clutter.CursorType.TEXT);
    assert.notEqual(f.window._resultContainer.cursor_type, f.Clutter.CursorType.TEXT);
    const header = f.window._resultContainer.children[0];
    assert.notEqual(header.children[0].cursor_type, f.Clutter.CursorType.TEXT);
});

for (const version of ['45', '46', '47', '48', '49', '50']) {
    test(`lack of actor cursor types does not break pointer selection on GNOME ${version}`, () => {
        const f = open({version}); assert.equal(f.Clutter.CursorType, undefined);
        mouseSelect(f, f.window, f.label, 7, 20);
        assert.equal(f.window._getOutputSelection(), 'chosen phrase');
        assert.equal(f.text.cursor_type, undefined);
    });
}

test('stage-resolved copy icon keeps the selected-only copy snapshot', () => {
    const f = open(); mouseSelect(f, f.window, f.label, 7, 20);
    const button = [...f.window._copyButtons][0];
    const press = pointerEvent(f, button.child, [700, 150]);
    assert.equal(f.window._resultContainer.emit('captured-event', press), f.Clutter.EVENT_PROPAGATE);
    button.emit('clicked');
    assert.equal(f.clipboardWrites.at(-1).text, 'chosen phrase');
});

test('non-text buttons and null event actors cannot start a selection or pointer loop', () => {
    const f = open(); const header = f.window._resultContainer.children[0];
    for (const target of [header.children[0], header.children.at(-1), null]) {
        const press = pointerEvent(f, target, [180, 160]);
        assert.equal(f.window._resultContainer.emit('captured-event', press), f.Clutter.EVENT_PROPAGATE);
        assert.equal(f.window._selectionState, undefined);
        assert.equal(f.window._selectionLoop, undefined);
    }
    assert.equal(f.grabCalls(), 0);
});

test('a second window uses only its own stage-resolved label and preserves the first window', () => {
    const f = open(); mouseSelect(f, f.window, f.label, 7, 20); f.tick();
    const child = f.createWindow('next input', 'polish'); child._setResultText('second selection stays separate');
    mouseSelect(f, child, child._resultLabel, 0, 6);
    assert.equal(child._getOutputSelection(), 'second');
    assert.equal(f.window._getOutputSelection(), 'chosen phrase');
    assert.equal(f.manager._windows.size, 2);
});
