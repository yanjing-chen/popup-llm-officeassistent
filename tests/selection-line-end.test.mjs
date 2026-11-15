import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './extension-fixture.mjs';
import {image, microtasks} from './ocr-fixture.mjs';
import {pangoSelection, dragPoints} from './pango-selection-fixture.mjs';

function open(value, action = 'translate', options = {}) {
    const f = fixture({ocr: action === 'ocr'}); f.extension._closeUI();
    const window = f.createWindow('source', action, action === 'ocr' ? {ocrImage: image()} : {});
    const label = window._resultLabel;
    const layout = pangoSelection(f, window, label, value, options);
    return {...f, window, label, layout};
}

for (const action of ['translate', 'ocr']) {
    test(`${action}: same-line drag past the last Chinese glyph includes it without moving down`, () => {
        const value = '中国坚定奉行互利共赢的开放战略，实现互', f = open(value, action);
        dragPoints(f, f.window, f.label, f.layout.start, f.layout.end);
        assert.equal(f.window._getOutputSelection(), value);
        const bg = f.layout.actor.attributes.items.find(item => item.kind === 'background');
        assert.equal(bg.end_index, Buffer.byteLength(value));
        f.manager.disable();
    });
}

test('wrapped Chinese final line can be selected by horizontal motion on that line', () => {
    const value = '中国坚定奉行互利共赢的开放战略，中国的政策引领与消费升级趋势，实现互', f = open(value, 'ocr', {columns: 14});
    dragPoints(f, f.window, f.label, f.layout.start, f.layout.end);
    assert.equal(f.window._getOutputSelection(), value); f.manager.disable();
});

test('reverse dragging starts after the final Chinese glyph rather than before it', () => {
    const value = '选取最后一个汉字', f = open(value);
    dragPoints(f, f.window, f.label, f.layout.end, f.layout.start);
    assert.equal(f.window._getOutputSelection(), value); f.manager.disable();
});

test('right half of the last Chinese glyph maps to the following caret boundary', () => {
    const f = open('实现互');
    dragPoints(f, f.window, f.label, f.layout.start, f.layout.point(28));
    assert.equal(f.window._getOutputSelection(), '实现互'); f.manager.disable();
});

test('mixed Western and Chinese text includes the final Chinese punctuation', () => {
    const value = 'APEC 与 Netherlands 共同发展。', f = open(value);
    dragPoints(f, f.window, f.label, f.layout.start, f.layout.end);
    assert.equal(f.window._getOutputSelection(), value); f.manager.disable();
});

test('Western ASCII line-end selection remains unchanged', () => {
    const value = 'Nederland and English.', f = open(value);
    dragPoints(f, f.window, f.label, f.layout.start, f.layout.end);
    assert.equal(f.window._getOutputSelection(), value);
    assert.equal(f.layout.hits.length, 0, 'ASCII must retain its original hit path'); f.manager.disable();
});

test('left half of a Chinese glyph does not incorrectly include the following glyph', () => {
    const f = open('实现互');
    dragPoints(f, f.window, f.label, f.layout.start, f.layout.point(22));
    assert.equal(f.window._getOutputSelection(), '实现'); f.manager.disable();
});

test('dragging to a wrapped line end does not select characters from the next line', () => {
    const value = '中文第一行接着还有第二行', f = open(value, 'translate', {columns: 5});
    dragPoints(f, f.window, f.label, f.layout.start, f.layout.point(200, 0));
    assert.equal(f.window._getOutputSelection(), Array.from(value).slice(0, 5).join(''));
    f.manager.disable();
});

test('hard newline boundary does not add a newline until the gesture reaches the next line', () => {
    const f = open('中文第一行\n下一行');
    dragPoints(f, f.window, f.label, f.layout.start, f.layout.point(200, 0));
    assert.equal(f.window._getOutputSelection(), '中文第一行'); f.manager.disable();
});

test('layout offsets and scaled stage coordinates are applied before the multibyte hit test', () => {
    const value = '中文缩放后的最后一个字', f = open(value, 'ocr', {offsets: [7, 9], scale: 1.5});
    dragPoints(f, f.window, f.label, f.layout.start, f.layout.end);
    assert.equal(f.window._getOutputSelection(), value); f.manager.disable();
});

test('scrolled layout offsets preserve the last visible line and exclude offscreen text', () => {
    const value = '隐藏的一行\n可见的下一行\n最后一个字', f = open(value, 'translate', {offsets: [0, -20], scale: 1.25});
    dragPoints(f, f.window, f.label, f.layout.point(0, 1), f.layout.end);
    assert.equal(f.window._getOutputSelection(), '可见的下一行\n最后一个字'); f.manager.disable();
});

for (const value of ['中文与 English.', '中文与 café', '末字😀', '末字👍🏽', '末字e\u0301', '末字👨‍👩‍👧‍👦']) {
    test(`multibyte trailing count respects whole graphemes: ${value}`, () => {
        const f = open(value);
        dragPoints(f, f.window, f.label, f.layout.start, f.layout.end);
        assert.equal(f.window._getOutputSelection(), value);
        assert.equal(f.layout.actor.attributes.items[0].end_index, Buffer.byteLength(value));
        f.manager.disable();
    });
}

for (const action of ['explain', 'polish', 'mail', 'custom']) {
    test(`${action}: Chinese final-character mapping uses the same corrected boundary`, () => {
        const value = '这是中文末尾汉字', f = open(value, action);
        dragPoints(f, f.window, f.label, f.layout.start, f.layout.end);
        assert.equal(f.window._getOutputSelection(), value); f.manager.disable();
    });
}

test('QA answer bubbles use the same corrected Chinese hit mapping', async () => {
    const f = fixture(); f.extension._closeUI();
    const window = f.createWindow('source', 'qa');
    window._qaEntry.set_text('question'); window._qaEntry.get_clutter_text().emit('activate');
    await microtasks(); f.reply(0, '中文末字'); await microtasks();
    const label = window._resultLabel, value = label.get_text();
    const layout = pangoSelection(f, window, label, value);
    dragPoints(f, window, label, layout.start, layout.end);
    assert.equal(window._getOutputSelection(), value); f.manager.disable();
});

test('copy and second-round processing retain the complete Chinese end glyph without an extra newline', () => {
    const value = '末尾文字也要完整选取', f = open(value, 'ocr');
    dragPoints(f, f.window, f.label, f.layout.start, f.layout.end);
    f.layout.actor.emit('key-press-event', {get_key_symbol: () => f.Clutter.KEY_c,
        get_state: () => f.Clutter.ModifierType.CONTROL_MASK});
    assert.equal(f.clipboardWrites.at(-1).text, value);
    let next;
    f.manager._showResultWindow = (text, action) => {next = {text, action};};
    f.manager._popupContainer.children[2].emit('clicked'); f.flushIdles();
    assert.deepEqual(next, {text: value, action: 'polish'}); f.manager.disable();
});

test('an outside release still finalizes the full Chinese range and stops the selection loop', () => {
    const value = '末尾汉字', f = open(value);
    dragPoints(f, f.window, f.label, f.layout.start, f.layout.end, {outsideRelease: true});
    assert.equal(f.window._getOutputSelection(), value); assert.equal(f.window._selectionLoop, null);
    f.manager.disable();
});

test('invalid native layout tuples fall back to the established binding rather than changing selection state', () => {
    const f = open('中文测试');
    f.layout.actor.get_layout = () => ({xy_to_index: () => [false, NaN, 1]});
    const state = f.window._ensureSelectionState(f.label);
    assert.equal(f.window._outputPositionAt(state, ...f.layout.point(0)), 0);
    f.layout.actor.get_layout = () => {throw new Error('layout unavailable');};
    assert.equal(f.window._outputPositionAt(state, ...f.layout.point(0)), 0); f.manager.disable();
});

test('a soft-wrap-suppressed trailing edge advances by one native grapheme, not one byte', () => {
    const f = open('第一行末字下一行', 'translate', {columns: 5});
    const native = f.layout.actor.get_layout;
    const layout = native();
    const query = layout.xy_to_index;
    layout.xy_to_index = (x, y) => {
        const hit = query(x, y); if (y < 20 * 1024 && !hit[0]) hit[2] = 0; return hit;
    };
    layout.index_to_pos = () => ({x: 40 * 1024, y: 0, width: 10 * 1024, height: 20 * 1024});
    let steps = 0;
    layout.move_cursor_visually = (_strong, index, trailing, direction) => {
        assert.equal(index, 12); assert.equal(trailing, 0); assert.equal(direction, 1);
        steps++; return [12, 1];
    };
    f.layout.actor.get_layout = () => layout;
    dragPoints(f, f.window, f.label, f.layout.start, f.layout.point(200, 0));
    assert.equal(f.window._getOutputSelection(), '第一行末字'); assert.ok(steps > 0);
    f.manager.disable();
});
