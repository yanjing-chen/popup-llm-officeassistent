import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resizeHit, resizedRect, resultFontSize, resultFontStyle} from '../popup-llm-officeassistent@yanjing_chen@qq.com/popupGeometry.js';
import {fixture} from './extension-fixture.mjs';
import {prefsFixture} from './preferences-fixture.mjs';
import {Widget, settle} from './mocks.mjs';
import {mouseSelect} from './mouse-selection.mjs';
import {rectangleImage, microtasks} from './ocr-fixture.mjs';

const area = {x: -1920, y: 32, width: 1920, height: 1048};
const original = {x: -1700, y: 200, width: 450, height: 350};
const edges = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
for (const [point, edge] of [ [[1, 1], 'nw'], [[225, 1], 'n'], [[449, 1], 'ne'],
    [[1, 175], 'w'], [[449, 175], 'e'], [[1, 349], 'sw'], [[225, 349], 's'], [[449, 349], 'se'],
    [[20, 20], null], [[-1, 0], null], [[451, 350], null] ]) {
    test(`resize hit test ${point} -> ${edge}`, () => assert.equal(resizeHit(...point, 450, 350), edge));
}
for (const edge of edges) {
    test(`resize ${edge} clamps both dimensions to work area and minimums`, () => {
        for (const delta of [-10000, -600, -1, 0, 1, 600, 10000]) {
            const rect = resizedRect(original, edge, delta, delta, area, 300, 260);
            assert.ok(rect.width >= 300 && rect.height >= 260);
            assert.ok(rect.x >= area.x + 8 && rect.y >= area.y + 8);
            assert.ok(rect.x + rect.width <= area.x + area.width - 8);
            assert.ok(rect.y + rect.height <= area.y + area.height - 8);
            if (edge.includes('w')) assert.equal(rect.x + rect.width, original.x + original.width);
            if (edge.includes('n')) assert.equal(rect.y + rect.height, original.y + original.height);
        }
    });
}
test('tiny work areas use available space without negative dimensions', () => {
    const tiny = {x: 10, y: -50, width: 160, height: 120};
    for (const edge of edges) {
        const result = resizedRect({x: 18, y: -42, width: 100, height: 80}, edge, 1000, -1000, tiny);
        assert.ok(result.width > 0 && result.width <= 144);
        assert.ok(result.height > 0 && result.height <= 104);
    }
});

function open(options) {
    const f = fixture(options);
    f.extension._showResultWindow('source', 'translate');
    const actor = f.extension._resultContainer;
    actor._hitOrigin = [actor.x, actor.y];
    actor.set_height(350);
    const event = (type, x, y) => ({type: () => type, get_button: () => 1, get_coords: () => [x, y]});
    const start = () => {
        const x = actor.x + actor.width - 1, y = actor.y + actor.height - 1;
        f.pointer([x, y, 256]);
        return actor.emit('captured-event', event(f.events.BUTTON_PRESS, x, y));
    };
    return {...f, actor, event, start};
}
test('real captured border press starts a resize, but layouts are coalesced at the frame clock', () => {
    const f = open(); const x = f.actor.x, y = f.actor.y;
    assert.equal(f.start(), 1); assert.ok(f.extension._resizeState);
    for (let i = 0; i < 500; i++)
        f.actor.emit('captured-event', f.event(f.events.MOTION, x + 500 + i / 10, y + 400));
    assert.equal(f.actor.width, 450);
    f.pointer([x + 599, y + 449, 256]); f.frames();
    assert.equal(f.actor.width, 600); assert.equal(f.actor.height, 450);
    f.pointer([x + 599, y + 449, 0]); f.frames();
    assert.equal(f.extension._resizeState, null); assert.equal(f.grabCalls(), 0);
    assert.equal(f.sources.size, 0); assert.equal(f.stage.signals.size, 0);
    f.extension._constrainResultWindow(); assert.equal(f.actor.width, 600); assert.equal(f.actor.height, 450);
});
test('manual size survives response growth, output selection and a subsequent title move', () => {
    const f = open(); f.start();
    f.pointer([f.actor.x + 699, f.actor.y + 499, 0]); f.frames();
    const size = [f.actor.width, f.actor.height];
    f.extension._setResultText('选取文字再处理。'.repeat(150));
    f.actor.emit('notify::height'); f.flushIdles();
    mouseSelect(f, f.extension, f.extension._resultLabel, 0, 4);
    assert.equal(f.extension._getOutputSelection(), '选取文字');
    f.extension._clearOutputSelection();
    const x = f.actor.x, y = f.actor.y;
    f.extension._beginPopupDrag(new Widget(), {get_button: () => 1, get_coords: () => [x + 20, y + 20]});
    f.pointer([x + 120, y + 120, 0]); f.frames();
    assert.deepEqual([f.actor.width, f.actor.height], size);
});
test('font defaults/ranges and preference spin control only update the new setting', async () => {
    assert.equal(resultFontSize(undefined), 11); assert.equal(resultFontSize(100), 32); assert.equal(resultFontSize(0), 8);
    const f = prefsFixture({values: {'result-font-size': 16}}); await settle();
    const row = f.byTitle('结果文字大小 (Result Font Size)');
    assert.equal(row.get_value(), 16); row.set_value(20);
    assert.equal(f.config.get_int('result-font-size'), 20);
    assert.deepEqual(f.config.writes.at(-1), ['result-font-size', 20]);
});
test('live result font updates leave title/buttons unchanged and selection continues working', () => {
    const f = open(); const label = f.extension._resultLabel;
    const title = f.actor.children[0].children[1].children[0]; const before = title.style;
    assert.equal(label.style, 'font-size: 11pt;'); // Must not start with a stray semicolon
    f.config.values.set('result-font-size', 22); f.config.emit('changed::result-font-size');
    assert.equal(label.style, 'font-size: 22pt;'); assert.equal(title.style, before);
    f.extension._setResultText('中文字体测试');
    mouseSelect(f, f.extension, label, 0, 6);
    assert.equal(f.extension._getOutputSelection(), '中文字体测试');
});
test('font CSS merger emits valid declarations and never duplicates or accumulates sizes', () => {
    assert.equal(resultFontStyle('', 22), 'font-size: 22pt;');
    assert.equal(resultFontStyle(null, 16), 'font-size: 16pt;');
    assert.equal(resultFontStyle('text-align: left;', 22), 'text-align: left; font-size: 22pt;');
    assert.equal(resultFontStyle('text-align: left; font-size: 13pt;', 30),
        'text-align: left; font-size: 30pt;');
    assert.equal(resultFontStyle('; color: #ffffff; ; ', 8), 'color: #ffffff; font-size: 8pt;');
    assert.equal(resultFontStyle('font-size: 18px;', 11), 'font-size: 11pt;');
});
test('live font changes 11→32→8→20 remain a single valid CSS declaration', () => {
    const f = open(), label = f.extension._resultLabel;
    for (const size of [32, 8, 20]) {
        f.config.values.set('result-font-size', size);
        f.config.emit('changed::result-font-size');
        assert.equal(label.style, `font-size: ${size}pt;`);
    }
});
test('after stage attachment the actual Clutter.Text uses theme font with chosen point size', () => {
    const f = open(), label = f.extension._resultLabel;
    const originalFont = {family: 'Example CJK Font', weight: 'bold', size: 11 * f.Pango.SCALE,
        copy() {return {...this, set_size(size) {this.size = size;}};}};
    const clutterText = label.get_clutter_text();
    const applied = [];
    label.get_stage = () => f.stage;
    label.get_theme_node = () => ({get_font: () => originalFont});
    clutterText.set_font_description = font => applied.push(font);
    f.config.values.set('result-font-size', 24);
    f.config.emit('changed::result-font-size');
    assert.equal(applied.length, 1);
    assert.equal(applied[0].size, 24 * f.Pango.SCALE);
    assert.equal(applied[0].family, 'Example CJK Font');
    assert.equal(applied[0].weight, 'bold');
    assert.equal(originalFont.size, 11 * f.Pango.SCALE);
    assert.equal(label.style, 'font-size: 24pt;');
});
test('font application must not query a theme node before widget joins the stage', () => {
    const f = open(), label = f.extension._resultLabel;
    label.get_stage = () => null;
    label.get_theme_node = () => {throw new Error('must not query theme node offstage');};
    f.config.values.set('result-font-size', 28);
    assert.doesNotThrow(() => f.config.emit('changed::result-font-size'));
    assert.equal(label.style, 'font-size: 28pt;');
});
test('font updates reach every QA message, including newly created bubbles', async () => {
    const f = fixture(); f.extension._showResultWindow('', 'qa');
    f.config.values.set('result-font-size', 18); f.config.emit('changed::result-font-size');
    f.extension._qaEntry.set_text('question'); f.extension._qaEntry.clutter_text.emit('activate'); await settle();
    for (const label of f.extension._chatContainer.children) {
        assert.match(label.style, /font-size: 18pt;$/);
        assert.doesNotMatch(label.style, /^\s*;/);
    }
    f.reply(0, 'answer'); f.extension._closeUI();
    f.config.emit('changed::result-font-size'); assert.equal(f.extension._fontSettingsId, 0);
});
for (const reason of ['close', 'destroy', 'hide', 'lock', 'overview', 'switch', 'error']) {
    test(`resize loop cleans up on ${reason} without a global grab or lingering source`, () => {
        const f = open(); f.start();
        if (reason === 'close') f.extension._closeUI();
        if (reason === 'destroy') f.actor.destroy();
        if (reason === 'hide') {f.actor.visible = false; f.actor.emit('notify::visible');}
        if (reason === 'lock') {f.main.sessionMode.isLocked = true; f.frames();}
        if (reason === 'overview') {f.main.overview.visible = true; f.frames();}
        if (reason === 'switch') f.createWindow('other', 'polish');
        if (reason === 'error') {f.actor.set_width = () => {throw new Error('destroyed');}; f.pointer([800, 700, 256]); f.frames();}
        f.flushIdles();
        assert.equal(f.extension._resizeState, null); assert.equal(f.extension._resizeLoop, null);
        assert.equal(f.sources.size, 0); assert.equal(f.grabCalls(), 0); assert.equal(f.stage.signals.size, 0);
    });
}
test('text hits near the boundary remain selection events, never resize gestures', () => {
    const f = open(), label = f.extension._resultLabel;
    label.set_text('selectable');
    const event = f.event(f.events.BUTTON_PRESS, f.actor.x + 2, f.actor.y + 20);
    f.registerEventActor(event, label.get_clutter_text());
    f.actor.emit('captured-event', event);
    assert.equal(f.extension._resizeState, null);
});

test('resizing defers visible streaming text until release but does not lose a completed paragraph', async () => {
    const f = open(); await f.extension._callLLMAPI('source', 'translate');
    const task = f.extension._activeRequest.task;
    const before = f.extension._resultLabel.text;
    f.start(); f.reply(0, '完整结果'); await task;
    assert.equal(f.extension._resultLabel.text, before);
    assert.deepEqual(f.finishes, ['old-model']);
    f.pointer([f.actor.x + 600, f.actor.y + 450, 0]); f.frames();
    assert.equal(f.extension._resultLabel.text, '完整结果');
});
test('Escape restores the previous manual rectangle without closing the result', () => {
    const f = open();
    f.extension._manualResultSize = {width: 450, height: 350};
    const original = [f.actor.x, f.actor.y, f.actor.width, f.actor.height];
    f.start(); f.pointer([f.actor.x + 650, f.actor.y + 500, 256]); f.frames();
    assert.equal(f.manager._handleEscape(f.extension), true);
    assert.deepEqual([f.actor.x, f.actor.y, f.actor.width, f.actor.height], original);
    assert.equal(f.extension._closed, false); assert.equal(f.sources.size, 0);
});
test('resize setup or final allocation failure cannot retain a frame tracker', () => {
    for (const when of ['begin', 'release']) {
        const f = open();
        if (when === 'begin') {
            f.actor.remove_transition = () => {throw new Error('unavailable');};
            f.start();
        } else {
            f.start(); f.actor.set_width = () => {throw new Error('destroyed');};
            assert.throws(() => f.actor.emit('captured-event', f.event(f.events.BUTTON_RELEASE,
                f.actor.x + 700, f.actor.y + 600)));
        }
        assert.equal(f.extension._resizeState, null); assert.equal(f.extension._resizeLoop, null);
        assert.equal(f.sources.size, 0);
    }
});
test('OCR preview narrows proportionally without another decode or any change to the source PNG', async () => {
    const f = fixture({ocr: true}), image = rectangleImage(1600, 400), original = image.png.slice();
    f.extension._closeUI();
    const window = f.createWindow('', 'ocr', {ocrImage: image});
    await microtasks();
    const preview = window._ocrPreview, texture = preview.actor.child.content;
    window._manualResultSize = {width: 310, height: 430};
    window._constrainResultWindow();
    assert.ok(preview.actor.width <= 310 - 52);
    assert.equal(preview.actor.width / preview.actor.height, 4);
    assert.equal(preview.actor.child.content, texture); assert.equal(f.previewLoads.length, 1);
    assert.deepEqual(image.png, original); assert.deepEqual(window._ocrImage.png, original);
    window._closeUI();
});
test('GNOME 45 keeps resize working even without the new per-actor cursor API', () => {
    const f = open({version: '45'}); f.start();
    f.pointer([f.actor.x + 599, f.actor.y + 449, 0]); f.tick();
    assert.equal(f.actor.width, 600); assert.equal(f.extension._resizeState, null);
});
