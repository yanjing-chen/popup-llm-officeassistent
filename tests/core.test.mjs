import {test} from 'node:test';
import assert from 'node:assert/strict';
import {endpointUrls, parseModelList, modelChoices, lmInstanceToUnload,
    isOllamaCatalog, isLMStudioCatalog, isLegacyLMStudioCatalog,
    isRuntimePreferences, clampPopupPosition} from '../popup-llm-officeassistent@yanjing_chen@qq.com/backendUtils.js';
import {IdleModels} from '../popup-llm-officeassistent@yanjing_chen@qq.com/idleModels.js';

for (const [url, expected] of [
    ['http://127.0.0.1:8111/v1/chat/completions', 'http://127.0.0.1:8111/v1/models'],
    ['http://localhost:11434/v1/chat/completions/', 'http://localhost:11434/v1/models'],
    ['https://server.test/proxy/v1/chat/completions?x=1', 'https://server.test/proxy/v1/models'],
    ['http://[::1]:1234/api/v0/chat/completions', 'http://[::1]:1234/api/v0/models'],
    ['https://server.test/custom/chat/completions', 'https://server.test/custom/models'],
]) {
    test(`derive same-origin models endpoint: ${url}`, () => {
        const urls = endpointUrls(url);
        assert.equal(urls.models, expected);
        for (const value of Object.values(urls))
            assert.equal(new URL(value).origin, new URL(url).origin);
    });
}

for (const bad of ['file:///etc/passwd', 'https://token@host/v1/chat/completions',
    'http://host/wrong', 'http://host/v1/chat/completions#fragment', '']) {
    test(`reject invalid/unsafe endpoint: ${bad}`, () => assert.throws(() => endpointUrls(bad)));
}

test('prefix preserved for native management endpoints', () => {
    const urls = endpointUrls('https://example.test/runtime/v1/chat/completions');
    assert.equal(urls.ollamaUnload, 'https://example.test/runtime/api/generate');
    assert.equal(urls.runtimePreferences, 'https://example.test/runtime/v1/runtime/preferences');
});

test('OpenAI list de-duplicates, filters typed embeddings, retains model IDs', () => {
    assert.deepEqual(parseModelList({data: [{id: 'z'}, {id: 'a'}, {id: 'a'},
        {id: 'embed', type: 'embedding'}, {id: ''}]}).map(m => m.id), ['a', 'z']);
});
test('Ollama native list supports names', () => {
    assert.equal(parseModelList({models: [{name: 'qwen:7b', digest: 'abc'}]})[0].id, 'qwen:7b');
});
test('LM Studio native list uses keys and display names', () => {
    assert.deepEqual(parseModelList({models: [{key: 'org/model', display_name: 'A', type: 'llm'},
        {key: 'embed', type: 'embedding'}]}), [{id: 'org/model', label: 'A — org/model'}]);
});
test('malformed model list is rejected', () => assert.throws(() => parseModelList({error: 'bad'})));
test('discovery never infers backend from a port number', () => {
    assert.equal(isOllamaCatalog({data: [{id: 'ollama-model'}]}), false);
    assert.equal(isLMStudioCatalog({models: [{id: 'model'}]}), false);
    assert.equal(isLegacyLMStudioCatalog({data: [{id: 'm', type: 'llm'}]}), false);
});
test('Ollama/LM Studio protocol recognition', () => {
    assert.equal(isOllamaCatalog({models: [{name: 'm', digest: 'abc'}]}), true);
    assert.equal(isLMStudioCatalog({models: [{key: 'm', loaded_instances: []}]}), true);
    assert.equal(isLegacyLMStudioCatalog({data: [{id: 'm', type: 'llm', state: 'loaded'}]}), true);
});
test('Runtime preference recognition validates integer and complete contract', () => {
    const prefs = {preload_model: '', preload_enabled: false, backend_preference: 'auto', idle_unload_seconds: 600};
    assert.equal(isRuntimePreferences(prefs), true);
    for (const bad of [-1, true, '600', 3.5, 86401])
        assert.equal(isRuntimePreferences({...prefs, idle_unload_seconds: bad}), false);
    assert.equal(isRuntimePreferences({idle_unload_seconds: 600}), false);
});
test('missing model IDs never become selectable or displayable choices', () => {
    const result = modelChoices([{id: 'new', label: 'new'}], 'old');
    assert.equal(result.entries[0].id, null);
    assert.equal(result.entries[0].available, false);
    assert.equal(result.selected, 0);
    assert.equal(result.entries.some(item => item.id === 'old'), false);
    assert.equal(modelChoices([], 'old').entries[0].label, '尚未安装模型');
    assert.equal(modelChoices([], '').entries[0].id, null);
});
test('matching selection retains exact ID', () => {
    const result = modelChoices([{id: 'a', label: 'a'}, {id: 'b', label: 'b'}], 'b');
    assert.equal(result.selected, 1);
    assert.equal(result.entries.length, 2);
});
test('LM Studio unload uses only one exact instance', () => {
    const catalog = {models: [{key: 'model', loaded_instances: [{id: 'alias1'}, {id: 'alias2'}]}]};
    assert.equal(lmInstanceToUnload(catalog, 'alias1'), 'alias1');
    assert.throws(() => lmInstanceToUnload(catalog, 'model'));
    assert.equal(lmInstanceToUnload(catalog, 'unrelated'), null);
    assert.equal(lmInstanceToUnload({models: [{key: 'model', loaded_instances: []}]}, 'model'), null);
    assert.equal(lmInstanceToUnload({models: [{key: 'model', loaded_instances: [{id: 'alias'}]}]}, 'model'), 'alias');
});

for (const monitor of [{x: 0, y: 32, width: 1920, height: 1048}, {x: -1920, y: 0, width: 1920, height: 1080},
    {x: 1920, y: -100, width: 1280, height: 800}]) {
    test(`popup stays on monitor ${monitor.x},${monitor.y}`, () => {
        const p = clampPopupPosition(-10000, 10000, 450, 500, monitor);
        assert.ok(p.x >= monitor.x && p.x + 450 <= monitor.x + monitor.width);
        assert.ok(p.y >= monitor.y && p.y + 500 <= monitor.y + monitor.height);
    });
}

function fixture() {
    let now = 0;
    let id = 0;
    const timers = new Map();
    const unloaded = [];
    const errors = [];
    const manager = new IdleModels({
        now: () => now,
        schedule: (ms, callback) => { timers.set(++id, {at: now + ms, callback}); return id; },
        cancel: timer => timers.delete(timer),
        unload: async model => unloaded.push(model),
        report: error => errors.push(error.message),
    });
    const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
    const advance = async ms => {
        now += ms;
        for (const [timer, value] of [...timers]) {
            if (value.at <= now) { timers.delete(timer); value.callback(); }
        }
        await flush();
    };
    return {manager, timers, unloaded, errors, advance, flush};
}

test('default idle timeout is 60 seconds, measured after completion', async () => {
    const f = fixture();
    await f.manager.begin('m'); f.manager.finish('m');
    await f.advance(59999);
    assert.deepEqual(f.unloaded, []);
    await f.advance(1); assert.deepEqual(f.unloaded, ['m']);
});
test('idle timeout starts at answer completion, not request start', async () => {
    const f = fixture(); f.manager.setSeconds(10);
    await f.manager.begin('m'); await f.advance(100000);
    assert.deepEqual(f.unloaded, []);
    f.manager.finish('m'); await f.advance(9999);
    assert.deepEqual(f.unloaded, []);
    await f.advance(1);
    assert.deepEqual(f.unloaded, ['m']);
});
test('zero unloads only after completed answer', async () => {
    const f = fixture(); f.manager.setSeconds(0);
    await f.manager.begin('m'); await f.advance(10000);
    assert.deepEqual(f.unloaded, []);
    f.manager.finish('m'); await f.advance(0);
    assert.deepEqual(f.unloaded, ['m']);
});
test('new QA turn cancels and resets the model timer', async () => {
    const f = fixture(); f.manager.setSeconds(5);
    await f.manager.begin('m'); f.manager.finish('m'); await f.advance(4000);
    await f.manager.begin('m'); await f.advance(9999);
    assert.deepEqual(f.unloaded, []);
    f.manager.finish('m'); await f.advance(5000);
    assert.deepEqual(f.unloaded, ['m']);
});
test('different models are managed independently', async () => {
    const f = fixture(); f.manager.setSeconds(5);
    await f.manager.begin('a'); f.manager.finish('a');
    await f.manager.begin('b'); await f.advance(5000);
    assert.deepEqual(f.unloaded, ['a']);
    f.manager.finish('b'); await f.advance(5000);
    assert.deepEqual(f.unloaded, ['a', 'b']);
});
test('changing timeout does not unload an active request', async () => {
    const f = fixture(); f.manager.setSeconds(60);
    await f.manager.begin('m'); f.manager.setSeconds(0); await f.advance(1e6);
    assert.deepEqual(f.unloaded, []);
    f.manager.finish('m'); await f.advance(0);
    assert.deepEqual(f.unloaded, ['m']);
});
test('legacy -1 migrates to 60 seconds rather than disabling the idle timer', async () => {
    const f = fixture(); f.manager.setSeconds(5);
    await f.manager.begin('m'); f.manager.finish('m'); f.manager.setSeconds(-1);
    await f.advance(10000); assert.deepEqual(f.unloaded, []);
    await f.advance(50000); assert.deepEqual(f.unloaded, ['m']);
});
test('multiple active references prevent premature unload', async () => {
    const f = fixture(); f.manager.setSeconds(0);
    await f.manager.begin('m'); await f.manager.begin('m'); f.manager.finish('m');
    await f.advance(0); assert.deepEqual(f.unloaded, []);
    f.manager.finish('m'); await f.advance(0); assert.deepEqual(f.unloaded, ['m']);
});
test('new inference waits for an already-issued unload', async () => {
    const f = fixture(); f.manager.setSeconds(0);
    let complete; f.manager.unload = () => new Promise(resolve => { complete = resolve; });
    await f.manager.begin('m'); f.manager.finish('m'); await f.advance(0);
    let began = false; const pending = f.manager.begin('m').then(() => { began = true; });
    await f.flush(); assert.equal(began, false);
    complete(); await pending; assert.equal(began, true);
    assert.equal(f.manager.models.get('m').active, 1);
});
test('disable/connection replacement clears idle timers', async () => {
    const f = fixture(); f.manager.setSeconds(5);
    await f.manager.begin('m'); f.manager.finish('m'); f.manager.dispose();
    await f.advance(10000); assert.deepEqual(f.unloaded, []); assert.equal(f.timers.size, 0);
});
test('unload error reports once without a retry loop', async () => {
    const f = fixture(); f.manager.setSeconds(0);
    f.manager.unload = async () => { throw new Error('unsupported'); };
    await f.manager.begin('m'); f.manager.finish('m'); await f.advance(0); await f.advance(10000);
    assert.deepEqual(f.errors, ['unsupported']); assert.equal(f.timers.size, 0);
});
