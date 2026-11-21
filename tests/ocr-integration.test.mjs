import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fixture} from './extension-fixture.mjs';
import {prefsFixture} from './preferences-fixture.mjs';
import {Widget, settle} from './mocks.mjs';
import {mouseSelect} from './mouse-selection.mjs';
import {image, input, respond, microtasks, extensionSource} from './ocr-fixture.mjs';

const model = 'seriouswebby/paddleocr-vl-1.6:spotting';
const rows = ids => ids.map(id => ({id, label: id}));
const catalog = ids => ({kind: 'ollama', models: rows(ids), memoryStatus: 'supported'});
function setup(options = {}) {
    const f = fixture({ocr: true, ocrModels: [model], ...options});
    f.config.values.set('model-name-ocr', model);
    f.extension._closeUI();
    const win = f.createWindow('', 'ocr', {ocrImage: image()});
    assert.ok(win, f.logs.join('\n'));
    return {...f, win};
}

test('OCR window has pin/copy/close, preview, text and only the bottom recognize button', () => {
    const f = setup(), children = f.win._resultContainer.children;
    assert.equal(children.length, 4);
    assert.equal(children[0].children.length, 4);
    assert.match(children[0].children[0].style_class, /translator-pin-btn/);
    assert.match(children[0].children[2].style_class, /translator-copy-btn/);
    assert.match(children[0].children[3].style_class, /translator-close-btn/);
    assert.match(children[1].style_class, /ocr-preview/);
    assert.equal(children[2], f.win._resultWindow);
    assert.equal(children[3], f.win._ocrRunButton);
    assert.equal(children[3].label, '识别');
    assert.equal(f.win._resultLabel.get_text(), '');
    assert.equal(f.requests.length, 0);
    assert.equal(f.win._copyButtons.size, 1);
    assert.equal(f.win._outputLabels.has(f.win._resultLabel), true);
    assert.deepEqual(f.previewLoads[0].stream.bytes.data, f.win._ocrImage.png);
    assert.equal(f.previewLoads[0].preserve, true);
    assert.ok(children[1].children[0].height <= 220);
});

test('recognize sends original PNG and official prompt to existing local Ollama, not text Chat Completions', async () => {
    const f = setup({stream: true});
    const task = f.win._runOCR();
    await microtasks();
    assert.equal(f.requests.length, 1);
    const request = f.requests[0];
    assert.equal(request.message.url, 'http://localhost:11434/api/generate');
    assert.equal(request.message.payload.prompt, 'OCR:');
    assert.equal(request.message.payload.model, model);
    assert.equal(request.message.payload.options.temperature, 0);
    assert.equal(request.message.payload.stream, true);
    assert.equal(request.message.payload.keep_alive, 60);
    assert.equal(request.message.payload.images[0], Buffer.from(f.win._ocrImage.png).toString('base64'));
    assert.equal(request.message.flags & 8, 8);
    assert.equal(request.session.proxy_resolver.localOnly, true);
    assert.equal(f.win._ocrRunButton.reactive, false);
    assert.equal(f.win._ocrRunButton.label, '正在识别……');
    assert.deepEqual(f.begins, [model]);
    const stream = respond(f, [{response: '中文 ', done: false}, {response: 'Nederlands', done: true}]);
    await task;
    assert.equal(f.win._resultLabel.get_text(), '中文 Nederlands');
    assert.equal(f.win._ocrRunButton.label, '识别');
    assert.equal(f.win._ocrRunButton.reactive, true);
    assert.equal(stream.closed, true);
    assert.deepEqual(f.finishes, [model]);
});

test('nonstream and immediate-release settings are reused without language/think additions', async () => {
    const f = setup({stream: false});
    f.config.values.set('model-idle-time', 0);
    const task = f.win._runOCR(); await microtasks();
    const payload = f.requests[0].message.payload;
    assert.equal(payload.stream, false); assert.equal(payload.keep_alive, 0);
    assert.ok(!Object.hasOwn(payload, 'think') && !Object.hasOwn(payload, 'messages'));
    respond(f, '{"response":"原文","done":true}');
    await task;
    assert.equal(f.win._resultLabel.get_text(), '原文');
});

test('OCR uses only its own prompt and does not append text-tool prompts or language instructions', async () => {
    const f = setup();
    f.config.values.set('system-prompt-ocr', 'OCR:');
    f.config.values.set('system-prompt', 'DO NOT SEND TRANSLATION INSTRUCTIONS');
    const task = f.win._runOCR(); await microtasks();
    assert.equal(f.requests[0].message.payload.prompt, 'OCR:');
    respond(f); await task;
});

test('missing actual Paddle model does not send the screenshot or acquire a memory lease', async () => {
    const f = setup({ocrModels: ['qwen3.5:9b']});
    await f.win._runOCR();
    assert.match(f.win._resultLabel.get_text(), /模型已不在实际列表/);
    assert.equal(f.requests.length, 0); assert.deepEqual(f.begins, []);
    assert.equal(f.win._ocrRunButton.reactive, true);
});

test('model removed while Shell is running is not kept alive by a stale discovery catalog', async () => {
    const f = setup();
    f.setOcrModels([]);
    await f.win._runOCR();
    assert.equal(f.requests.length, 0);
    assert.match(f.win._resultLabel.get_text(), /尚未安装/);
});

test('multiple models are not guessed; a selected actual candidate becomes usable', async () => {
    const other = 'paddleocr-vl:latest';
    const f = setup({ocrModels: [model, other]});
    f.config.values.set('model-name-ocr', '');
    await f.win._runOCR();
    assert.equal(f.requests.length, 0);
    assert.match(f.win._resultLabel.get_text(), /尚未选择/);
    f.config.values.set('model-name-ocr', other);
    const task = f.win._runOCR(); await microtasks();
    assert.equal(f.requests[0].message.payload.model, other);
    respond(f); await task;
});

test('online text endpoint cannot receive screenshot data, even if backend probe would say Ollama', async () => {
    const f = setup();
    f.config.values.set('api-url', 'https://online.example/v1/chat/completions');
    await f.win._runOCR();
    assert.equal(f.requests.length, 0);
    assert.match(f.win._resultLabel.get_text(), /本机 Ollama/);
});

test('unconfirmed/non-Ollama backend does not receive screenshot data', async () => {
    const f = setup({kind: 'generic'});
    await f.win._runOCR();
    assert.equal(f.requests.length, 0);
    assert.match(f.win._resultLabel.get_text(), /Ollama/);
});

test('double recognize cannot queue duplicate model jobs', async () => {
    const f = setup();
    const task = f.win._runOCR();
    await f.win._runOCR(); await microtasks();
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.begins, [model]);
    respond(f); await task;
});

test('closing during model discovery acquires no late memory lease and creates no network request', async () => {
    const f = setup();
    let done; f.manager._modelBackend.discover = () => new Promise(resolve => {done = resolve;});
    const task = f.win._runOCR();
    f.win._closeUI(); done({kind: 'ollama'}); await task;
    assert.equal(f.requests.length, 0); assert.deepEqual(f.begins, []);
});

test('closing during inference cancels only this request, balances memory once and ignores late data', async () => {
    const f = setup();
    const other = f.createWindow('other text');
    const task = f.win._runOCR(); await microtasks();
    const request = f.requests[0], label = f.win._resultLabel;
    f.win._closeUI();
    assert.equal(request.cancellable.is_cancelled(), true);
    assert.deepEqual(f.finishes, [model]);
    respond(f); await task;
    assert.equal(label.get_text(), '');
    assert.equal(other._closed, false);
    assert.equal(f.win._ocrImage, null);
    assert.deepEqual(f.finishes, [model]);
});

for (const [body, expected] of [
    ['{"error":"model error","done":true}\n', /拒绝/],
    ['{"response":"partial","done":false}\n', /中断/],
    ['{"response":"","done":true}', /未识别到文字/],
    ['bad json\n', /无效/],
]) {
    test(`recognition completion/error restores the button: ${expected}`, async () => {
        const f = setup(); const task = f.win._runOCR(); await microtasks();
        respond(f, body); await task;
        assert.match(f.win._resultLabel.get_text(), expected);
        assert.equal(f.win._ocrRunButton.label, '识别');
        assert.equal(f.win._ocrRunButton.reactive, true);
        assert.deepEqual(f.finishes, [model]);
    });
}

test('HTTP error is shown without echoing server body or image bytes', async () => {
    const f = setup(); const task = f.win._runOCR(); await microtasks();
    f.requests[0].message.status_code = 500;
    respond(f, 'sensitive server body'); await task;
    assert.match(f.win._resultLabel.get_text(), /HTTP 500/);
    assert.doesNotMatch(f.win._resultLabel.get_text(), /sensitive/);
    assert.deepEqual(f.finishes, [model]);
});

test('two OCR windows have independent HTTP clients, images and result labels', async () => {
    const f = setup();
    const second = f.createWindow('', 'ocr', {ocrImage: image()});
    const a = f.win._runOCR(), b = second._runOCR(); await microtasks();
    assert.equal(f.requests.length, 2);
    assert.notEqual(f.requests[0].session, f.requests[1].session);
    respond(f, [{response: 'A', done: true}], 0); await a;
    respond(f, [{response: 'B', done: true}], 1); await b;
    assert.equal(f.win._resultLabel.get_text(), 'A');
    assert.equal(second._resultLabel.get_text(), 'B');
    assert.deepEqual(f.finishes, [model, model]);
});

test('OCR result reuses stable selection/top-copy/second-round processing without modifying those implementations', () => {
    const f = setup();
    f.win._setResultText('start 需要润色的片段 end');
    mouseSelect(f, f.win, f.win._resultLabel, 6, 13);
    const selected = f.win._getOutputSelection();
    assert.equal(selected, '需要润色的片段');
    assert.ok(f.manager._popupContainer);
    f.win._resultContainer.children[0].children[2].emit('clicked');
    assert.equal(f.clipboardWrites.at(-1).text, selected);
    f.manager._showPopupIcon(selected, {window: f.win});
    f.manager._popupContainer.children[2].emit('clicked'); f.flushIdles();
    assert.notEqual(f.manager._activeWindow, f.win);
    assert.equal(f.win._closed, false);
});

test('OCR feature settings contain model + prompt + switch and appear before custom', async () => {
    const f = prefsFixture({result: catalog([model])}); await settle();
    const features = f.byTitle('功能与模型 (Features & Models)');
    const at = features.children.findIndex(item => item.title === '启用“文字识别” (Enable OCR)');
    assert.equal(at, 5);
    assert.equal(features.children[at + 1].title, '启用“自定义功能” (Enable Custom Tool)');
    assert.equal(features.children[at].show_enable_switch, true);
    const prompts = features.children[at].children.filter(child => child.title);
    assert.deepEqual(prompts.map(child => child.title), ['模型名称 (Model)', '系统提示词 (System Prompt)']);
    assert.equal(prompts[1].text, 'OCR:');
    assert.equal(f.models().length, 6, 'original model selectors are not refactored');
    assert.equal(f.allModels().length, 7);
    assert.equal(f.config.get_string('model-name-ocr'), '');
    assert.equal(f.byTitle('OCR 模型 (OCR Model)'), undefined);
    f.ocrModel().set_selected(1);
    assert.equal(f.config.get_string('model-name-ocr'), model);
});

test('all actual model names, including future non-Paddle models, are selectable only inside the OCR feature', async () => {
    const second = 'future-ocr:latest';
    const f = prefsFixture({result: catalog([model, second, 'qwen3.5:9b'])}); await settle();
    const selector = f.ocrModel();
    assert.equal(selector.get_parent(), f.byTitle('启用“文字识别” (Enable OCR)'));
    assert.equal(f.byTitle('OCR 模型 (OCR Model)'), undefined);
    assert.deepEqual(Array.from(selector.model), ['请选择模型', model, second, 'qwen3.5:9b']);
    assert.equal(f.config.get_string('model-name-ocr'), '');
    selector.set_selected(2);
    assert.equal(f.config.get_string('model-name-ocr'), second);
});

test('failed/loading OCR model discovery preserves a saved choice while confirmed removal clears it', async () => {
    const f = prefsFixture({values: {'model-name-ocr': model}, result: catalog([model])}); await settle();
    f.setResult(new Error('offline')); f.refresh(); await settle();
    assert.equal(f.config.get_string('model-name-ocr'), model);
    assert.equal(f.ocrModel().sensitive, false);
    assert.deepEqual(Array.from(f.ocrModel().model), ['无法获取模型列表']);
    f.setResult(catalog([])); f.refresh(); await settle();
    assert.equal(f.config.get_string('model-name-ocr'), '');
});

test('no OCR entry is added to the top panel/status menu', () => {
    const f = fixture({ocr: true}); f.manager.enable();
    assert.deepEqual(f.manager._indicator.menu.children.map(child => child.text), ['打开设置 (Settings)']);
    f.manager.disable();
});

test('selection/frame-clock/copy stays byte-identical except the targeted multibyte hit-test method', () => {
    const sha = value => createHash('sha256').update(value).digest('hex');
    const source = extensionSource('resultWindow.js');
    const section = (a, b) => source.slice(source.indexOf(a), source.indexOf(b));
    // 2.2.3 intentionally fixes _outputPositionAt. Every other selection
    // method remains byte-identical to the 2.1.4 / 2.2.2 stable baseline.
    assert.equal(sha(section('    _makeOutputSelectable(label)', '    _outputPositionAt(state') +
        section('    _updateOutputSelection(state', '    _scheduleCopyReset(button)')),
        '82ca068690502891c90c23be48da1c127491eb8456e0b8a95ac52bdaff9c34a1');
    assert.equal(sha(section('            let copyAction = button => {', '            copyButton.connect(')),
        'db9fecf8d748441a5e65d6fbb095051d8bf757637165e716f9b8097950ed0899');
    assert.equal(sha(extensionSource('textSelection.js')), '4e08b4cb782cb714e11ea4243a4e5c237166f3139b1e8f6570d6caccdc1d5e3b');
    assert.equal(sha(extensionSource('frameLoop.js')), '9e8b0765643ea6de366e6ea7bed45a6fd503596a2223a5674ca50636c98d5e01');
});

test('Shell OCR buttons use Clutter reactive rather than nonexistent GTK set_sensitive()', () => {
    const source = extensionSource('resultWindow.js');
    const method = source.slice(source.indexOf('    async _runOCR()'), source.indexOf('    _startIncrementalRead('));
    assert.doesNotMatch(method, /set_sensitive/);
});

test('2.2.3 selection fix keeps the user-accepted 2.2.2 capture, OCR transport/decoder and preview byte-identical', () => {
    const expected = {
        'nativeScreenshot.js': '40547673d28404dc1cffa321e5619bbcbd981bc67a9f0d4c9f7a6f80624b45f9',
        'ocrUtils.js': 'e61c4b51f81280efd5ae5b2808facab7114670f216b33e8f935de745599168e2',
        'ocrClient.js': '7756dc31a6156a63f9baf1bb40b5bb6ad3710a214ab875e5d0f1a2d4d7ab6ce6',
        'ocrPreview.js': 'dc19135fa8c26d487428c8dae318365fafe8988500bc3e13ace4b11b3b436dcf',
    };
    for (const [name, digest] of Object.entries(expected))
        assert.equal(createHash('sha256').update(extensionSource(name)).digest('hex'), digest, name);
});
