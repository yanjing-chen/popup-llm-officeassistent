// Tests controller isolation and native-event wiring using explicit GI doubles.
// Real GNOME selection/drag rendering still requires desktop acceptance.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './extension-fixture.mjs';
import {settle} from './mocks.mjs';
import {mouseSelect, pointAt, pointerEvent} from './mouse-selection.mjs';
import {IdleModels} from '../popup-llm-officeassistent@yanjing_chen@qq.com/idleModels.js';

const chunk = text => 'data: ' + JSON.stringify({choices: [{delta: {content: text}}]});

function open(options = {}) {
    const f = fixture(options); f.extension._closeUI();
    const parent = f.createWindow('ORIGINAL SOURCE MUST NOT LEAK', 'translate');
    const label = parent._resultLabel, text = label.get_clutter_text();
    parent._setResultText('before chosen phrase after');
    const select = (start = 7, end = 20) => mouseSelect(f, parent, label, start, end);
    return {...f, parent, label, text, select};
}

test('output is selectable and read-only with an explicit visible highlight', () => {
    const f = open();
    assert.equal(f.text.reactive, true); assert.equal(f.text.selectable, true);
    assert.equal(f.text.editable, false); assert.equal(f.text.cursor_visible, false);
    assert.equal(f.label.can_focus, true);
    assert.equal(f.text.selection_color.blue, 228);
});

test('selection does not open the toolbar until the primary button is released', () => {
    const f = open(); const from = pointAt(f.text, 7), to = pointAt(f.text, 20);
    f.pointer([...from, 256]); f.text.emit('button-press-event', pointerEvent(f, f.text, from));
    f.pointer([...to, 256]); f.frames(); f.flushIdles();
    assert.equal(f.manager._popupContainer, undefined);
    f.pointer([...to, 0]); f.frames(); f.flushIdles();
    assert.equal(f.manager._popupContainer.children.length, 6);
    assert.equal(f.parent._getOutputSelection(), 'chosen phrase');
    assert.equal(f.parent._closed, false); assert.equal(f.manager._windows.size, 1);
});

for (const [index, action] of ['translate', 'explain', 'polish', 'mail', 'qa', 'custom'].entries()) {
    test(`selection toolbar ${action} opens an independent child and retains the parent`, async () => {
        const f = open(); f.select();
        f.manager._popupContainer.children[index].emit('clicked'); f.flushIdles();
        const child = f.manager._activeWindow;
        assert.notEqual(child, f.parent); assert.equal(f.manager._windows.size, 2);
        assert.equal(f.parent._closed, false); assert.equal(f.label.text, 'before chosen phrase after');
        assert.equal(child._translateStyleState === f.parent._translateStyleState, false);
        // Use the same immutable selection snapshot that each toolbar button captures.
        if (action === 'qa') {
            child._qaEntry.set_text('question'); child._qaEntry.get_clutter_text().emit('activate');
            await settle();
        } else {
            const buttons = [];
            const walk = actor => {if (actor.style_class === 'translator-action-btn' || actor.style_class === 'mail-send-btn') buttons.push(actor); for (const kid of actor.children) walk(kid);};
            walk(child._resultContainer);
            buttons.at(-1).emit('clicked'); await settle();
        }
        assert.equal(f.requests.length, 1);
        const payload = JSON.stringify(f.requests[0].message.payload);
        assert.ok(payload.includes('chosen phrase'));
        assert.ok(!payload.includes('ORIGINAL SOURCE MUST NOT LEAK'));
        assert.ok(!payload.includes('before chosen phrase after'));
    });
}

test('a child result can itself be selected to open another result', () => {
    const f = open(); f.select(); f.manager._popupContainer.children[2].emit('clicked'); f.flushIdles();
    const child = f.manager._activeWindow; child._setResultText('second generation');
    mouseSelect(f, child, child._resultLabel, 0, 6);
    f.manager._popupContainer.children[1].emit('clicked'); f.flushIdles();
    assert.equal(f.manager._windows.size, 3);
    assert.equal(f.parent._closed, false); assert.equal(child._closed, false);
    assert.notEqual(f.manager._activeWindow, child);
});

test('stream reception and completion continue while visible text/scroll are selection-frozen', async () => {
    const f = open({stream: true}); await f.parent._callLLMAPI('source', 'translate');
    f.select(); const before = f.label.text;
    const input = {lines: [chunk('complete '), chunk('answer'), 'data: [DONE]']};
    f.requests[0].callback(f.requests[0].session, input); await settle();
    assert.equal(f.label.text, before); assert.equal(f.parent._rawResponseText, 'complete answer');
    assert.deepEqual(f.finishes, ['old-model']); assert.equal(input.closed, true);
    f.manager._closePopupIcon();
    assert.equal(f.label.text, 'complete answer'); assert.equal(f.parent._selectionState, null);
});

test('toolbar timeout preserves the selection for later copying without destroying any result', () => {
    const f = open(); f.select(); f.parent._setResultText('latest frozen answer');
    const timeout = [...f.sources.values()].find(source => source.type === 'timeout');
    assert.ok(timeout); timeout.callback();
    assert.equal(f.label.text, 'before chosen phrase after'); assert.equal(f.parent._getOutputSelection(), 'chosen phrase');
    f.parent._clearOutputSelection();
    assert.equal(f.label.text, 'latest frozen answer'); assert.equal(f.parent._closed, false);
    assert.equal(f.manager._windows.size, 1); assert.equal(f.manager._popupContainer, null);
});

test('empty selection does not open any toolbar or keep the stream paused', () => {
    const f = open(); f.select(7, 7);
    assert.equal(f.parent._selectionState, null); assert.equal(f.manager._popupContainer, undefined);
    assert.equal(f.sources.size, 0);
});

test('Unicode selection snapshots include whole characters and never touch PRIMARY', () => {
    const f = open(); f.parent._setResultText('甲😀乙荷兰语丙'); f.select(1, 6);
    assert.equal(f.parent._getOutputSelection(), '😀乙荷兰语');
    assert.deepEqual(f.clipboardWrites, []);
});

test('Ctrl+C copies only the selected substring; Ctrl+A selects the current output', () => {
    const f = open(); f.select();
    const key = value => ({get_key_symbol: () => value, get_state: () => 4});
    assert.equal(f.text.emit('key-press-event', key(99)), 1);
    assert.deepEqual(f.clipboardWrites, [{type: 1, text: 'chosen phrase'}]);
    assert.equal(f.text.emit('key-press-event', key(97)), 1); f.flushIdles();
    assert.equal(f.parent._getOutputSelection(), 'before chosen phrase after');
});

test('shortcut mode selects internally without depending on the system PRIMARY value', () => {
    const f = open(); f.config.values.set('popup-mode', 'shortcut');
    let shortcut;
    f.main.wm.addKeybinding = (_name, _settings, _flags, _modes, callback) => {shortcut = callback;};
    f.manager._updatePopupMode(); f.select();
    assert.ok(!f.manager._popupContainer);
    shortcut();
    assert.equal(f.manager._popupContainer.children.length, 6);
});

test('Escape dismisses a selection toolbar first and then only the active result', () => {
    const f = open(); const other = f.createWindow('second source', 'polish');
    f.select();
    assert.equal(f.manager._handleEscape(), true); assert.equal(f.parent._closed, false);
    f.manager._activateWindow(other); f.manager._handleEscape();
    assert.equal(other._closed, true); assert.equal(f.parent._closed, false);
});

test('closing either window cannot abort or overwrite the other window request', async () => {
    const f = open(); const child = f.createWindow('second', 'translate');
    await f.parent._callLLMAPI('first', 'translate'); await child._callLLMAPI('second', 'translate');
    assert.notEqual(f.requests[0].session, f.requests[1].session);
    f.parent._closeUI();
    assert.equal(f.requests[0].cancellable.cancelled, true);
    assert.ok(!f.requests[1].cancellable.cancelled); assert.equal(f.requests[1].session.aborted, undefined);
    f.reply(0, 'stale parent answer'); f.reply(1, 'live child answer');
    assert.equal(child._resultLabel.text, 'live child answer');
    assert.deepEqual(f.finishes, ['old-model', 'old-model']);
    assert.equal(f.manager._windows.size, 1);
});

test('two simultaneous QA windows keep separate conversation history and copy state', async () => {
    const f = open(); const a = f.createWindow('A background', 'qa'), b = f.createWindow('B background', 'qa');
    a._qaEntry.set_text('A question'); a._qaEntry.get_clutter_text().emit('activate');
    b._qaEntry.set_text('B question'); b._qaEntry.get_clutter_text().emit('activate');
    await settle();
    f.reply(1, 'B answer'); f.reply(0, 'A answer');
    assert.equal(a._lastLLMResponse, 'A answer'); assert.equal(b._lastLLMResponse, 'B answer');
    assert.equal(a._qaHistory.at(-1).content, 'A answer'); assert.equal(b._qaHistory.at(-1).content, 'B answer');
    assert.ok(!JSON.stringify(a._qaHistory).includes('B answer'));
});

test('shared model idle tracking waits until all result windows finish', async () => {
    const f = open(); const child = f.createWindow('second', 'polish');
    let id = 0; const timers = new Map(), unloaded = [];
    f.manager._idleModels = new IdleModels({now: () => 0,
        schedule: (_ms, callback) => {timers.set(++id, callback); return id;}, cancel: key => timers.delete(key),
        unload: async model => unloaded.push(model)});
    f.manager._idleModels.setSeconds(0);
    await f.parent._callLLMAPI('a', 'translate'); await child._callLLMAPI('b', 'polish');
    f.reply(0); for (const callback of timers.values()) callback(); await settle();
    assert.deepEqual(unloaded, []);
    f.reply(1); for (const callback of [...timers.values()]) callback(); await settle();
    assert.deepEqual(unloaded, ['old-model']);
});

test('disabling clears all selection/drag clocks, toolbars, requests and window registry', async () => {
    const f = open(); f.select(); const child = f.createWindow('second', 'polish');
    await child._callLLMAPI('second', 'polish');
    f.manager.disable();
    assert.equal(f.parent._closed, true); assert.equal(child._closed, true);
    assert.equal(f.manager._windows.size, 0); assert.equal(f.sources.size, 0);
    assert.equal(f.requests[0].cancellable.cancelled, true);
});

test('manager lifecycle disconnects global observers and stops gestures on lock/overview', () => {
    const f = fixture(); f.extension._closeUI(); f.manager.enable();
    const window = f.createWindow('source', 'translate');
    const handle = window._resultContainer.children[0].children[0];
    handle.emit('button-press-event', {get_button: () => 1, get_coords: () => [120, 180]});
    assert.equal(f.timelines.at(-1).running, true);
    f.main.sessionMode.isLocked = true; f.main.sessionMode.emit('updated');
    assert.equal(window._dragState, null); assert.equal(f.sources.size, 0);
    f.manager.disable();
    assert.equal(f.stage.signals.size, 0); assert.equal(f.selection.signals.size, 0);
    assert.equal(f.main.overview.signals.size, 0); assert.equal(f.main.sessionMode.signals.size, 0);
});

test('changing API settings cancels all active windows without closing their contents', async () => {
    const f = open(); const child = f.createWindow('second', 'polish');
    await f.parent._callLLMAPI('a', 'translate'); await child._callLLMAPI('b', 'polish');
    f.manager._resetModelBackend();
    assert.ok(f.requests.every(request => request.cancellable.cancelled));
    assert.equal(f.parent._closed, false); assert.equal(child._closed, false);
});

test('native frame tracking applies more than sixty pointer samples per second when frames arrive', () => {
    const f = open(); const actor = f.parent._resultContainer;
    const handle = actor.children[0].children[0]; const start = {x: actor.x, y: actor.y};
    f.pointer([start.x + 12, start.y + 12, 256]); handle.emit('button-press-event', {
        get_button: () => 1, get_coords: () => [start.x + 12, start.y + 12]});
    let writes = 0; const translation = actor.set_translation.bind(actor);
    actor.set_translation = (...args) => {writes++; translation(...args);};
    // 24 frames in a 100 ms interval emulate 240 Hz; no 16 ms gate discards them.
    for (let i = 1; i <= 24; i++) {
        f.advance(100 / 24); f.pointer([start.x + 12 + i, start.y + 12, 256]); f.frames();
    }
    assert.equal(writes, 24); assert.equal(f.damages.length, 0);
    assert.ok([...f.sources.values()].every(source => source.type === 'frame'));
    assert.equal(f.timelines.at(-1).actor, actor);
    f.parent._endPopupDrag(); assert.equal(f.timelines.at(-1).actor, null);
});

test('native frame setup failure retains the known-working drag fallback and cleans up', () => {
    const f = open({nativeFrames: false}); const actor = f.parent._resultContainer;
    actor.children[0].children[0].emit('button-press-event', {
        get_button: () => 1, get_coords: () => [actor.x + 12, actor.y + 12]});
    assert.equal([...f.sources.values()][0].ms, 16);
    f.pointer([600, 400, 256]); f.tick(); assert.notEqual(actor.translation_x, 0);
    f.parent._closeUI(); assert.equal(f.sources.size, 0);
});

test('closing with a pending selection-release idle cannot show a stale toolbar later', () => {
    const f = open(); mouseSelect(f, f.parent, f.label, 0, 4, {flush: false});
    assert.ok(f.sources.size); f.parent._closeUI(); f.flushIdles();
    assert.equal(f.sources.size, 0); assert.equal(f.manager._windows.size, 0);
    assert.ok(!f.manager._popupContainer);
});

test('disabling with a queued toolbar action cannot create a result after disable', () => {
    const f = open(); f.select(); f.manager._popupContainer.children[2].emit('clicked');
    assert.ok(f.manager._actionIdleId); f.manager.disable(); f.flushIdles();
    assert.equal(f.manager._windows.size, 0); assert.equal(f.sources.size, 0);
});

test('a stale PRIMARY callback from a previous enable generation is ignored', () => {
    const f = fixture(); f.extension._closeUI(); f.manager.enable();
    let reply;
    f.St.Clipboard.get_default().get_text = (_type, callback) => {reply = callback;};
    f.manager._checkPrimarySelection(); f.manager.disable(); f.manager.enable();
    reply(null, 'old selection from previous enable');
    assert.ok(!f.manager._popupContainer); f.manager.disable();
});

test('changing popup mode invalidates an outstanding automatic PRIMARY read', () => {
    const f = open(); let reply;
    f.St.Clipboard.get_default().get_text = (_type, callback) => {reply = callback;};
    f.manager._checkPrimarySelection();
    f.config.values.set('enable-popup', false); f.manager._updatePopupMode();
    reply(null, 'late selection'); assert.ok(!f.manager._popupContainer);
});

test('hiding a window stops a frame loop even if its actor frame clock stops advancing', () => {
    const f = open(); const actor = f.parent._resultContainer;
    actor.children[0].children[0].emit('button-press-event', {
        get_button: () => 1, get_coords: () => [actor.x + 12, actor.y + 12]});
    assert.ok(f.timelines.at(-1).running);
    actor.visible = false; actor.emit('notify::visible');
    assert.equal(f.timelines.at(-1).running, false); assert.equal(f.sources.size, 0);
});

test('a stale toolbar button/timeout cannot create a window or dismiss a newer toolbar', () => {
    const f = open(); f.select();
    const oldButton = f.manager._popupContainer.children[2];
    const oldTimeout = [...f.sources.values()].find(source => source.type === 'timeout').callback;
    f.manager._closePopupIcon(); f.select(0, 6);
    const current = f.manager._popupContainer;
    oldButton.emit('clicked'); oldTimeout(); f.flushIdles();
    assert.equal(f.manager._popupContainer, current); assert.equal(f.manager._windows.size, 1);
});

test('all six outputs build on GNOME 45–51 with the matching layout/color branch', () => {
    for (const version of ['45', '46', '47', '48', '49', '50', '51']) {
        const f = fixture({version}); f.extension._closeUI();
        for (const action of ['translate', 'explain', 'polish', 'mail', 'qa', 'custom'])
            assert.ok(f.createWindow('source', action), version + '/' + action);
        assert.deepEqual(f.logs, []); f.manager.disable(); assert.equal(f.sources.size, 0);
    }
});

test('a remembered Shell text focus cannot block later selections in external applications', () => {
    const f = open(); f.select();
    f.clipboardValues.set(f.St.ClipboardType.PRIMARY, 'new text from another application');
    f.manager._checkPrimarySelection();
    assert.equal(f.manager._lastText, 'new text from another application');
    assert.equal(f.manager._popupSource, null);
    assert.equal(f.parent._closed, false); assert.ok(f.manager._popupContainer);
});
