import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './extension-fixture.mjs';
import {settle} from './mocks.mjs';
import {input} from './ocr-fixture.mjs';

const source = '第一段原文。\n\n中间第二段，不能漏掉。\n\n第三段原文。';
const rawReply = (f, index, content, finish_reason = 'stop') => {
    const request = f.requests[index];
    request.callback(request.session, {choices: [{message: {content}, finish_reason}]});
};

test('every source paragraph is requested once in order and all completions are assembled', async () => {
    const f = fixture(); await f.extension._callLLMAPI(source, 'translate');
    const task = f.extension._activeRequest.task;
    assert.equal(f.requests.length, 1);
    for (const [index, text] of source.split('\n\n').entries()) {
        assert.equal(f.requests[index].message.payload.messages[1].content, text);
        assert.equal(f.requests[index].message.payload.model, 'old-model');
        assert.equal(f.requests[index].message.payload.temperature, 0.3);
        rawReply(f, index, `译文${index + 1}`); await settle();
        if (index < 2) assert.deepEqual(f.finishes, []);
    }
    await task;
    assert.equal(f.extension._resultLabel.text, '译文1\n\n译文2\n\n译文3');
    assert.deepEqual(f.begins, ['old-model']); assert.deepEqual(f.finishes, ['old-model']);
    assert.equal(f.extension._activeRequest, null);
});
test('identical source paragraphs and identical translations are never deduplicated', async () => {
    const f = fixture(); await f.extension._callLLMAPI('same\n\nsame\n\nsame', 'translate');
    const task = f.extension._activeRequest.task;
    for (let i = 0; i < 3; i++) {f.reply(i, '同'); await settle();}
    await task;
    assert.equal(f.requests.length, 3);
    assert.equal(f.extension._resultLabel.text, '同\n\n同\n\n同');
});
test('a model which returns an empty middle answer cannot skip it and report complete', async () => {
    const f = fixture(); await f.extension._callLLMAPI(source, 'translate');
    const task = f.extension._activeRequest.task;
    f.reply(0, 'first'); await settle(); f.reply(1, ''); await task;
    assert.equal(f.requests.length, 2); assert.match(f.extension._resultLabel.text, /first/);
    assert.match(f.extension._resultLabel.text, /第 2\/3 段未完成/);
    assert.deepEqual(f.finishes, ['old-model']);
});
test('a middle output-limit stop retains confirmed output, marks the failed part and stops', async () => {
    const f = fixture(); await f.extension._callLLMAPI(source, 'translate');
    const task = f.extension._activeRequest.task;
    f.reply(0, 'first'); await settle(); rawReply(f, 1, 'partial middle', 'length'); await task;
    assert.equal(f.requests.length, 2);
    assert.match(f.extension._resultLabel.text, /first[\s\S]*第 2\/3 段未完成[\s\S]*partial middle/);
});
test('a malformed middle SSE record is reported rather than showing first+last as full output', async () => {
    const f = fixture({stream: true}); await f.extension._callLLMAPI('one paragraph', 'translate');
    const task = f.extension._activeRequest.task;
    const data = 'data:{"choices":[{"delta":{"content":"first "}}]}\n\n' +
        'data:{bad middle}\n\ndata:{"choices":[{"delta":{"content":"last"}}]}\n\ndata:[DONE]\n\n';
    const body = input([new TextEncoder().encode(data)]);
    f.requests[0].callback(f.requests[0].session, body); await task;
    assert.match(f.extension._resultLabel.text, /未完成/);
    assert.doesNotMatch(f.extension._resultLabel.text, /last/); assert.equal(body.closed, true);
});
test('closing between paragraphs cancels the current request, never starts another and balances one lease', async () => {
    const f = fixture(); await f.extension._callLLMAPI(source, 'translate');
    const task = f.extension._activeRequest.task;
    f.reply(0, 'first'); await settle(); f.extension._closeUI();
    assert.equal(f.requests[1].cancellable.cancelled, true);
    f.reply(1, 'late middle'); await task;
    assert.equal(f.requests.length, 2); assert.equal(f.extension._resultLabel, null);
    assert.deepEqual(f.finishes, ['old-model']);
});
test('retranslation invalidates pending old fragments without overwriting the new answer', async () => {
    const f = fixture(); await f.extension._callLLMAPI(source, 'translate');
    const old = f.extension._activeRequest.task;
    await f.extension._callLLMAPI('new source', 'translate');
    const current = f.extension._activeRequest.task;
    f.reply(1, 'new answer'); f.reply(0, 'late first'); await Promise.all([old, current]);
    assert.equal(f.extension._resultLabel.text, 'new answer'); assert.equal(f.requests.length, 2);
    assert.deepEqual(f.finishes, ['old-model', 'old-model']);
});
test('privacy-safe diagnostics include part counts but never original text, URLs or API keys', async () => {
    const f = fixture(); f.config.values.set('api-key', 'SECRET_API_KEY');
    await f.extension._callLLMAPI('PRIVATE_SOURCE_TEXT', 'translate');
    const task = f.extension._activeRequest.task;
    f.reply(0, 'PRIVATE_TRANSLATION'); await task;
    assert.match(f.logs.join('\n'), /part=1\/1/);
    assert.doesNotMatch(f.logs.join('\n'), /SECRET_API_KEY|PRIVATE_SOURCE_TEXT|PRIVATE_TRANSLATION|http:/);
});

test('a real progress label stays outside the copyable translation', async () => {
    const f = fixture(); f.extension._showResultWindow(source, 'translate');
    await f.extension._callLLMAPI(source, 'translate'); const task = f.extension._activeRequest.task;
    assert.match(f.extension._translationStatus.text, /1\/3/);
    for (let i = 0; i < 3; i++) {f.reply(i, `part${i}`); await settle();}
    await task;
    assert.match(f.extension._translationStatus.text, /完成 3\/3/);
    const copy = f.extension._resultContainer.children[0].children.find(child => child.style_class === 'translator-copy-btn');
    copy.emit('clicked');
    assert.equal(f.clipboardWrites.at(-1).text, 'part0\n\npart1\n\npart2');
    assert.doesNotMatch(f.clipboardWrites.at(-1).text, /3\/3|翻译完成/);
});
