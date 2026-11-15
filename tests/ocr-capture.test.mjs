// Control-flow tests with fake Shell/GIO only, not native compositor acceptance.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './extension-fixture.mjs';
import {screenshotFile, image, openNative, microtasks} from './ocr-fixture.mjs';

function setup(options = {}) {
    const f = fixture({ocr: true, ...options});
    f.extension._closeUI();
    const first = f.createWindow('first input'); first._resultContainer.visible = true;
    const second = f.createWindow('second input', 'polish'); second._resultContainer.visible = true;
    first._setResultText('old result'); second._setResultText('other old result');
    return {...f, first, second};
}

async function complete(f, file = screenshotFile()) {
    f.screenshotUI.emit('screenshot-taken', file);
    f.screenshotUI.close();
    f.flushIdles(); // File I/O may still be pending; must not treat as cancellation.
    await microtasks(); f.flushIdles(); await microtasks();
    return file;
}

test('floating OCR button is immediately before custom and opens no result window before native capture', async () => {
    const f = setup();
    f.manager._showPopupIcon('text to expose toolbar');
    const bar = f.manager._popupContainer;
    assert.equal(bar.children.length, 7);
    assert.match(bar.children[5].style_class, /ocr-popup-icon/);
    assert.match(bar.children[6].style_class, /custom-popup-icon/);
    bar.children[5].emit('clicked');
    assert.equal(f.manager._windows.size, 2);
    assert.equal(f.first._resultContainer.visible, false);
    assert.equal(f.second._resultContainer.visible, false);
    assert.equal(f.screenshotUI.opens, undefined);
    assert.equal(f.requests.length, 0);
    await openNative(f);
    assert.equal(f.screenshotUI.opens, 1);
    assert.equal(f.screenshotUI.mode, undefined, 'native open() uses its default screenshot mode');
    assert.equal(f.manager._windows.size, 2);
    await complete(f);
    assert.equal(f.manager._windows.size, 3);
    assert.equal(f.manager._activeWindow._ocrImage.width, 1);
    assert.equal(f.first._resultContainer.visible, true);
    assert.equal(f.second._resultContainer.visible, true);
    assert.equal(f.requests.length, 0, 'recognition must still require the bottom button');
    assert.equal(f.screenshotUI.signals.size, 0);
    assert.equal(f.grabCalls(), 0);
    assert.equal(f.manager._ocrCapture, null);
});

test('Esc/cancelled native screenshot restores existing windows and creates no blank OCR popup', async () => {
    const f = setup();
    const task = f.manager._startOCRCapture();
    await openNative(f);
    assert.equal(f.manager._handleEscape(), false, 'extension must leave Esc to native UI');
    f.screenshotUI.close(); f.flushIdles(); await task;
    assert.equal(f.manager._windows.size, 2);
    assert.equal(f.first._resultLabel.get_text(), 'old result');
    assert.equal(f.first._resultContainer.visible, true);
    assert.equal(f.manager._ocrCapture, null);
    assert.deepEqual(f.alerts, []);
    assert.equal(f.screenshotUI.signals.size, 0);
});

test('a normal screenshot without an explicit OCR task is ignored', async () => {
    const f = setup();
    f.screenshotUI.emit('screenshot-taken', screenshotFile());
    f.screenshotUI.close(); f.flushIdles(); await microtasks();
    assert.equal(f.manager._windows.size, 2);
    assert.equal(f.requests.length, 0);
    assert.equal(f.screenshotUI.signals.size, 0);
});

test('successful capture waits for async file reading and for the native overlay to close', async () => {
    const f = setup(); const task = f.manager._startOCRCapture();
    await openNative(f);
    f.screenshotUI.emit('screenshot-taken', screenshotFile());
    await microtasks(); f.flushIdles();
    assert.equal(f.manager._windows.size, 2);
    assert.equal(f.first._resultContainer.visible, false);
    f.screenshotUI.close(); f.flushIdles(); await task;
    assert.equal(f.manager._windows.size, 3);
});

test('a close notification followed by screenshot success in the same dispatch is not mistaken for cancel', async () => {
    const f = setup(); f.manager._startOCRCapture(); await openNative(f);
    f.screenshotUI.close();
    f.screenshotUI.emit('screenshot-taken', screenshotFile());
    f.flushIdles(); await microtasks(); f.flushIdles(); await microtasks();
    assert.equal(f.manager._windows.size, 3);
});

test('native UI visibility must actually be false before any result popup is presented', async () => {
    const f = setup(); f.manager._startOCRCapture(); await openNative(f);
    f.screenshotUI.emit('screenshot-taken', screenshotFile()); await microtasks();
    f.screenshotUI.emit('closed'); f.flushIdles(); await microtasks();
    assert.equal(f.manager._windows.size, 2);
    f.screenshotUI.visible = false;
    f.screenshotUI.emit('notify::visible'); f.flushIdles(); await microtasks();
    assert.equal(f.manager._windows.size, 3);
});

test('double click cannot start concurrent native capture sessions', async () => {
    const f = setup();
    const task = f.manager._startOCRCapture();
    const original = f.manager._ocrCapture;
    await f.manager._startOCRCapture();
    assert.equal(f.manager._ocrCapture, original);
    await openNative(f);
    assert.equal(f.screenshotUI.opens, 1);
    await complete(f); await task;
    assert.equal(f.manager._windows.size, 3);
});

test('two completed screenshots retain independent original images and result windows', async () => {
    const f = setup();
    for (let round = 0; round < 2; round++) {
        f.manager._startOCRCapture(); await openNative(f); await complete(f);
    }
    const windows = [...f.manager._windows].filter(window => window._ocrImage);
    assert.equal(windows.length, 2);
    assert.notEqual(windows[0]._ocrImage, windows[1]._ocrImage);
    assert.notEqual(windows[0]._ocrImage.png, windows[1]._ocrImage.png);
    windows[0]._closeUI();
    assert.equal(windows[1]._closed, false);
    assert.equal(windows[0]._ocrImage, null);
});

for (const mode of ['visible', 'opening', 'recording']) {
    test(`native screenshot busy (${mode}) is not stolen or closed by OCR`, async () => {
        const f = setup();
        if (mode === 'visible') f.screenshotUI.visible = true;
        if (mode === 'opening') f.screenshotUI._openingCoroutineInProgress = true;
        if (mode === 'recording') f.screenshotUI.screencast_in_progress = true;
        await f.manager._startOCRCapture();
        assert.equal(f.screenshotUI.opens, undefined);
        assert.equal(f.alerts.length, 1);
        assert.equal(f.first._resultContainer.visible, true);
        assert.equal(f.manager._windows.size, 2);
        assert.equal(f.screenshotUI.signals.size, 0);
    });
}

test('native launch has no paint-frame prerequisite and remains cancellable', async () => {
    const f = setup(); const task = f.manager._startOCRCapture();
    f.flushIdles(); await microtasks();
    assert.equal(f.screenshotUI.opens, 1);
    f.manager._cancelOCRCapture(); await task;
    assert.equal(f.first._resultContainer.visible, true);
    assert.equal(f.alerts.length, 0);
    assert.equal(f.sources.size, 0);
    assert.equal(f.screenshotUI.signals.size, 0);
});

for (const opened of [false, 'throw']) {
    test(`failed native open (${opened}) restores old results and removes all task handlers`, async () => {
        const f = setup();
        f.screenshotUI.open = async () => {if (opened === 'throw') throw new Error('native open failed'); return false;};
        const task = f.manager._startOCRCapture(); await openNative(f); await task;
        assert.equal(f.first._resultContainer.visible, true);
        assert.equal(f.manager._windows.size, 2);
        assert.equal(f.alerts.length, 1);
        assert.equal(f.manager._ocrCapture, null);
        assert.equal(f.screenshotUI.signals.size, 0);
    });
}

for (const file of [null, screenshotFile(new Uint8Array([1, 2, 3])), screenshotFile(image().png, {native: false})]) {
    test('invalid or unavailable capture file never falls back to an old clipboard image', async () => {
        const f = setup(); f.manager._startOCRCapture(); await openNative(f);
        await complete(f, file);
        assert.equal(f.manager._windows.size, 2);
        assert.equal(f.first._resultContainer.visible, true);
        assert.equal(f.alerts.length, 1);
        assert.equal(f.requests.length, 0);
    });
}

test('cancelling during async file I/O ignores late completion and closes its stream', async () => {
    const f = setup(); f.manager._startOCRCapture(); await openNative(f);
    const file = screenshotFile(image().png, {hold: true});
    f.screenshotUI.emit('screenshot-taken', file); await microtasks();
    f.manager._cancelOCRCapture(); await microtasks();
    file.stream.pending.shift()(); await microtasks(); f.flushIdles();
    assert.equal(file.stream.closed, true);
    assert.equal(f.manager._windows.size, 2);
    assert.equal(f.first._resultContainer.visible, true);
    assert.equal(f.screenshotUI.signals.size, 0);
});

test('cancel before the native open callback leaves no after-paint or idle callbacks', async () => {
    const f = setup(); const task = f.manager._startOCRCapture();
    f.manager._cancelOCRCapture(); await task;
    f.stage.emit('after-paint'); f.flushIdles();
    assert.equal(f.screenshotUI.opens, undefined);
    assert.equal(f.first._resultContainer.visible, true);
    assert.equal(f.sources.size, 0);
});

test('disable/cancel while native open awaits its screenshot does not reopen the overlay later', async () => {
    const f = setup();
    let finishOpen;
    f.screenshotUI.open = () => {
        f.screenshotUI._openingCoroutineInProgress = true;
        return new Promise(resolve => {finishOpen = () => {
            f.screenshotUI._openingCoroutineInProgress = false;
            f.screenshotUI.visible = true; resolve(true);
        };});
    };
    const task = f.manager._startOCRCapture(); await openNative(f);
    f.manager._cancelOCRCapture(); await task;
    finishOpen(); await microtasks(); f.flushIdles();
    assert.equal(f.screenshotUI.visible, false);
    assert.equal(f.first._resultContainer.visible, true);
    assert.equal(f.manager._windows.size, 2);
    assert.equal(f.screenshotUI.signals.size, 0);
});

test('a previously hidden result stays hidden and a destroyed result is never resurrected', async () => {
    const f = setup(); f.first._resultContainer.visible = false;
    f.manager._startOCRCapture(); await openNative(f);
    f.second._closeUI();
    await complete(f);
    assert.equal(f.first._resultContainer.visible, false);
    assert.equal(f.second._resultContainer, null);
    assert.equal(f.manager._windows.size, 2);
});

test('older GNOME retains its existing six windows and reports unsupported OCR without modifying native UI', async () => {
    const f = setup({version: '48'});
    await f.manager._startOCRCapture();
    assert.equal(f.first._closed, false);
    assert.equal(f.first._resultContainer.visible, true);
    assert.equal(f.manager._windows.size, 2);
    assert.equal(f.alerts.length, 1);
    assert.match(f.alerts[0][1], /49–51/);
});

for (const reason of ['lock', 'overview', 'disable', 'monitors', 'endpoint', 'ocr-off']) {
    test(`capture is safely cancelled on ${reason} without leaving task callbacks`, async () => {
        const f = fixture({ocr: true}); f.manager.enable();
        const parent = f.createWindow('keep me'); parent._resultContainer.visible = true;
        const task = f.manager._startOCRCapture(); await openNative(f);
        if (reason === 'lock') {
            f.main.sessionMode.isLocked = true; f.main.sessionMode.emit('updated');
        } else if (reason === 'overview') {
            f.main.overview.emit('showing');
        } else if (reason === 'disable') {
            f.manager.disable();
        } else if (reason === 'monitors') {
            // The registered monitor-change callback is a Shell lifecycle hook.
            f.manager._cancelOCRCapture();
        } else if (reason === 'endpoint') {
            f.config.values.set('api-url', 'http://localhost:1234/v1/chat/completions');
            f.config.emit('changed', 'api-url');
        } else {
            f.config.values.set('enable-ocr', false); f.config.emit('changed', 'enable-ocr');
        }
        await task;
        assert.equal(f.manager._ocrCapture, null);
        assert.equal(f.screenshotUI.signals.size, 0);
        assert.equal(f.screenshotUI.visible, false);
        if (reason !== 'disable') {
            assert.equal(parent._closed, false);
            assert.equal(parent._resultContainer.visible, true);
            f.manager.disable();
        } else {
            assert.equal(parent._closed, true);
        }
    });
}
