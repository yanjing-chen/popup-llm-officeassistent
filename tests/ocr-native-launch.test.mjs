// Regressions for 2.2.0's unnecessary launch prerequisites. These are not a
// substitute for running the native overlay on the user's GNOME 51 machine.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './extension-fixture.mjs';
import {microtasks} from './ocr-fixture.mjs';
import {prefsFixture} from './preferences-fixture.mjs';

test('native launch must not require an exported Screenshot.UIMode enum', async () => {
    const f = fixture({ocr: true, screenshotExports: {}});
    const task = f.manager._startOCRCapture();
    f.flushIdles(); await microtasks();
    assert.equal(f.screenshotUI.opens, 1);
    f.manager._cancelOCRCapture(); await task;
});

test('camera click must open native UI without an after-paint signal arriving', async () => {
    const f = fixture({ocr: true});
    const task = f.manager._startOCRCapture();
    // Deliberately never emit after-paint. Opening must still be dispatched.
    f.flushIdles(); await microtasks();
    assert.equal(f.screenshotUI.opens, 1);
    f.manager._cancelOCRCapture(); await task;
});

test('camera startup is independent of OCR model selection and backend availability', async () => {
    const f = fixture({ocr: true, ocrModels: [], kind: 'generic', screenshotExports: {}});
    f.manager._modelBackend.discover = async () => {throw new Error('backend offline');};
    const task = f.manager._startOCRCapture();
    f.flushIdles(); await microtasks();
    assert.equal(f.screenshotUI.opens, 1);
    assert.equal(f.requests.length, 0);
    f.manager._cancelOCRCapture(); await task;
});

test('OCR has its own always-present model selector inside the feature, like other tools', async () => {
    const f = prefsFixture({result: {kind: 'ollama', models: [
        {id: 'paddleocr-vl:latest', label: 'paddleocr-vl:latest'},
        {id: 'new-vision-ocr:latest', label: 'new-vision-ocr:latest'},
    ], memoryStatus: 'supported'}});
    await microtasks();
    const row = f.byTitle('启用“文字识别” (Enable OCR)');
    const model = row.children.find(child => child.title === '模型名称 (Model)');
    assert.ok(model);
    assert.ok(model.model.includes('new-vision-ocr:latest'));
    assert.equal(f.byTitle('OCR 模型 (OCR Model)'), undefined);
});

test('native open exception records an explicit phase/code and cleans the task', async () => {
    const f = fixture({ocr: true, screenshotExports: {}});
    f.screenshotUI.open = async () => {throw new Error('native test failure');};
    const task = f.manager._startOCRCapture();
    f.flushIdles(); await task;
    assert.ok(f.logs.some(line => line.includes('phase=open code=OPEN_FAILED')));
    assert.ok(f.alerts[0][1].includes('[OPEN_FAILED]'));
    assert.equal(f.manager._ocrCapture, null);
    assert.equal(f.screenshotUI.signals.size, 0);
    assert.equal(f.sources.size, 0);
});

test('native open timeout is bounded but never imposes a selection-time limit once opened', async () => {
    const f = fixture({ocr: true});
    let resolveOpen;
    f.screenshotUI.open = () => new Promise(resolve => {resolveOpen = resolve;});
    const task = f.manager._startOCRCapture();
    f.flushIdles();
    assert.equal([...f.sources.values()].some(source => source.ms === 10000), true);
    f.runTimeouts(); await task;
    assert.ok(f.alerts[0][1].includes('[OPEN_TIMEOUT]'));
    assert.equal(f.manager._ocrCapture, null);
    resolveOpen(false); await microtasks();
    assert.equal(f.sources.size, 0);
});

test('normal native UI may remain open for the user without a watchdog cancelling selection', async () => {
    const f = fixture({ocr: true});
    const task = f.manager._startOCRCapture(); f.flushIdles(); await microtasks();
    f.advance(300000); f.runTimeouts();
    assert.equal(f.screenshotUI.visible, true);
    assert.equal(f.alerts.length, 0);
    f.manager._cancelOCRCapture(); await task;
});

test('signal incompatibility is reported rather than masquerading as an unsupported GNOME version', async () => {
    const f = fixture({ocr: true, screenshotExports: {}});
    f.screenshotUI.connect = () => {throw new Error('unsupported native signal');};
    await f.manager._startOCRCapture();
    assert.ok(f.alerts[0][1].includes('[CONNECT_FAILED]'));
    assert.equal(f.screenshotUI.opens, undefined);
    assert.equal(f.manager._ocrCapture, null);
});

test('an exception while hiding a later window restores every window already hidden', async () => {
    const f = fixture({ocr: true}); f.extension._closeUI();
    const first = f.createWindow('first'), second = f.createWindow('second');
    first._resultContainer.visible = true;
    Object.defineProperty(second._resultContainer, 'visible', {get: () => true,
        set: value => {if (value === false) throw new Error('hide failure');}});
    await f.manager._startOCRCapture();
    assert.equal(first._resultContainer.visible, true);
    assert.equal(f.manager._ocrCapture, null);
    assert.ok(f.alerts[0][1].includes('[HIDE_FAILED]'));
});

test('missing native UI is reported distinctly from a missing optional enum', async () => {
    const f = fixture({ocr: true, screenshotExports: {}});
    f.main.screenshotUI = null;
    await f.manager._startOCRCapture();
    assert.ok(f.alerts[0][1].includes('[NO_NATIVE_UI]'));
    assert.equal(f.manager._ocrCapture, null);
});

test('missing native open method reports a specific API error', async () => {
    const f = fixture({ocr: true});
    f.screenshotUI.open = undefined;
    await f.manager._startOCRCapture();
    assert.ok(f.alerts[0][1].includes('[NO_NATIVE_OPEN]'));
    assert.equal(f.manager._ocrCapture, null);
});
