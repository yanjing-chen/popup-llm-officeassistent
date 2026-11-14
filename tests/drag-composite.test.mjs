// These are scenegraph/control-flow regressions, NOT a GPU rendering test.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './extension-fixture.mjs';
import {Widget, settle} from './mocks.mjs';

function open(options = {}) {
    Widget.all = [];
    const f = fixture(options);
    f.extension._showResultWindow('selected text', 'translate');
    const actor = f.extension._resultContainer;
    const handle = Widget.all.find(w => w.style_class === 'translator-drag-handle');
    const label = f.extension._resultLabel;
    const scrolls = [];
    const adjustment = {get_upper: () => 1000, get_page_size: () => 300,
        set_value: value => scrolls.push(value)};
    f.extension._resultWindow.get_vscroll_bar = () => ({get_adjustment: () => adjustment});
    const press = () => {
        const x = actor.x + 12, y = actor.y + 12;
        f.pointer([x, y, 256]);
        return handle.emit('button-press-event', {get_button: () => 1, get_coords: () => [x, y]});
    };
    const release = () => handle.emit('button-release-event', {
        get_button: () => 1, get_coords: () => [700, 400],
    });
    return {...f, actor, handle, label, scrolls, press, release};
}

const chunk = text => 'data: ' + JSON.stringify({choices: [{delta: {content: text}}]});

for (const original of [0, 1, 2, 4, 6]) {
    test(`whole popup uses ALWAYS during drag and restores original flags ${original}`, () => {
        const f = open(); f.actor.offscreen_redirect = original;
        assert.equal(f.press(), 1);
        assert.equal(f.actor.offscreen_redirect, 2);
        f.pointer([650, 350, 256]); f.tick();
        assert.deepEqual(f.actor.offscreenWrites, [2]);
        f.release();
        assert.equal(f.actor.offscreen_redirect, original);
        assert.deepEqual(f.actor.offscreenWrites, [2, original]);
        assert.equal(f.sources.size, 0); assert.equal(f.grabCalls(), 0);
    });
}

test('native surface method missing still permits drag without another actor or input grab', () => {
    const f = open(); f.actor.get_offscreen_redirect = undefined;
    const count = Widget.all.length;
    f.press(); f.pointer([650, 350, 256]); f.tick(); f.release();
    assert.equal(Widget.all.length, count); assert.equal(f.grabCalls(), 0);
    assert.equal(f.sources.size, 0);
});

test('native surface setup exception leaves no running gesture or source', () => {
    const f = open();
    f.actor.set_offscreen_redirect = value => {
        f.actor.offscreen_redirect = value;
        if (value === 2) throw new Error('native failure');
    };
    assert.equal(f.press(), 0);
    assert.equal(f.actor.offscreen_redirect, 0);
    assert.equal(f.extension._dragState, null); assert.equal(f.sources.size, 0);
});

test('1000 streamed chunks accumulate but do not mutate text or scroll during drag', () => {
    const f = open(); f.extension._rawResponseText = '';
    const before = f.label.text;
    let writes = 0;
    const setText = f.label.set_text.bind(f.label);
    f.label.set_text = value => { writes++; setText(value); };
    f.press();
    for (let i = 0; i < 1000; i++) f.extension._parseSingleSSELine(chunk('字'), 'translate');
    assert.equal(f.extension._rawResponseText, '字'.repeat(1000));
    assert.equal(f.label.text, before); assert.equal(writes, 0);
    assert.deepEqual(f.scrolls, []); assert.equal(f.sources.size, 1);
    f.release();
    assert.equal(writes, 1); assert.equal(f.label.text, '字'.repeat(1000));
    assert.equal(f.sources.size, 1);
    f.tick(); assert.deepEqual(f.scrolls, [700]); assert.equal(f.sources.size, 0);
});

test('visible stream resumes normally after release, including hidden think filtering', () => {
    const f = open(); f.extension._rawResponseText = '';
    f.config.values.set('enable-think', false);
    f.press(); f.extension._parseSingleSSELine(chunk('<think>hidden'), 'translate');
    f.extension._parseSingleSSELine(chunk('</think>visible'), 'translate'); f.release();
    assert.equal(f.label.text, 'visible');
    f.extension._parseSingleSSELine(chunk(' new'), 'translate');
    assert.equal(f.label.text, 'visible new'); f.tick();
});

for (const value of ['', '连接失败：服务不可用', 'final answer']) {
    test(`deferred display retains exact value ${JSON.stringify(value)}`, () => {
        const f = open(); f.press();
        f.extension._setResultText('superseded'); f.extension._setResultText(value);
        f.release(); assert.equal(f.label.text, value); f.tick();
    });
}

test('non-stream QA completion updates history and unload lease before visual thaw', async () => {
    const f = open(); await f.extension._callLLMAPI('', 'qa');
    const before = f.label.text; f.press(); f.reply(0, '完整回答');
    assert.equal(f.label.text, before);
    assert.equal(f.extension._lastLLMResponse, '完整回答');
    assert.equal(f.extension._qaHistory.at(-1).content, '完整回答');
    assert.deepEqual(f.finishes, ['old-model']);
    f.release(); assert.equal(f.label.text, '答：完整回答'); f.tick();
});

test('SSE DONE received while held still finalizes full QA history and model lease', async () => {
    const f = open({stream: true}); await f.extension._callLLMAPI('', 'qa');
    const before = f.label.text; f.press();
    const stream = {lines: [chunk('first '), chunk('second'), 'data: [DONE]']};
    f.requests[0].callback(f.requests[0].session, stream); await settle();
    assert.equal(f.label.text, before); assert.equal(stream.closed, true);
    assert.deepEqual(f.finishes, ['old-model']);
    assert.equal(f.extension._qaHistory.at(-1).content, 'first second');
    assert.equal(f.extension._lastLLMResponse, 'first second');
    f.release(); assert.equal(f.label.text, '答：first second'); f.tick();
});

test('API errors received while held are displayed on release, not lost', async () => {
    const f = open(); await f.extension._callLLMAPI('text', 'translate');
    const before = f.label.text; f.press(); f.requests[0].message.status_code = 503; f.reply(0);
    assert.equal(f.label.text, before); assert.deepEqual(f.finishes, ['old-model']);
    f.release(); assert.match(f.label.text, /HTTP Code: 503/); f.tick();
});

test('automatic scrolling is coalesced, suspended on press, and resumes once on release', () => {
    const f = open();
    for (let i = 0; i < 1000; i++) f.extension._scrollToBottom();
    assert.equal(f.sources.size, 1); const stale = [...f.sources.values()][0].callback;
    f.press(); assert.equal(f.sources.size, 1); // Only pointer tracking survives.
    for (let i = 0; i < 1000; i++) f.extension._scrollToBottom();
    f.tick(); assert.deepEqual(f.scrolls, []);
    f.release(); assert.equal(f.sources.size, 1);
    assert.equal(stale(), false); // Cannot clear the new scroll source's ID.
    assert.equal(f.sources.size, 1); assert.ok(f.extension._scrollTimeoutId);
    f.tick(); assert.deepEqual(f.scrolls, [700]); assert.equal(f.sources.size, 0);
});

for (const reason of ['close', 'destroy', 'disable']) {
    test(`deferred text, native surface and all scroll sources are discarded on ${reason}`, () => {
        const f = open(); f.extension._scrollToBottom(); f.press();
        f.extension._setResultText('never touch destroyed label');
        f.extension._scrollToBottom(); const state = f.extension._dragState;
        let writes = 0; f.label.set_text = () => { writes++; };
        if (reason === 'close') f.extension._closeUI();
        if (reason === 'destroy') f.actor.destroy();
        if (reason === 'disable') {
            f.manager.disable();
        }
        assert.equal(writes, 0); assert.equal(state.pendingText, null);
        assert.equal(f.actor.offscreen_redirect, 0);
        assert.equal(f.sources.size, 0); assert.equal(f.extension._dragState, null);
    });
}

test('external close cancels an outstanding non-drag scroll callback', () => {
    const f = open(); f.extension._scrollToBottom();
    const stale = [...f.sources.values()][0].callback; f.actor.destroy();
    assert.equal(f.sources.size, 0); assert.equal(stale(), false); assert.deepEqual(f.scrolls, []);
});

test('a replaced result label never receives text queued for an older QA bubble', () => {
    const f = open(); f.press(); f.extension._setResultText('old request');
    const newer = f.extension._resultLabel = new Widget({text: 'new bubble'});
    f.release(); assert.equal(newer.text, 'new bubble'); f.tick();
});

test('an empty QA popup with no result label can still end a drag', () => {
    const f = open(); f.extension._resultLabel = undefined;
    f.press(); assert.doesNotThrow(f.release); assert.equal(f.sources.size, 0);
});

test('layout failure on release cannot retain the native redirect flags', () => {
    const f = open(); f.press();
    f.actor.set_position = () => { throw new Error('actor disappeared'); };
    assert.doesNotThrow(f.release);
    assert.equal(f.actor.offscreen_redirect, 0); assert.equal(f.sources.size, 0);
});
