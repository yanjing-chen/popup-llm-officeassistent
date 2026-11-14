import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Widget, settle} from './mocks.mjs';
import {prefsFixture} from './preferences-fixture.mjs';

const fixture = (kind = 'ollama') => prefsFixture({kind});

test('all six feature rows use actual-model drop-downs and clear missing old choices', async () => {
    const f = fixture(); await settle();
    assert.equal(f.models().length, 6);
    assert.ok(f.models().every(row => Array.isArray(row.model) && row.model.includes('a')));
    assert.ok(f.models().every(row => !row.model.some(label => label.includes('old-model'))));
    f.models()[4].set_selected(2); // Choose-model placeholder, a, b.
    assert.equal(f.config.get_string('model-name-qa'), 'b');
    assert.equal(f.config.get_string('model-name'), '');
});
test('QA title always uses plain text markup mode', async () => {
    const f = fixture(); await settle();
    assert.equal(f.byTitle('启用“智能问答” (Enable QA)').use_markup, false);
});
test('idle row immediately follows icon auto-close row', async () => {
    const f = fixture(); await settle();
    const group = f.byTitle('界面与交互 (Appearance & Interaction)');
    const index = group.children.findIndex(w => w.title === '图标自动关闭时间 (Auto-close Time)');
    assert.equal(group.children[index + 1], f.idle());
});
test('idle value is saved independently from icon auto-close setting', async () => {
    const f = fixture(); await settle(); f.idle().set_value(300);
    assert.equal(f.config.get_int('model-idle-time'), 300);
    assert.equal(f.config.get_int('auto-close-time'), 5);
});
test('failed refresh retains selected names and disables empty model menus', async () => {
    const f = fixture(); await settle(); f.models()[0].set_selected(1);
    f.setResult(new Error('offline')); f.refresh(); await settle();
    assert.equal(f.config.get_string('model-name'), 'a');
    assert.equal(f.models()[0].sensitive, false);
    assert.equal(f.models()[0].model.length, 1);
});
test('unknown compatible backend does not advertise working memory control', async () => {
    const f = fixture('generic'); await settle();
    assert.equal(f.idle().sensitive, false); assert.equal(f.apply().visible, false);
});
test('opening Runtime preferences is strictly read-only', async () => {
    const f = fixture('runtime'); await settle();
    assert.equal(f.apply().visible, true); assert.equal(f.apply().sensitive, true);
    assert.deepEqual(f.writes, []);
});
test('Runtime configuration cannot be written without affirmative confirmation', async () => {
    const f = fixture('runtime'); await settle(); f.idle().set_value(900);
    f.apply().emit('clicked');
    const dialog = Widget.all.find(w => w.heading);
    assert.equal(dialog.presented, true); assert.deepEqual(f.writes, []);
    dialog.emit('response', 'cancel'); await settle(); assert.deepEqual(f.writes, []);
    f.apply().emit('clicked');
    Widget.all.filter(w => w.heading).at(-1).emit('response', 'apply'); await settle();
    assert.deepEqual(f.writes, [900]);
});
test('Runtime apply is disabled for immediate release and an already matching server value', async () => {
    const f = fixture('runtime'); await settle();
    for (const value of [0, 600]) { f.idle().set_value(value); assert.equal(f.apply().sensitive, false); }
});
test('closing preferences disposes discovery client and debounce timers', async () => {
    const f = fixture(); await settle();
    f.byTitle('接口链接 (API Endpoint)').set_text('http://localhost:1234/v1/chat/completions');
    assert.equal(f.timers.size, 1);
    f.window.emit('close-request');
    assert.equal(f.timers.size, 0); assert.ok(f.clients.every(client => client.disposed));
});
