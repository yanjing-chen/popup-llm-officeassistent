import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './extension-fixture.mjs';
import {Widget} from './mocks.mjs';

function open(action = 'translate') {
    Widget.all = [];
    const f = fixture();
    f.extension._showResultWindow('selected text', action);
    assert.deepEqual(f.logs, []);
    const pin = Widget.all.find(widget => widget.style_class === 'translator-pin-btn');
    const close = Widget.all.find(widget => widget.style_class === 'translator-close-btn');
    const handle = Widget.all.find(widget => widget.style_class === 'translator-drag-handle');
    assert.ok(pin && close && handle);
    return {...f, window: f.extension, actor: f.extension._resultContainer, pin, close, handle};
}

test('top-left pin is present for every text and OCR result; starts unlocked', () => {
    for (const action of ['translate', 'explain', 'polish', 'mail', 'qa', 'custom']) {
        const f = open(action);
        const header = f.actor.children[0];
        assert.equal(header.children[0], f.pin);
        assert.equal(header.children[1], f.handle);
        assert.equal(f.pin.child.icon_name, 'view-pin-symbolic');
        assert.equal(f.window._pinned, false);
        assert.equal(f.close.reactive, true);
        assert.equal(f.close.can_focus, true);
        f.window._closeUI();
    }
});

test('click pin locks close button and direct close, click again permits close', () => {
    const f = open();
    const original = f.actor;
    f.pin.emit('clicked');
    assert.equal(f.window._pinned, true);
    assert.equal(f.close.reactive, false);
    assert.equal(f.close.can_focus, false);
    assert.match(f.pin.accessible_name, /解除固定/);
    f.close.emit('clicked');
    assert.equal(f.window._closed, false);
    f.window._closeUI();
    assert.equal(f.window._resultContainer, original);
    f.pin.emit('clicked');
    assert.equal(f.window._pinned, false);
    assert.equal(f.close.reactive, true);
    assert.equal(f.close.can_focus, true);
    f.close.emit('clicked');
    assert.equal(f.window._closed, true);
    assert.equal(f.actor.destroyed, true);
});

test('pinned popup blocks title drags, pointer resize and automatic relocation', () => {
    const f = open();
    f.actor.set_position(250, 180);
    f.window._resultWorkArea = {x: 0, y: 32, width: 1920, height: 1048};
    f.pin.emit('clicked');
    const point = {x: f.actor.x, y: f.actor.y};
    assert.equal(f.window._beginPopupDrag(f.handle, {get_button: () => 1, get_coords: () => [250, 180]}), f.Clutter.EVENT_STOP);
    assert.equal(f.window._dragState, null);
    assert.equal(f.window._beginPopupResize('nw', {get_coords: () => [250, 180]}), false);
    assert.equal(f.window._resizeState, null);
    assert.equal(f.window._resizeEdgeAt(250, 180), null);
    // Content growth and workarea checks should not nudge an explicitly pinned window.
    f.actor.height = 890;
    f.window._resultPosition = {x: 1700, y: 1000};
    f.window._constrainResultWindow();
    f.window._queueResultPosition();
    f.flushIdles();
    assert.deepEqual({x: f.actor.x, y: f.actor.y}, point);
    assert.equal(f.sources.size, 0);
    f.pin.emit('clicked');
    assert.equal(f.window._beginPopupDrag(f.handle, {get_button: () => 1, get_coords: () => [260, 190]}), f.Clutter.EVENT_STOP);
    assert.ok(f.window._dragState);
    f.window._endPopupDrag();
    f.window._closeUI();
});

test('pinning finishes an active drag and stops its frame tracker', () => {
    const f = open();
    f.window._beginPopupDrag(f.handle, {get_button: () => 1, get_coords: () => [110, 110]});
    assert.ok(f.window._dragState);
    f.pointer([450, 420, 256]); f.tick();
    f.pin.emit('clicked');
    assert.equal(f.window._dragState, null);
    assert.equal(f.sources.size, 0);
    const frozen = f.actor.get_transformed_position();
    f.pointer([800, 700, 256]); f.tick();
    assert.deepEqual(f.actor.get_transformed_position(), frozen);
    f.window._closeUI({force: true});
});

test('manager Esc consumes event without closing pin; after unpin Esc closes', () => {
    const f = open();
    f.pin.emit('clicked');
    assert.equal(f.manager._handleEscape(), true);
    assert.equal(f.window._closed, false);
    f.pin.emit('clicked');
    assert.equal(f.manager._handleEscape(), true);
    assert.equal(f.window._closed, true);
});

test('pinning one result does not pin or close-protect other result windows', () => {
    const f = open();
    const next = f.createWindow('second selection', 'polish');
    f.pin.emit('clicked');
    assert.equal(f.window._pinned, true);
    assert.equal(next._pinned, false);
    next._closeUI();
    assert.equal(next._closed, true);
    assert.equal(f.window._closed, false);
    f.window._closeUI({force: true});
});

test('extension disable forcibly cleans pinned windows and releases actors', () => {
    const f = open();
    f.pin.emit('clicked');
    f.manager.disable();
    assert.equal(f.window._closed, true);
    assert.equal(f.window._resultContainer, null);
    assert.equal(f.actor.destroyed, true);
    assert.equal(f.manager._windows.size, 0);
});

test('external actor destruction cleans up pinned window without recursive destruction', () => {
    const f = open();
    f.pin.emit('clicked');
    f.actor.destroy();
    assert.equal(f.window._closed, true);
    assert.equal(f.manager._windows.size, 0);
});
