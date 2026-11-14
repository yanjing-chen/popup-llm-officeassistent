import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Widget, settle} from './mocks.mjs';
import {fixture} from './extension-fixture.mjs';

for (const action of ['translate', 'explain', 'polish', 'mail', 'qa', 'custom']) {
    test(`${action}: existing payload and non-stream response remain functional`, async () => {
        const f = fixture(); await f.extension._callLLMAPI('selected text', action);
        assert.equal(f.requests.length, 1);
        assert.equal(f.requests[0].message.payload.model, 'old-model');
        assert.equal(f.requests[0].message.payload.messages[0].role, 'system');
        assert.ok(!('ttl' in f.requests[0].message.payload));
        f.reply(0); assert.equal(f.extension._resultLabel.text, action === 'qa' ? '答：answer' : 'answer');
        assert.deepEqual(f.finishes, ['old-model']);
    });
}
for (const action of ['translate', 'explain', 'polish', 'mail', 'qa', 'custom']) {
    test(`${action}: result window builds with a draggable title and intact content`, () => {
        Widget.all = [];
        const f = fixture(); f.extension._showResultWindow('selected text', action);
        assert.deepEqual(f.logs, []);
        assert.ok(Widget.all.some(w => w.style_class === 'translator-drag-handle' && w.reactive));
        assert.ok(f.extension._resultContainer);
    });
}
test('new LM Studio request includes configured positive TTL', async () => {
    const f = fixture({kind: 'lmstudio'}); f.config.values.set('model-idle-time', 300);
    await f.extension._callLLMAPI('text', 'translate');
    assert.equal(f.requests[0].message.payload.ttl, 300);
});
test('generic/Runtime requests never receive unrecognized TTL or keep_alive fields', async () => {
    for (const kind of ['generic', 'runtime']) {
        const f = fixture({kind}); f.config.values.set('model-idle-time', 300);
        await f.extension._callLLMAPI('text', 'translate');
        assert.ok(!('ttl' in f.requests[0].message.payload));
        assert.ok(!('keep_alive' in f.requests[0].message.payload));
    }
});
test('closing a result cancels active inference and finishes the idle lease exactly once', async () => {
    const f = fixture(); await f.extension._callLLMAPI('text', 'translate');
    f.extension._closeUI(); assert.equal(f.requests[0].cancellable.cancelled, true);
    f.reply(0, 'late result'); assert.deepEqual(f.finishes, ['old-model']);
    assert.equal(f.extension._resultLabel, null);
});
test('a stale callback cannot overwrite a later answer', async () => {
    const f = fixture(); await f.extension._callLLMAPI('one', 'translate');
    await f.extension._callLLMAPI('two', 'translate');
    f.reply(1, 'new'); f.reply(0, 'old');
    assert.equal(f.extension._resultLabel.text, 'new');
    assert.deepEqual(f.finishes, ['old-model', 'old-model']);
});
test('streaming lease remains active until SSE DONE; QA history is preserved', async () => {
    const f = fixture({stream: true}); await f.extension._callLLMAPI('text', 'qa');
    assert.deepEqual(f.finishes, []);
    const stream = {lines: ['data: {"choices":[{"delta":{"content":"hello"}}]}', '', 'data: [DONE]'], close() { this.closed = true; }};
    f.requests[0].callback(f.requests[0].session, stream); await settle();
    assert.equal(f.extension._resultLabel.text, '答：hello');
    assert.equal(f.extension._qaHistory.at(-1).content, 'hello');
    assert.equal(f.extension._lastLLMResponse, 'hello');
    assert.deepEqual(f.finishes, ['old-model']); assert.equal(stream.closed, true);
});
test('stream without DONE finishes at EOF', async () => {
    const f = fixture({stream: true}); await f.extension._callLLMAPI('text', 'translate');
    f.requests[0].callback(f.requests[0].session, {lines: ['data: {"choices":[{"delta":{"content":"x"}}]}']});
    await settle(); assert.deepEqual(f.finishes, ['old-model']);
});
test('GNOME 45–47 use legacy layout property only', () => {
    const f = fixture({version: '47.2'}); const box = f.extension._box({orientation: 1, x_expand: true});
    assert.equal(box.vertical, true); assert.equal(box.orientation, undefined);
});
test('GNOME 48–51 never initialize removed vertical property', () => {
    const f = fixture(); const box = f.extension._box({orientation: 1});
    assert.equal(box.orientation, 1); assert.equal(box.vertical, undefined);
});
test('drag moves the original actor without an input grab and preserves new position on resize', () => {
    const f = fixture(); const actor = f.extension._resultContainer; const handle = new Widget();
    actor.set_position(100, 100);
    f.extension._beginPopupDrag(handle, {get_button: () => 1, get_coords: () => [110, 110]});
    f.pointer([600, 400, 256]); f.tick();
    assert.deepEqual(actor.get_transformed_position(), [590, 390]);
    assert.equal(actor, f.extension._resultContainer);
    f.pointer([600, 400, 0]); f.tick();
    assert.equal(f.grabCalls(), 0); assert.equal(f.stage.signals.size, 0); assert.equal(f.sources.size, 0);
    actor.height += 30; f.extension._constrainResultWindow();
    assert.equal(actor.x, 590); assert.equal(actor.y, 390);
});
test('drag crosses monitors and clamps within destination work area', () => {
    const f = fixture(); const actor = f.extension._resultContainer;
    f.extension._beginPopupDrag(new Widget(), {get_button: () => 1, get_coords: () => [110, 110]});
    f.pointer([2600, 300, 256]); f.tick();
    assert.ok(actor.get_transformed_position()[0] >= 1920);
    assert.ok(actor.get_transformed_position()[0] + actor.width <= 3200);
    f.extension._closeUI(); assert.equal(f.grabCalls(), 0); assert.equal(f.stage.signals.size, 0); assert.equal(f.sources.size, 0);
});
test('right mouse button does not begin window dragging', () => {
    const f = fixture(); assert.equal(f.extension._beginPopupDrag(new Widget(), {get_button: () => 3}), 0);
    assert.equal(f.stage.signals.size, 0);
});
