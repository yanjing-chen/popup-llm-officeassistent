import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './extension-fixture.mjs';
import {image, rectangleImage, respond, microtasks} from './ocr-fixture.mjs';
import {OcrStream} from '../popup-llm-officeassistent@yanjing_chen@qq.com/ocrUtils.js';

const BrowserDecoder = globalThis.TextDecoder;
class GjsDecoder extends BrowserDecoder {
    decode(bytes, options = {}) {
        if (options.stream)
            throw new Error("TextDecoder does not implement the 'stream' option.");
        return super.decode(bytes);
    }
}

function coldShortcut() {
    const f = fixture({ocr: true});
    f.extension._closeUI();
    f.config.values.set('popup-mode', 'shortcut');
    let shortcut;
    f.main.wm.addKeybinding = (_name, _settings, _flags, _mode, callback) => {shortcut = callback;};
    f.manager.enable();
    return {...f, shortcut};
}

test('first shortcut after enable opens the camera toolbar without any PRIMARY owner', async () => {
    const f = coldShortcut();
    f.shortcut();
    const actor = f.manager._popupContainer;
    assert.ok(actor, 'blank PRIMARY must not require selecting a word first');
    const camera = actor.children.find(button => button.child?.icon_name === 'camera-photo-symbolic');
    assert.ok(camera && camera.reactive !== false);
    camera.emit('clicked');
    f.flushIdles(); await microtasks();
    assert.equal(f.screenshotUI.opens, 1);
    f.manager.disable();
});

test('shortcut does not wait for an absent PRIMARY callback to show the camera', () => {
    const f = coldShortcut();
    f.St.Clipboard.get_default().get_text = () => {};
    f.shortcut();
    assert.ok(f.manager._popupContainer, 'show first, fetch selection only as an optional enrichment');
    f.manager.disable();
});

for (const streaming of [true, false]) {
    test(`OCR decodes successful Ollama data with GJS-style nonstream-only TextDecoder, stream=${streaming}`, () => {
        globalThis.TextDecoder = GjsDecoder;
        try {
            const parser = new OcrStream(() => {}, streaming);
            const data = new TextEncoder().encode(JSON.stringify({response: '中文 Nederlands 😀', done: true}) + '\n');
            for (const byte of data) parser.push(new Uint8Array([byte]));
            assert.equal(parser.finish(), '中文 Nederlands 😀');
        } finally {globalThis.TextDecoder = BrowserDecoder;}
    });
}

test('successful Ollama response is not misreported as an OCR connection error by the window', async () => {
    globalThis.TextDecoder = GjsDecoder;
    const model = 'paddleocr-vl:latest';
    const f = fixture({ocr: true, stream: true, ocrModels: [model]});
    try {
        f.config.values.set('model-name-ocr', model); f.extension._closeUI();
        const win = f.createWindow('', 'ocr', {ocrImage: image()});
        const task = win._runOCR(); await microtasks();
        assert.equal(f.requests.length, 1);
        respond(f, [{response: '识别成功', done: true}]); await task;
        assert.equal(win._resultLabel.get_text(), '识别成功');
    } finally {globalThis.TextDecoder = BrowserDecoder; f.manager.disable();}
});

test('wide OCR screenshots use a non-square preview actor with original aspect ratio', () => {
    const f = fixture({ocr: true}); f.extension._closeUI();
    const win = f.createWindow('', 'ocr', {ocrImage: rectangleImage(1000, 100)});
    const preview = win._resultContainer.children[1].children[0];
    assert.ok(Math.abs(preview.width / preview.height - 10) < 0.1);
    assert.notEqual(preview.width, preview.height);
    f.manager.disable();
});

test('empty shortcut never submits an empty text request, and later selected text restores text actions', async () => {
    const f = coldShortcut(); f.shortcut();
    const toolbar = f.manager._popupContainer;
    for (const button of toolbar.children.filter(button => button.child?.icon_name !== 'camera-photo-symbolic')) {
        assert.equal(button.reactive, false); button.emit('clicked');
    }
    f.flushIdles(); await microtasks(); assert.equal(f.requests.length, 0);
    assert.equal(f.manager._popupContainer, toolbar);
    f.clipboardValues.set(f.St.ClipboardType.PRIMARY, 'new selected text'); f.shortcut();
    assert.notEqual(f.manager._popupContainer, toolbar);
    assert.equal(f.manager._popupContainer.children[0].reactive, true);
    assert.equal(f.manager._lastText, 'new selected text');
    f.manager.disable();
});

test('late PRIMARY callback cannot reopen a dismissed manual toolbar', () => {
    const f = coldShortcut(); let callback;
    f.St.Clipboard.get_default().get_text = (_type, done) => {callback = done;};
    f.shortcut(); f.manager._closePopupIcon(); callback(null, 'late text');
    assert.ok(!f.manager._popupContainer); f.manager.disable();
});

test('late PRIMARY callback cannot replace a newer shortcut toolbar', () => {
    const f = coldShortcut(), callbacks = [];
    f.St.Clipboard.get_default().get_text = (_type, done) => {callbacks.push(done);};
    f.shortcut(); f.shortcut(); const current = f.manager._popupContainer;
    callbacks[0](null, 'old text'); assert.equal(f.manager._popupContainer, current);
    callbacks[1](null, 'current text'); assert.equal(f.manager._lastText, 'current text');
    f.manager.disable();
});

test('unavailable clipboard API does not prevent shortcut camera or throw out of a keybinding', () => {
    const f = coldShortcut();
    f.St.Clipboard.get_default().get_text = () => {throw new Error('no PRIMARY owner');};
    assert.doesNotThrow(f.shortcut); assert.ok(f.manager._popupContainer);
    f.manager.disable();
});

test('auto selection mode remains quiet on an empty PRIMARY instead of spawning a blank toolbar', () => {
    const f = fixture({ocr: true}); f.manager._checkPrimarySelection();
    assert.ok(!f.manager._popupContainer); f.manager.disable();
});

test('unclassified plugin error is logged by phase and is not blamed on Ollama connectivity', async () => {
    const f = fixture({ocr: true}); f.extension._closeUI();
    f.manager._modelBackend.discover = async () => {throw new Error('secret URL /home/private');};
    const win = f.createWindow('', 'ocr', {ocrImage: image()}); await win._runOCR();
    assert.match(win._resultLabel.get_text(), /MODEL_DISCOVERY_FAILED/);
    assert.doesNotMatch(win._resultLabel.get_text(), /检查本机 Ollama|secret|private/);
    assert.match(f.logs.join('\n'), /phase=model-discovery code=MODEL_DISCOVERY_FAILED/);
    assert.doesNotMatch(f.logs.join('\n'), /secret|private/);
    f.manager.disable();
});
