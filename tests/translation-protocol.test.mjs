import {test} from 'node:test';
import assert from 'node:assert/strict';
import {translationPlan, translatedText, translationPrompt, TranslationResponse}
    from '../popup-llm-officeassistent@yanjing_chen@qq.com/translation.js';

const encoded = value => new TextEncoder().encode(value);
const record = (content, finish_reason = null) => JSON.stringify({choices: [{index: 0, delta: {content}, finish_reason}]});
const stream = (...texts) => texts.map(text => `data: ${record(text)}\n\n`).join('') + 'data: [DONE]\n\n';
const complete = (content, finish_reason = 'stop') => JSON.stringify({choices: [{message: {content}, finish_reason}]});

for (const source of ['', ' \n\t', '首段。\n\n中间段不能消失。\n\n最后一段。',
    '\r\n  第一段\r\n\r\n第二段\r\n', 'A\r\nB\r\nC', 'A\rB\rC',
    'wrapped line\ncontinued line\n\nnext paragraph',
    '😀中e\u0301 العربية Nederlands。'.repeat(850), 'same\n\nsame\n\nsame',
    ' '.repeat(3000) + 'text' + ' '.repeat(3000)]) {
    test(`translation plan round-trips every source byte: ${JSON.stringify(source.slice(0, 35))}`, () => {
        const plan = translationPlan(source);
        assert.equal(plan.parts.map(p => p.before + p.source).join('') + plan.suffix, source);
        for (const part of plan.parts) {
            assert.equal(source.slice(part.start, part.end), part.source);
            assert.ok(part.source.trim());
            assert.ok(Array.from(part.source).length <= 1400 || part.oversized,
                'the limit may be exceeded only for a complete long sentence');
            if (part.oversized) assert.equal(part.sentences, 1);
            assert.ok(!/[\uD800-\uDBFF]$/.test(part.source));
            assert.ok(!/^[\uDC00-\uDFFF]/.test(part.source));
        }
    });
}

test('real blank paragraphs retain wrapped lines; a single CRLF is not two newlines', () => {
    assert.equal(translationPlan('a\nb\n\nc').parts.length, 2);
    assert.equal(translationPlan('a\r\nb\r\nc').parts.length, 3);
    assert.equal(translationPlan('a\r\nb\r\n\r\nc').parts.length, 2);
});
test('repeated paragraphs are independently sent and never deduplicated', () => {
    const plan = translationPlan('a\n\na\n\na');
    assert.equal(plan.parts.length, 3);
    assert.equal(translatedText(plan, ['一', '一', '一']), '一\n\n一\n\n一');
    assert.equal(translatedText(plan, ['一'], '正在译二'), '一\n\n正在译二');
});
test('long single paragraphs split at boundaries with exact contiguous source coverage', () => {
    const source = 'Sentence one. 第二句完整保留。 '.repeat(220);
    const plan = translationPlan(source);
    assert.ok(plan.parts.length > 3);
    assert.equal(plan.parts.map(p => p.source).join(''), source);
    assert.ok(plan.parts.slice(1).every(p => p.continuation));
});
test('bad input is explicit instead of silently dropping the selection', () => {
    assert.throws(() => translationPlan(null));
    assert.throws(() => translationPlan('text', 0));
});
test('translation prompt retains user language/style and demands full current-fragment output', () => {
    const prompt = translationPrompt('Target Dutch; academic style.', 2, 8);
    assert.match(prompt, /Target Dutch; academic style/);
    assert.match(prompt, /3\/8/);
    assert.match(prompt, /Do not summarize, omit/);
});

test('all UTF-8 and JSON byte boundaries preserve Chinese and every middle paragraph', () => {
    const text = ['第一段。\n\n', '中间 😀 e\u0301 العربية 段落。\n\n', '末段。'];
    const parser = new TranslationResponse(true);
    for (const byte of encoded(stream(...text))) parser.push(new Uint8Array([byte]));
    assert.equal(parser.finish(), text.join(''));
    assert.equal(parser.frames, 3);
});
test('SSE multiline JSON, CRLF, comments and usage events are parsed as complete records', () => {
    const json = JSON.stringify({choices: [{delta: {content: '中间不丢'}}]}, null, 2);
    const data = ': keepalive\r\nevent: message\r\nid: 12\r\n' +
        json.split('\n').map(line => 'data: ' + line).join('\r\n') + '\r\n\r\n' +
        'data: {"choices":[],"usage":{"total_tokens":10}}\n\n' + 'data: [DONE]\n\n';
    const parser = new TranslationResponse(true); parser.push(encoded(data));
    assert.equal(parser.finish(), '中间不丢');
});
test('compatible newline-only records without blank SSE separators are not lost', () => {
    const parser = new TranslationResponse(true);
    parser.push(encoded(`data: ${record('first ')}\ndata: ${record('middle ')}\ndata: ${record('last')}\ndata:[DONE]`));
    assert.equal(parser.finish(), 'first middle last');
});
test('a malformed middle record is an error, not a successful missing paragraph', () => {
    const parser = new TranslationResponse(true);
    assert.throws(() => parser.push(encoded(`data: ${record('first')}\n\ndata: {malformed}\n\ndata: ${record('last')}\n\n`)),
        error => error.translationCode === 'INVALID_JSON');
    assert.equal(parser.content, 'first');
});
test('EOF without a completion marker is not silently treated as success', () => {
    const parser = new TranslationResponse(true); parser.push(encoded(`data: ${record('partial')}\n\n`));
    assert.throws(() => parser.finish(), error => error.translationCode === 'INCOMPLETE');
    assert.equal(parser.text, 'partial');
});
test('a terminal stop record can complete an otherwise valid stream without DONE', () => {
    const parser = new TranslationResponse(true); parser.push(encoded(`data: ${record('complete', 'stop')}\n\n`));
    assert.equal(parser.finish(), 'complete');
});
for (const streaming of [false, true]) {
    test(`output-limit completion is explicit, stream=${streaming}`, () => {
        const parser = new TranslationResponse(streaming);
        parser.push(encoded(streaming ? `data: ${record('partial', 'length')}\n\ndata:[DONE]\n\n` : complete('partial', 'length')));
        assert.throws(() => parser.finish(), error => error.translationCode === 'OUTPUT_LIMIT');
    });
    test(`empty/reasoning-only output cannot pass for translation, stream=${streaming}`, () => {
        const parser = new TranslationResponse(streaming, true);
        const choice = streaming ? {delta: {reasoning_content: 'thought'}, finish_reason: 'stop'} :
            {message: {reasoning_content: 'thought'}, finish_reason: 'stop'};
        const data = JSON.stringify({choices: [choice]});
        parser.push(encoded(streaming ? `data:${data}\n\ndata:[DONE]\n\n` : data));
        assert.throws(() => parser.finish(), error => error.translationCode === 'EMPTY_TRANSLATION');
    });
}
test('nonstream pretty JSON is read as one document, including embedded paragraph breaks', () => {
    const parser = new TranslationResponse(false);
    const content = '第一段\n\n中间段\n\n最后段';
    parser.push(encoded(JSON.stringify(JSON.parse(complete(content)), null, 2)));
    assert.equal(parser.finish(), content);
});
test('think filtering never deletes a translated XML section in the middle', () => {
    const parser = new TranslationResponse(false, false);
    parser.push(encoded(complete('first\n<think>quoted source</think>\nlast')));
    assert.equal(parser.finish(), 'first\n<think>quoted source</think>\nlast');
});
test('only a leading legacy think block is hidden when reasoning is disabled', () => {
    const parser = new TranslationResponse(false, false);
    parser.push(encoded(complete('<think>private thought</think>\n译文。')));
    assert.equal(parser.finish(), '译文。');
});
test('multiple-choice SSE does not append other completions into the translation', () => {
    const parser = new TranslationResponse(true);
    parser.push(encoded('data:' + JSON.stringify({choices: [{index: 1, delta: {content: 'other'}},
        {index: 0, delta: {content: 'correct'}}]}) + '\n\ndata:[DONE]\n\n'));
    assert.equal(parser.finish(), 'correct');
});
test('model-provided text arrays are validated and preserved', () => {
    const parser = new TranslationResponse(false);
    parser.push(encoded(complete([{type: 'text', text: '中'}, {type: 'text', text: '文'}])));
    assert.equal(parser.finish(), '中文');
});
test('invalid UTF-8 is not replaced and silently accepted', () => {
    const parser = new TranslationResponse(true);
    assert.throws(() => parser.push(new Uint8Array([...encoded('data:"'), 255, ...encoded('"\n') ])),
        error => error.translationCode === 'INVALID_UTF8');
});
test('raw response limit is checked before allocating unbounded Shell text', () => {
    assert.throws(() => new TranslationResponse(true).push(new Uint8Array(16 * 1024 * 1024 + 1)), /上限/);
});
