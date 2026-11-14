import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {modelChoices, modelIdleSeconds} from '../popup-llm-officeassistent@yanjing_chen@qq.com/backendUtils.js';
import {prefsFixture} from './preferences-fixture.mjs';
import {fixture as shellFixture} from './extension-fixture.mjs';
import {settle} from './mocks.mjs';

const suffixes = ['', '-explain', '-polish', '-mail', '-qa', '-custom'];
const modelKeys = suffixes.map(suffix => 'model-name' + suffix);
const assigned = id => Object.fromEntries(modelKeys.map(key => [key, id]));
const actual = [{id: 'hf.co/tencent/HY-MT2:latest', label: 'hf.co/tencent/HY-MT2:latest'},
    {id: 'qwen3.5:9b', label: 'qwen3.5:9b'}];
const catalog = (models = actual) => ({kind: 'ollama', models, memoryStatus: 'supported'});
const discovery = f => f.byTitle('自动识别模型 (Model Discovery)');
const menus = f => f.models().flatMap(row => row.model);
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};

test('screenshot regression: missing old example never appears among real installed models', async () => {
    const f = prefsFixture({values: assigned('deepseek-r1:14b'), result: catalog()}); await settle();
    for (const row of f.models()) {
        assert.deepEqual(row.model, ['请选择模型', ...actual.map(model => model.label)]);
        assert.equal(row.get_selected(), 0); assert.equal(row.sensitive, true);
    }
    assert.ok(menus(f).every(label => !label.includes('deepseek') && !label.includes('原配置')));
    for (const key of modelKeys) assert.equal(f.config.get_string(key), '');
});

test('six valid independent model assignments remain unchanged', async () => {
    const values = Object.fromEntries(modelKeys.map((key, index) => [key, actual[index % 2].id]));
    const f = prefsFixture({values, result: catalog()}); await settle();
    modelKeys.forEach((key, index) => {
        assert.equal(f.config.get_string(key), values[key]);
        assert.equal(f.models()[index].get_selected(), index % 2);
        assert.deepEqual(f.models()[index].model, actual.map(model => model.label));
    });
    assert.equal(f.config.writes.filter(([key]) => modelKeys.includes(key)).length, 0);
});

test('a genuinely installed DeepSeek remains available; no model-family blacklist is used', async () => {
    const installed = {id: 'deepseek-r1:14b', label: 'deepseek-r1:14b'};
    const f = prefsFixture({values: assigned(installed.id), result: catalog([installed])}); await settle();
    assert.ok(f.models().every(row => row.model.length === 1 && row.model[0] === installed.id));
    for (const key of modelKeys) assert.equal(f.config.get_string(key), installed.id);
});

test('successful empty catalog displays exactly 尚未安装模型 and disables all six selectors', async () => {
    const f = prefsFixture({values: assigned(''), result: catalog([])}); await settle();
    assert.ok(f.models().every(row => row.sensitive === false && row.model.length === 1 && row.model[0] === '尚未安装模型'));
    assert.match(discovery(f).subtitle, /尚未安装模型/);
    for (const key of modelKeys) assert.equal(f.config.get_string(key), '');
});

test('installing models then refreshing reveals only actual models and enables explicit selection', async () => {
    const f = prefsFixture({values: assigned(''), result: catalog([])}); await settle();
    f.setResult(catalog()); f.refresh(); await settle();
    assert.ok(f.models().every(row => row.sensitive));
    f.models()[2].set_selected(2);
    assert.equal(f.config.get_string('model-name-polish'), actual[1].id);
    assert.equal(f.config.get_string('model-name'), '');
});

test('removing a model clears only assignments to that model, never substitutes another one', async () => {
    const f = prefsFixture({values: {...assigned(actual[1].id), 'model-name': actual[0].id}, result: catalog()}); await settle();
    f.setResult(catalog([actual[1]])); f.refresh(); await settle();
    assert.equal(f.config.get_string('model-name'), '');
    for (const key of modelKeys.slice(1)) assert.equal(f.config.get_string(key), actual[1].id);
    assert.ok(!menus(f).includes(actual[0].id));
});

test('a confirmed empty refreshed catalog clears missing assignments instead of retaining ghost names', async () => {
    const f = prefsFixture({values: assigned(actual[0].id), result: catalog()}); await settle();
    f.setResult(catalog([])); f.refresh(); await settle();
    for (const key of modelKeys) assert.equal(f.config.get_string(key), '');
    assert.deepEqual([...new Set(menus(f))], ['尚未安装模型']);
});

test('initial loading displays no unverified stored IDs or stale model options', async () => {
    const pending = deferred();
    const f = prefsFixture({values: assigned('deepseek-r1:14b'), result: pending.promise});
    assert.deepEqual([...new Set(menus(f))], ['正在读取模型…']);
    assert.ok(f.models().every(row => row.sensitive === false));
    for (const key of modelKeys) assert.equal(f.config.get_string(key), 'deepseek-r1:14b');
    pending.resolve(catalog()); await settle();
    assert.ok(!menus(f).includes('deepseek-r1:14b'));
});

test('connection failure is not misreported as no installed models and does not erase saved IDs', async () => {
    const f = prefsFixture({values: assigned(actual[0].id), result: new Error('offline')}); await settle();
    assert.deepEqual([...new Set(menus(f))], ['无法获取模型列表']);
    assert.doesNotMatch(discovery(f).subtitle, /尚未安装模型/);
    for (const key of modelKeys) assert.equal(f.config.get_string(key), actual[0].id);
    assert.ok(f.models().every(row => !row.sensitive));
});

test('manual refresh immediately hides the previous catalog until the new response succeeds', async () => {
    const f = prefsFixture({values: assigned(actual[0].id), result: catalog()}); await settle();
    const pending = deferred(); f.setResult(pending.promise); f.refresh();
    assert.deepEqual([...new Set(menus(f))], ['正在读取模型…']);
    for (const key of modelKeys) assert.equal(f.config.get_string(key), actual[0].id);
    pending.resolve(catalog([actual[1]])); await settle();
    assert.ok(!menus(f).includes(actual[0].id));
    for (const key of modelKeys) assert.equal(f.config.get_string(key), '');
});

test('endpoint edits hide old-server model choices immediately, before the debounce elapses', async () => {
    const f = prefsFixture({values: assigned(actual[0].id), result: catalog()}); await settle();
    f.byTitle('接口链接 (API Endpoint)').set_text('http://localhost:1234/v1/chat/completions');
    assert.deepEqual([...new Set(menus(f))], ['正在读取模型…']);
    assert.ok(f.models().every(row => !row.sensitive)); assert.equal(f.idle().sensitive, false);
    assert.equal(f.timers.size, 1);
    f.setResult(catalog([actual[1]])); f.runTimers(); await settle();
    assert.ok(!menus(f).includes(actual[0].id));
    assert.equal(f.clients.at(-1).endpoint, 'http://localhost:1234/v1/chat/completions');
});

test('a superseded catalog response cannot reintroduce removed models or clear newer valid choices', async () => {
    const stale = deferred();
    const f = prefsFixture({values: assigned(actual[1].id), result: stale.promise});
    f.setResult(catalog([actual[1]])); f.refresh(); await settle();
    stale.resolve(catalog([actual[0]])); await settle();
    assert.deepEqual([...new Set(menus(f))], [actual[1].id]);
    for (const key of modelKeys) assert.equal(f.config.get_string(key), actual[1].id);
});

test('closing preferences prevents a pending empty response from clearing existing choices', async () => {
    const pending = deferred();
    const f = prefsFixture({values: assigned(actual[0].id), result: pending.promise});
    f.window.emit('close-request'); pending.resolve(catalog([])); await settle();
    for (const key of modelKeys) assert.equal(f.config.get_string(key), actual[0].id);
    assert.ok(f.clients.every(client => client.disposed));
});

test('status placeholders cannot be saved as model IDs and missing selections are not auto-assigned', async () => {
    const f = prefsFixture({values: assigned(''), result: catalog([actual[0]])}); await settle();
    for (const key of modelKeys) assert.equal(f.config.get_string(key), '');
    f.models()[0].set_selected(1); assert.equal(f.config.get_string('model-name'), actual[0].id);
    f.models()[0].set_selected(0); assert.equal(f.config.get_string('model-name'), '');
    f.models()[0].set_selected(4294967295); assert.equal(f.config.get_string('model-name'), '');
    assert.ok(!f.config.writes.some(([, value]) => value === '请选择模型' || value === '尚未安装模型'));
});

for (const [previous, expected] of [[-1, 60], [0, 0], [60, 60], [300, 300], [86400, 86400]]) {
    test(`idle preference migrates ${previous} to ${expected} without altering icon timeout`, async () => {
        const f = prefsFixture({values: {'model-idle-time': previous, 'auto-close-time': -1}}); await settle();
        assert.equal(f.idle().adjustment.lower, 0); assert.equal(f.idle().adjustment.upper, 86400);
        assert.equal(f.idle().get_value(), expected); assert.equal(f.config.get_int('model-idle-time'), expected);
        assert.doesNotMatch(f.idle().subtitle, /遵循后端|-1/);
        assert.equal(f.config.get_int('auto-close-time'), -1);
        assert.equal(f.byTitle('图标自动关闭时间 (Auto-close Time)').adjustment.lower, -1);
    });
}

test('idle normalization accepts only an explicit 0–86400 seconds', () => {
    for (const value of [0, 1, 60, 300, 86400]) assert.equal(modelIdleSeconds(value), value);
    for (const value of [-1, -2, 86401, Infinity, NaN, 1.5, undefined, '300']) assert.equal(modelIdleSeconds(value), 60);
});

test('Shell activation migrates legacy -1 even when preferences were not opened', () => {
    const f = shellFixture(); f.config.values.set('model-idle-time', -1);
    f.manager.enable();
    assert.equal(f.config.get_int('model-idle-time'), 60); assert.equal(f.manager._idleModels.seconds, 60);
    f.manager.disable();
});

for (const [index, action] of ['translate', 'explain', 'polish', 'mail', 'qa', 'custom'].entries()) {
    test(`${action}: an unassigned model cannot send an empty/example-model request`, async () => {
        const f = shellFixture(); f.config.values.set(modelKeys[index], '');
        await f.extension._callLLMAPI('source', action);
        assert.equal(f.requests.length, 0); assert.equal(f.begins.length, 0); assert.equal(f.finishes.length, 0);
        assert.match(f.extension._resultLabel.text, /尚未选择模型/);
    });
}

test('the exact selected backend model ID is sent unchanged, including repository and tag', async () => {
    const f = shellFixture(); f.config.values.set('model-name', actual[0].id);
    await f.extension._callLLMAPI('source', 'translate');
    assert.equal(f.requests[0].message.payload.model, actual[0].id);
});

test('compiled shipped schema contains no example model defaults and rejects -1 for model idle time', () => {
    const dir = fileURLToPath(new URL('../popup-llm-officeassistent@yanjing_chen@qq.com/schemas/', import.meta.url));
    const schema = 'org.gnome.shell.extensions.popup-llm-officeassistent';
    const run = (...args) => spawnSync('gsettings', ['--schemadir', dir, ...args], {
        encoding: 'utf8', env: {...process.env, GSETTINGS_BACKEND: 'memory'},
    });
    for (const key of modelKeys) {const result = run('get', schema, key); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), "''");}
    assert.equal(run('get', schema, 'model-idle-time').stdout.trim(), '60');
    assert.deepEqual(run('range', schema, 'model-idle-time').stdout.trim().split(/\s+/), ['range', 'i', '0', '86400']);
    assert.notEqual(run('set', schema, 'model-idle-time', '-1').status, 0);
    const xml = readFileSync(new URL('../popup-llm-officeassistent@yanjing_chen@qq.com/schemas/org.gnome.shell.extensions.popup-llm-officeassistent.gschema.xml', import.meta.url), 'utf8');
    assert.doesNotMatch(xml, /deepseek/i);
});
