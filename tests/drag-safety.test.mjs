// Exercise the real handle signals + actor-frame tracking, not only direct helpers.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fixture} from './extension-fixture.mjs';
import {Widget} from './mocks.mjs';

function open() {
    Widget.all = [];
    const f = fixture();
    f.extension._showResultWindow('selected text', 'translate');
    assert.deepEqual(f.logs, []);
    const handle = Widget.all.find(w => w.style_class === 'translator-drag-handle');
    const actor = f.extension._resultContainer;
    const press = (button = 1) => {
        const x = actor.x + 12, y = actor.y + 12;
        f.pointer([x, y, 256]);
        return handle.emit('button-press-event', {get_button: () => button, get_coords: () => [x, y]});
    };
    return {...f, handle, actor, press};
}

test('title drag uses a reactive box with a non-reactive child, separate from action buttons', () => {
    const f = open();
    assert.equal(f.handle.reactive, true);
    assert.ok(f.handle.children.every(child => child.reactive === false));
    assert.ok(f.handle.children.every(child => typeof child.text === 'string'));
    assert.ok([...f.handle.signals.values()].some(s => s.signal === 'button-press-event'));
});

test('real title signal starts tracking, moves on pointer change, and stops on off-window release', () => {
    const f = open(); const x = f.actor.x, y = f.actor.y;
    assert.equal(f.press(), 1);
    assert.equal(f.sources.size, 1);
    f.pointer([x + 212, y + 112, 256]); f.tick();
    assert.deepEqual(f.actor.get_transformed_position(), [x + 200, y + 100]);
    f.pointer([1000, 600, 0]); f.tick();
    assert.equal(f.extension._dragState, null); assert.equal(f.sources.size, 0);
    assert.equal(f.grabCalls(), 0); assert.equal(f.stage.signals.size, 0);
});

test('release signal ends tracking immediately without waiting for the next actor frame', () => {
    const f = open(); f.press();
    f.handle.emit('button-release-event', {get_button: () => 1, get_coords: () => [500, 300]});
    assert.equal(f.sources.size, 0); assert.equal(f.extension._dragState, null);
});

test('right-clicking the handle never begins tracking or intercepts desktop input', () => {
    const f = open(); assert.equal(f.press(3), 0);
    assert.equal(f.sources.size, 0); assert.equal(f.grabCalls(), 0);
});

test('stationary held mouse does not continuously reallocate or move the window', () => {
    const f = open(); f.press(); let positions = 0;
    f.actor.set_position = () => { positions++; };
    for (let i = 0; i < 100; i++) f.tick();
    assert.equal(positions, 0); f.extension._endPopupDrag();
});

test('only one pointer source exists during repeated title presses', () => {
    const f = open(); f.press(); f.press(); f.press();
    assert.equal(f.sources.size, 1); f.extension._endPopupDrag();
    assert.equal(f.sources.size, 0);
});

test('stale cancelled callbacks cannot stop a newer drag source', () => {
    const f = open(); f.press();
    const stale = [...f.sources.values()][0].callback;
    f.press(); const current = f.extension._dragState;
    assert.equal(stale(), false);
    assert.equal(f.extension._dragState, current); assert.equal(f.sources.size, 1);
    f.extension._endPopupDrag();
});

for (const condition of ['close', 'destroy', 'hide', 'lock', 'overview', 'disable']) {
    test(`drag source is cleaned up on ${condition}`, () => {
        const f = open(); f.press();
        if (condition === 'close') f.extension._closeUI();
        if (condition === 'destroy') f.actor.destroy();
        if (condition === 'hide') { f.actor.visible = false; f.tick(); }
        if (condition === 'lock') { f.main.sessionMode.isLocked = true; f.tick(); }
        if (condition === 'overview') { f.main.overview.visible = true; f.tick(); }
        if (condition === 'disable') {
            f.manager.disable();
        }
        assert.equal(f.sources.size, 0);
        assert.equal(f.extension._dragState, null);
        assert.equal(f.grabCalls(), 0);
    });
}

test('handle destruction also stops its frame tracker', () => {
    const f = open(); f.press(); f.handle.destroy();
    assert.equal(f.sources.size, 0); assert.equal(f.extension._dragState, null);
});

test('drag layout exception stops the source rather than keeping desktop input captured', () => {
    const f = open(); f.press();
    f.extension._monitorAt = () => { throw new Error('monitor removed'); };
    f.pointer([500, 300, 256]); f.tick();
    assert.equal(f.sources.size, 0); assert.equal(f.extension._dragState, null);
    assert.equal(f.grabCalls(), 0);
});

test('release layout exception still cleans up tracking', () => {
    const f = open(); f.press();
    f.extension._monitorAt = () => { throw new Error('monitor removed'); };
    assert.doesNotThrow(() => f.handle.emit('button-release-event', {get_button: () => 1, get_coords: () => [500, 300]}));
    assert.equal(f.sources.size, 0);
});

test('height notifications coalesce into one idle callback and never change requested dimensions', () => {
    const f = open(); let widthWrites = 0, styleWrites = 0;
    f.actor.width = 448; // Real Clutter allocations may differ from requested width.
    f.actor.set_width = () => { widthWrites++; throw new Error('recursive layout'); };
    f.actor.set_style = () => { styleWrites++; throw new Error('recursive style'); };
    for (let i = 0; i < 1000; i++) f.actor.emit('notify::height');
    assert.equal(f.sources.size, 1);
    assert.equal(f.flushIdles(), 1);
    assert.equal(f.sources.size, 0); assert.equal(widthWrites, 0); assert.equal(styleWrites, 0);
});

test('position-triggered allocation notifications settle instead of entering a layout loop', () => {
    const f = open(); let writes = 0;
    const setPosition = f.actor.set_position.bind(f.actor);
    f.actor.set_position = (x, y) => {
        if (++writes > 3) throw new Error('position feedback loop');
        setPosition(x, y);
        f.actor.emit('notify::height');
    };
    f.extension._resultPosition = {x: 500, y: 300};
    f.actor.emit('notify::height');
    assert.ok(f.flushIdles() <= 2); assert.equal(writes, 1); assert.equal(f.sources.size, 0);
});

test('same-monitor drag compares cached requested width, not theme-adjusted actor width', () => {
    const f = open(); f.press();
    f.actor.width = 448;
    f.actor.set_width = () => { throw new Error('Repeated width changes cause allocation loops'); };
    f.pointer([550, 320, 256]);
    f.tick();
    assert.notEqual(f.extension._dragState, null);
    assert.equal(f.actor.get_transformed_position()[0], 538);
    f.extension._endPopupDrag();
});

test('queued positioning is cancelled when the window closes or is destroyed', () => {
    for (const destroy of [false, true]) {
        const f = open(); f.actor.emit('notify::height'); assert.equal(f.sources.size, 1);
        if (destroy) f.actor.destroy(); else f.extension._closeUI();
        assert.equal(f.sources.size, 0); assert.equal(f.extension._positionIdleId, 0);
    }
});

test('opening another result ends the old drag but preserves the source result', () => {
    const f = open(); f.press(); f.actor.emit('notify::height');
    const child = f.createWindow('next selected text', 'explain');
    assert.ok(child); assert.equal(f.actor.destroyed || false, false); assert.equal(f.extension._dragState, null);
    assert.equal(f.sources.size, 0); assert.deepEqual(f.logs, []);
});

test('reopening after external actor destruction reinitializes size and position constraints', () => {
    const f = open(); f.actor.destroy();
    assert.equal(f.extension._resultSize, null);
    const child = f.createWindow('next selected text', 'translate');
    assert.match(child._resultContainer.get_style(), /max-height:/);
    assert.equal(child._resultSize.width, 450);
    assert.deepEqual(f.logs, []);
});

test('production drag code does not install global grabs, event filters or capture hooks', () => {
    const source = ['extension.js', 'resultWindow.js', 'frameLoop.js'].map(name => readFileSync(new URL('../popup-llm-officeassistent@yanjing_chen@qq.com/' + name, import.meta.url), 'utf8')).join('\n');
    assert.doesNotMatch(source, /global\.stage\.grab\(/);
    assert.doesNotMatch(source, /global\.stage\.connect\(['"]captured-event/);
    assert.doesNotMatch(source, /add_filter\(|pushModal\(|new GLib\.MainLoop/);
});
