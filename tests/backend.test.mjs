import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as utils from '../popup-llm-officeassistent@yanjing_chen@qq.com/backendUtils.js';
import {loadClass} from './mocks.mjs';

function fixture(replies = {}) {
    const requests = [];
    const Backend = loadClass('modelBackend.js', 'ModelBackend', {
        ...utils,
        GLib: {PRIORITY_DEFAULT: 0, Bytes: class {constructor(data) { this.data = data; }}},
        Soup: {
            MessageFlags: {NO_REDIRECT: 16},
            Message: {new: (method, url) => ({
                method, url, flags: 0, headers: {},
                get_flags() { return this.flags; }, set_flags(flags) { this.flags = flags; },
                request_headers: {append() {}},
                set_request_body_from_bytes(_type, bytes) { this.body = JSON.parse(new TextDecoder().decode(bytes.data)); },
            })},
            Session: class {
                abort() { this.aborted = true; }
                send_and_read_async(message, _priority, _cancellable, callback) {
                    requests.push(message);
                    const reply = replies[new URL(message.url).pathname] || {status: 404, body: {}};
                    message.status_code = reply.status ?? 200;
                    queueMicrotask(() => callback(this, reply));
                }
                send_and_read_finish(reply) {
                    return {get_data: () => new TextEncoder().encode(JSON.stringify(reply.body))};
                }
            },
        },
    });
    return {client: new Backend('http://localhost:8111/v1/chat/completions', 'secret'), requests};
}
const standard = {body: {data: [{id: 'm'}]}};

test('generic models server never receives an unload POST', async () => {
    const f = fixture({'/v1/models': standard});
    assert.equal((await f.client.discover()).kind, 'generic');
    await assert.rejects(f.client.unload('m'), /卸载接口/);
    assert.equal(f.requests.filter(r => r.method === 'POST').length, 0);
});
test('all discovery operations are read-only and same-origin', async () => {
    const f = fixture({'/v1/models': standard});
    await f.client.discover();
    assert.ok(f.requests.every(r => r.method === 'GET' && r.url.startsWith('http://localhost:8111/')));
    assert.ok(f.requests.every(r => (r.flags & 16) === 16));
});
test('Ollama detection and exact unload request', async () => {
    const f = fixture({'/v1/models': standard,
        '/api/tags': {body: {models: [{name: 'm', digest: 'abc'}]}}, '/api/generate': {body: {done: true}}});
    assert.equal((await f.client.discover()).kind, 'ollama');
    await f.client.unload('m');
    const post = f.requests.find(r => r.method === 'POST');
    assert.deepEqual(JSON.parse(JSON.stringify(post.body)), {model: 'm', keep_alive: 0, stream: false});
    assert.ok(!('prompt' in post.body));
});
test('native models rescue a missing compatible models endpoint', async () => {
    const f = fixture({'/api/tags': {body: {models: [{name: 'm', digest: 'abc'}]}}});
    assert.equal((await f.client.discover()).models[0].id, 'm');
});
test('an empty Ollama catalog is a successful no-model result, even without a standard endpoint', async () => {
    const f = fixture({'/api/tags': {body: {models: []}}});
    const result = await f.client.discover();
    assert.equal(result.kind, 'ollama'); assert.equal(result.models.length, 0);
    assert.ok(f.requests.every(request => request.method === 'GET'));
});
test('an actual empty Ollama catalog overrides stale models in a compatibility catalog', async () => {
    const f = fixture({'/v1/models': standard, '/api/tags': {body: {models: []}}});
    assert.equal((await f.client.discover()).models.length, 0);
});
test('LM Studio unload resolves instance IDs, not arbitrary models', async () => {
    const f = fixture({'/v1/models': standard,
        '/api/v1/models': {body: {models: [{key: 'm', loaded_instances: [{id: 'instance-one'}]}]}},
        '/api/v1/models/unload': {body: {instance_id: 'instance-one'}}});
    assert.equal((await f.client.discover()).kind, 'lmstudio');
    await f.client.unload('m');
    assert.deepEqual(JSON.parse(JSON.stringify(f.requests.find(r => r.method === 'POST').body)), {instance_id: 'instance-one'});
});
test('old LM Studio does not receive guessed unload requests', async () => {
    const f = fixture({'/v1/models': standard,
        '/api/v0/models': {body: {data: [{id: 'm', type: 'llm', state: 'loaded'}]}}});
    assert.equal((await f.client.discover()).kind, 'lmstudio-legacy');
    await assert.rejects(f.client.unload('m'), /旧版 LM Studio/);
    assert.equal(f.requests.filter(r => r.method === 'POST').length, 0);
});
test('Runtime detection alone never changes the shared service', async () => {
    const f = fixture({'/v1/models': standard,
        '/v1/runtime/preferences': {body: {preload_model: '', preload_enabled: false, backend_preference: 'auto', idle_unload_seconds: 600}}});
    const info = await f.client.discover();
    assert.equal(info.kind, 'runtime'); assert.equal(info.runtimeIdleSeconds, 600);
    assert.equal(f.requests.filter(r => r.method === 'POST').length, 0);
});
test('Runtime writes only the confirmed idle field, never preload/backend', async () => {
    const prefs = {preload_model: '', preload_enabled: false, backend_preference: 'auto', idle_unload_seconds: 900};
    const f = fixture({'/v1/models': standard, '/v1/runtime/preferences': {body: prefs}});
    await f.client.configureRuntimeIdle(900);
    const post = f.requests.find(r => r.method === 'POST');
    assert.deepEqual(JSON.parse(JSON.stringify(post.body)), {idle_unload_seconds: 900});
});
test('Runtime 0 is never misinterpreted as immediate unload', async () => {
    const f = fixture();
    for (const invalid of [0, -1, true, 1.5, '100', 86401])
        await assert.rejects(f.client.configureRuntimeIdle(invalid), /Runtime/);
    assert.equal(f.requests.length, 0);
});
test('HTTP error responses do not expose secret tokens or body', async () => {
    const f = fixture({'/v1/models': {status: 401, body: {error: 'sensitive-secret'}}});
    await assert.rejects(f.client.request('http://localhost:8111/v1/models'), error =>
        error.message === 'HTTP 401' && !error.message.includes('secret'));
});
test('disposed model-discovery session does not issue requests', async () => {
    const f = fixture({'/v1/models': standard}); f.client.dispose();
    await assert.rejects(f.client.request('http://localhost:8111/v1/models'), /连接已关闭/);
    assert.equal(f.requests.length, 0);
});
