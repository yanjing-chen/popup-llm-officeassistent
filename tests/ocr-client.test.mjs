import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './extension-fixture.mjs';
import {image, input, microtasks} from './ocr-fixture.mjs';
import {MAX_OCR_RESPONSE_BYTES} from '../popup-llm-officeassistent@yanjing_chen@qq.com/ocrUtils.js';

const model = 'paddleocr-vl:latest';
const options = f => ({model, png: image().png, prompt: 'OCR:', streaming: true,
    idleSeconds: 60, cancellable: new f.Gio.Cancellable(), onText: () => {}});

test('OCR client bounds raw response bytes and closes its stream even on oversized data', async () => {
    const f = fixture(), client = new f.OcrClient(f.config.get_string('api-url'));
    const task = client.recognize(options(f));
    const rejected = assert.rejects(task, /上限/);
    const stream = input([new Uint8Array(MAX_OCR_RESPONSE_BYTES + 1)]);
    f.requests[0].callback(f.requests[0].session, stream);
    await rejected;
    assert.equal(stream.closed, true); client.dispose();
});

test('OCR client releases stream on cancellation and never exposes server error detail', async () => {
    const f = fixture(), client = new f.OcrClient(f.config.get_string('api-url'));
    const opts = options(f);
    const task = client.recognize(opts);
    const rejected = assert.rejects(task);
    const stream = input([new TextEncoder().encode('{"done":true}\n')]);
    opts.cancellable.cancel();
    f.requests[0].callback(f.requests[0].session, stream);
    await rejected;
    assert.equal(stream.closed, true); client.dispose();
});

test('OCR client does not follow a redirect from local server to another endpoint', async () => {
    const f = fixture(), client = new f.OcrClient(f.config.get_string('api-url'), 'test-key');
    const task = client.recognize(options(f));
    const rejected = assert.rejects(task, /HTTP 307/);
    const request = f.requests[0]; request.message.status_code = 307;
    const stream = input([]); request.callback(request.session, stream);
    await rejected;
    assert.equal(request.message.flags & 8, 8);
    assert.equal(f.requests.length, 1); assert.equal(stream.closed, true);
    client.dispose(); assert.equal(client.apiKey, '');
});

test('malformed PNG is rejected before constructing a network request', async () => {
    const f = fixture(), client = new f.OcrClient(f.config.get_string('api-url'));
    await assert.rejects(client.recognize({...options(f), png: new Uint8Array([1])}), /PNG/);
    assert.equal(f.requests.length, 0); client.dispose();
});

test('an empty/null EOF byte array is handled without treating success as a network error', async () => {
    const f = fixture(), client = new f.OcrClient(f.config.get_string('api-url'));
    const task = client.recognize(options(f));
    let count = 0;
    const stream = {
        read_bytes_async(_n, _p, _c, callback) {queueMicrotask(() => callback(stream, {}));},
        read_bytes_finish() {return {get_data: () => count++ === 0 ?
            new TextEncoder().encode('{"response":"ok","done":true}\n') : null};},
        close_async(_p, _c, callback) {callback(stream, {});}, close_finish() {},
    };
    f.requests[0].callback(f.requests[0].session, stream);
    assert.equal(await task, 'ok'); client.dispose();
});

test('many stream tokens in one read are coalesced into one visible update', async () => {
    const f = fixture(), client = new f.OcrClient(f.config.get_string('api-url'));
    const updates = [];
    const task = client.recognize({...options(f), onText: text => updates.push(text)});
    const body = Array.from({length: 50}, () => JSON.stringify({response: '字', done: false})).join('\n') +
        '\n{"response":"","done":true}\n';
    const stream = input([new TextEncoder().encode(body)]);
    f.requests[0].callback(f.requests[0].session, stream);
    assert.equal(await task, '字'.repeat(50));
    assert.equal(updates.length, 1);
    client.dispose();
});
