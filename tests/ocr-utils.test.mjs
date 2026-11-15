import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requireOcrModel, localOllamaEndpoint, pngInfo,
    ocrPayload, OcrStream, OCR_PROMPT, MAX_OCR_IMAGE_BYTES, MAX_OCR_RESPONSE_BYTES}
    from '../popup-llm-officeassistent@yanjing_chen@qq.com/ocrUtils.js';
import {image} from './ocr-fixture.mjs';

const model = 'seriouswebby/paddleocr-vl-1.6:spotting';
const catalog = ids => ids.map(id => ({id, label: id}));

test('OCR requires an actual explicitly selected model and never guesses an example or replacement', () => {
    assert.throws(() => requireOcrModel(catalog(['qwen3.5:9b']), model), /已不在/);
    assert.throws(() => requireOcrModel(catalog([model])), /尚未选择/);
    assert.equal(requireOcrModel(catalog([model]), model), model);
    assert.throws(() => requireOcrModel(catalog([model]), 'removed-name'), /已不在/);
    assert.throws(() => requireOcrModel([], model), /尚未安装/);
});

test('multiple installed Paddle models require a genuine selection rather than first-item guessing', () => {
    const rows = catalog([model, 'paddleocr-vl:latest']);
    assert.throws(() => requireOcrModel(rows), /尚未选择/);
    assert.equal(requireOcrModel(rows, model), model);
    assert.throws(() => requireOcrModel(rows, 'not-installed'), /已不在/);
});

test('future OCR model names need not contain PaddleOCR-VL', () => {
    const future = 'new-vision-ocr:latest';
    assert.equal(requireOcrModel(catalog([future, model]), future), future);
});

for (const endpoint of ['http://127.0.0.1:11434/v1/chat/completions', 'http://localhost:11434/v1/chat/completions',
    'http://[::1]:11434/v1/chat/completions', 'http://localhost:11434/local/v1/chat/completions']) {
    test(`OCR derives a loopback-only Ollama endpoint from ${endpoint}`, () => {
        assert.equal(localOllamaEndpoint(endpoint), endpoint.replace('/v1/chat/completions', '/api/generate'));
    });
}

for (const endpoint of ['https://example.com/v1/chat/completions', 'http://192.168.1.2:11434/v1/chat/completions',
    'http://localhost.evil:11434/v1/chat/completions', 'http://user@localhost:11434/v1/chat/completions',
    'http://127.0.0.1:0/v1/chat/completions', 'http://localhost:65536/v1/chat/completions',
    'http://localhost:11434/v1/chat/completions?redirect=cloud', 'http://localhost:11434/api/chat']) {
    test(`OCR never sends screenshot to unsafe/mismatched endpoint ${endpoint}`, () => {
        assert.throws(() => localOllamaEndpoint(endpoint), /OCR/);
    });
}

test('original PNG geometry is validated independently of the preview scale', () => {
    assert.deepEqual(pngInfo(image().png), {width: 1, height: 1});
    for (const data of [new Uint8Array(), new Uint8Array(33), new Uint8Array(MAX_OCR_IMAGE_BYTES + 1)])
        assert.throws(() => pngInfo(data), /PNG/);
    const huge = image().png.slice(); huge.set([0, 1, 0, 0], 16);
    assert.throws(() => pngInfo(huge), /尺寸/);
});

test('OCR payload uses official prompt, original encoded image, temperature zero and no language/chat/think instruction', () => {
    const payload = ocrPayload(model, 'original-image', OCR_PROMPT, true, 60);
    assert.deepEqual(payload, {model, prompt: 'OCR:', images: ['original-image'], stream: true,
        options: {temperature: 0}, keep_alive: 60});
    assert.deepEqual(ocrPayload(model, 'x', 'OCR:', false, 0).keep_alive, 0);
    assert.throws(() => ocrPayload(model, 'x', ' ', true, 60), /提示词/);
    assert.throws(() => ocrPayload(model, 'x', 'x'.repeat(2049), true, 60), /提示词/);
});

test('NDJSON decoding survives every UTF-8/JSON byte boundary and preserves mixed languages verbatim', () => {
    const original = '中文 Nederlands العربية 😀\n第二行';
    const bytes = new TextEncoder().encode(JSON.stringify({response: original, done: false}) + '\n' +
        JSON.stringify({response: '!', done: true}));
    const updates = [], parser = new OcrStream(value => updates.push(value));
    for (const value of bytes) parser.push(new Uint8Array([value]));
    assert.equal(parser.finish(), original + '!');
    assert.equal(updates.at(-1), original + '!');
});

test('nonstream Ollama object uses the same done guard and does not require a newline', () => {
    const parser = new OcrStream();
    parser.push(new TextEncoder().encode('{"response":"plain text","done":true}'));
    assert.equal(parser.finish(), 'plain text');
});

test('nonstream JSON may include legal whitespace/newlines without being mistaken for NDJSON', () => {
    const parser = new OcrStream(() => {}, false);
    parser.push(new TextEncoder().encode(JSON.stringify({response: 'text', done: true}, null, 2)));
    assert.equal(parser.finish(), 'text');
});

for (const [body, pattern] of [
    ['{"response":"incomplete","done":false}\n', /中断/],
    ['not-json\n', /无效/],
    ['{"error":"private server detail"}\n', /拒绝/],
    ['{"done":true}\n{"response":"late"}\n', /完成后/],
]) {
    test(`OCR response guard: ${pattern}`, () => {
        const parser = new OcrStream();
        assert.throws(() => {parser.push(new TextEncoder().encode(body)); parser.finish();}, pattern);
    });
}

test('response size is bounded before unbounded text can enter Shell labels', () => {
    assert.throws(() => new OcrStream().push(new Uint8Array(MAX_OCR_RESPONSE_BYTES + 1)), /上限/);
});

for (const body of ['null', '[]', '17', '{"response":17,"done":true}']) {
    test(`invalid OCR response structure is distinguished from a transport failure: ${body}`, () => {
        const parser = new OcrStream();
        assert.throws(() => {parser.push(new TextEncoder().encode(body)); parser.finish();},
            error => error.ocrCode === 'INVALID_RESPONSE');
    });
}

test('incomplete or invalid UTF-8 is rejected with a decoder code instead of a connection diagnosis', () => {
    const parser = new OcrStream();
    parser.push(new Uint8Array([0xe4, 0xb8]));
    assert.throws(() => parser.finish(), error => error.ocrCode === 'DECODE_FAILED');
});

test('an unbroken JSON line keeps bounded byte storage even across many tiny chunks', () => {
    const parser = new OcrStream();
    const text = '字'.repeat(15000);
    const bytes = new TextEncoder().encode(JSON.stringify({response: text, done: true}));
    for (let offset = 0; offset < bytes.length; offset += 3) parser.push(bytes.subarray(offset, offset + 3));
    assert.ok(parser.pending.length <= MAX_OCR_RESPONSE_BYTES);
    assert.equal(parser.finish(), text);
});
