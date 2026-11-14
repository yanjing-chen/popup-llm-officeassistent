import {test} from 'node:test';
import assert from 'node:assert/strict';
import {popupDragDamage} from '../popup-llm-officeassistent@yanjing_chen@qq.com/backendUtils.js';
import {fixture} from './extension-fixture.mjs';
import {Widget} from './mocks.mjs';

function open() {
    Widget.all = [];
    const f = fixture();
    f.extension._showResultWindow('selected text', 'translate');
    const actor = f.extension._resultContainer;
    const handle = Widget.all.find(w => w.style_class === 'translator-drag-handle');
    const press = () => {
        const x = actor.x + 12, y = actor.y + 12;
        f.pointer([x, y, 256]);
        handle.emit('button-press-event', {get_button: () => 1, get_coords: () => [x, y]});
    };
    return {...f, actor, handle, press};
}

test('shadow damage includes both old and new window extents', () => {
    const damage = popupDragDamage({x: 100, y: 100}, {x: 350, y: 240}, 450, 300);
    assert.deepEqual(damage, {x: 52, y: 52, width: 796, height: 536});
    assert.ok(damage.x <= 100 - 24 && damage.y <= 100 - 24);
    assert.ok(damage.x + damage.width >= 350 + 450 + 24);
    assert.ok(damage.y + damage.height >= 240 + 300 + 24 + 8);
});
test('redraw union covers diagonal and negative-coordinate monitor movement', () => {
    const box = popupDragDamage({x: 1800, y: 500}, {x: -500, y: -20}, 450, 400);
    assert.equal(box.x, -548); assert.equal(box.y, -68);
    assert.equal(box.x + box.width, 2298); assert.equal(box.y + box.height, 948);
});
test('fractional coordinates round redraw region outward', () => {
    const box = popupDragDamage({x: 0.3, y: 0.7}, {x: 12.4, y: 10.2}, 450.5, 300.5);
    assert.equal(box.x, -48); assert.equal(box.y, -48);
    assert.ok(box.x + box.width >= 12.4 + 450.5 + 48);
    assert.ok(box.y + box.height >= 10.2 + 300.5 + 48);
});

test('held drag uses only translation: no position, size, style, or cloned actors', () => {
    const f = open(); f.press();
    const base = {x: f.actor.x, y: f.actor.y};
    const count = Widget.all.length;
    const setPosition = f.actor.set_position.bind(f.actor);
    f.actor.set_position = () => { throw new Error('Allocation mutation while held'); };
    f.actor.set_width = () => { throw new Error('Resize while held'); };
    f.actor.set_style = () => { throw new Error('Restyle while held'); };
    for (let i = 1; i <= 40; i++) {
        f.pointer([base.x + 12 + i * 5, base.y + 12 + i, 256]);
        f.tick();
    }
    assert.equal(f.extension._dragState?.actor, f.actor);
    assert.equal(f.actor.x, base.x); assert.equal(f.actor.y, base.y);
    assert.deepEqual(f.actor.get_transformed_position(), [base.x + 200, base.y + 40]);
    assert.equal(Widget.all.length, count);
    assert.equal(f.damages.length, 0); // Native translation damage, no extra stage clips per frame.
    f.actor.set_position = setPosition;
    f.extension._endPopupDrag();
});

test('release commits position once and clears translation without a visual jump', () => {
    const f = open(); f.press();
    f.pointer([700, 450, 256]); f.tick();
    const visible = f.actor.get_transformed_position();
    let writes = 0;
    const original = f.actor.set_position.bind(f.actor);
    f.actor.set_position = (x, y) => { writes++; original(x, y); };
    f.pointer([700, 450, 0]); f.tick();
    assert.deepEqual(f.actor.get_transformed_position(), visible);
    assert.equal(f.actor.translation_x, 0); assert.equal(f.actor.translation_y, 0);
    assert.equal(writes, 1); assert.equal(f.sources.size, 0);
});

test('height notifications cannot run the allocation-position writer during a held drag', () => {
    const f = open(); f.actor.emit('notify::height'); assert.equal(f.sources.size, 1);
    f.press();
    assert.ok([...f.sources.values()].every(source => source.type === 'frame'));
    f.pointer([620, 400, 256]); f.tick();
    const visible = f.actor.get_transformed_position();
    for (let i = 0; i < 1000; i++) f.actor.emit('notify::height');
    f.extension._applyResultPosition(); f.extension._constrainResultWindow();
    assert.deepEqual(f.actor.get_transformed_position(), visible);
    assert.equal(f.flushIdles(), 0); assert.equal(f.sources.size, 1);
    f.extension._endPopupDrag();
});

test('cross-monitor drag defers resizing until release', () => {
    const f = open(); f.press();
    const originalStyle = f.actor.get_style();
    f.pointer([2500, 300, 256]); f.tick();
    assert.equal(f.actor.get_style(), originalStyle);
    assert.ok(f.actor.get_transformed_position()[0] >= 1920);
    f.pointer([2500, 300, 0]); f.tick();
    assert.match(f.actor.get_style(), /max-height: 560px/);
    assert.equal(f.actor.translation_x, 0);
});

test('redraw retains old content extent when streamed response height grows then shrinks', () => {
    const f = open(); f.press();
    f.actor.height = 650;
    f.pointer([600, 300, 256]); f.tick();
    f.actor.height = 300;
    f.pointer([620, 310, 256]); f.tick();
    assert.equal(f.damages.length, 0);
    f.extension._endPopupDrag();
    assert.ok(f.damages.at(-1).height >= 650 + 96);
});

test('beginning a drag settles opacity fade without starting another animation', () => {
    const f = open(); f.actor.opacity = 100; f.press();
    assert.ok(f.actor.removedTransitions.includes('opacity'));
    assert.equal(f.actor.opacity, 255);
    assert.equal(f.grabCalls(), 0); f.extension._endPopupDrag();
});

test('missing clipped-redraw API falls back to actor redraw, not a full-stage loop', () => {
    const f = open(); f.stage.queue_redraw_with_clip = undefined;
    f.stage.queue_redraw = () => { throw new Error('Must not repaint whole stage in a polling loop'); };
    f.press(); f.pointer([600, 400, 256]); f.tick();
    assert.notEqual(f.extension._dragState, null);
    assert.equal(f.actor.redraws || 0, 0);
    f.extension._endPopupDrag();
    assert.equal(f.actor.redraws, 1);
});

test('different native clip binding is attempted once per gesture, not every frame', () => {
    const f = open(); let attempts = 0;
    f.stage.queue_redraw_with_clip = () => { attempts++; throw new Error('older ABI'); };
    f.press();
    for (let i = 0; i < 10; i++) { f.pointer([600 + i, 400, 256]); f.tick(); }
    assert.equal(attempts, 0); assert.equal(f.actor.redraws || 0, 0);
    f.extension._endPopupDrag(); assert.equal(attempts, 1); assert.equal(f.actor.redraws, 1);
});

for (const reason of ['close', 'destroy', 'disable']) {
    test(`translation and scheduled sources are cleaned up on ${reason}`, () => {
        const f = open(); f.press(); f.pointer([700, 400, 256]); f.tick();
        assert.notEqual(f.actor.translation_x, 0);
        if (reason === 'close') f.extension._closeUI();
        if (reason === 'destroy') f.actor.destroy();
        if (reason === 'disable') {
            f.manager.disable();
        }
        assert.equal(f.actor.translation_x, 0); assert.equal(f.actor.translation_y, 0);
        assert.equal(f.sources.size, 0); assert.equal(f.grabCalls(), 0);
    });
}
