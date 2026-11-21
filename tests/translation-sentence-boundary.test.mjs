import {test} from 'node:test';
import assert from 'node:assert/strict';
import {translationPlan, translatedText} from '../popup-llm-officeassistent@yanjing_chen@qq.com/translation.js';
import {fixture} from './extension-fixture.mjs';
import {settle} from './mocks.mjs';

const parts = (source, limit) => translationPlan(source, limit).parts.map(part => part.source);
const roundTrip = (source, limit) => {
    const plan = translationPlan(source, limit);
    assert.equal(plan.parts.map(part => part.before + part.source).join('') + plan.suffix, source);
    for (const part of plan.parts) {
        assert.equal(source.slice(part.start, part.end), part.source);
        if (part.oversized) assert.equal(part.sentences, 1);
        else assert.ok(Array.from(part.source).length <= limit);
    }
    return plan;
};

test('one paragraph under the limit remains one request even with many complete sentences', () => {
    const source = '第一句。第二句！第三句？第四句；最后一句。';
    assert.deepEqual(parts(source, 500), [source]);
});

test('over-limit paragraph groups whole sentences; it never cuts on a space, comma or semicolon', () => {
    const source = 'One long sentence with many words, and even a semicolon; but still one complete sentence. ' +
        'The second full sentence follows. ' + 'And finally a third full sentence.';
    const plan = roundTrip(source, 92);
    assert.equal(plan.paragraphs, 1);
    assert.deepEqual(plan.parts.map(p => p.source), [
        'One long sentence with many words, and even a semicolon; but still one complete sentence. ',
        'The second full sentence follows. And finally a third full sentence.',
    ]);
    assert.equal(plan.parts[1].continuation, true);
});

test('even a 12000-character wordy sentence is never cut inside a sentence', () => {
    const first = 'This is an extremely long unpunctuated sentence ' + 'word '.repeat(3000) + 'finally ends. ';
    const last = 'A short sentence.';
    const plan = roundTrip(first + last, 300);
    assert.equal(plan.parts.length, 2);
    assert.equal(plan.parts[0].source, first);
    assert.equal(plan.parts[0].oversized, true);
    assert.equal(plan.oversizedSentences, 1);
    assert.equal(plan.parts[1].source, last);
});

test('paragraph without terminal punctuation is sent intact even if it is above the slider limit', () => {
    const source = '这段话没有句号但是包含大量内容'.repeat(100);
    const plan = roundTrip(source, 300);
    assert.deepEqual(plan.parts.map(p => p.source), [source]);
    assert.equal(plan.oversizedSentences, 1);
});

test('do not treat abbreviations, initials or decimal points as complete sentences', () => {
    const source = 'Dr. J. Smith wrote in 1632 about 3.14 units. Then another full sentence follows.';
    const plan = roundTrip(source, 47);
    assert.equal(plan.parts[0].source, 'Dr. J. Smith wrote in 1632 about 3.14 units. ');
    assert.equal(plan.parts[1].source, 'Then another full sentence follows.');
});

test('terminal punctuation stays with closing quotes and does not split at speech attributions', () => {
    const source = '"Wait!" she said. "Really?" he asked. The answer came.';
    assert.deepEqual(parts(source, 50), ['"Wait!" she said. "Really?" he asked. ', 'The answer came.']);
});

test('Han punctuation and emoji remain intact; no surrogate or composite word is split', () => {
    const source = '他写道：“这里有一个完整句子😀。”下一句在这里！最后一句？';
    const plan = roundTrip(source, 19);
    assert.deepEqual(plan.parts.map(p => p.source), ['他写道：“这里有一个完整句子😀。”', '下一句在这里！最后一句？']);
});

test('blank-line paragraphs preserve their own separators; single lines without blanks are paragraphs', () => {
    const chapter = '第一章\r\n\r\n这一段比较长。它还有第二句。第三句到此结束。\r\n\r\n第三段内容。';
    const plan = roundTrip(chapter, 17);
    assert.equal(plan.paragraphs, 3);
    assert.deepEqual(plan.parts.map(p => p.paragraph), [1, 2, 2, 3]);
    assert.equal(translatedText(plan, ['标题', '译句一。', '译句二。', '译句三。']),
        '标题\r\n\r\n译句一。译句二。\r\n\r\n译句三。');
    assert.equal(roundTrip('a\nb\nc', 100).paragraphs, 3);
});

test('same-paragraph Chinese subchunks join without invented line breaks', () => {
    const plan = roundTrip('第一句汉字多一点。第二句汉字也多一点。还有第三句。', 16);
    assert.equal(plan.parts.length, 2);
    assert.equal(translatedText(plan, ['译文一。\n', '\n译文二。']), '译文一。译文二。');
    assert.equal(translatedText(plan, ['译文一。\n'], '\n译文二'), '译文一。译文二');
});

test('same-paragraph Latin subchunks join with a natural space and do not merge words', () => {
    const plan = roundTrip('First full sentence. Second full sentence.', 21);
    assert.equal(plan.parts.length, 2);
    assert.equal(translatedText(plan, ['Translated first sentence.\n\n', '\nSecond translated sentence.']),
        'Translated first sentence. Second translated sentence.');
});

test('quoted Latin fragments retain a separating space while Chinese quotes do not', () => {
    const plan = roundTrip('This is a full first sentence. This is another full sentence.', 31);
    assert.equal(plan.parts.length, 2);
    assert.equal(translatedText(plan, ['He said \"Hello.\"', '\"Goodbye,\" she replied.']),
        'He said \"Hello.\" \"Goodbye,\" she replied.');
});

test('integration: preflighted chapter translates all sentences in original paragraph sequence', async () => {
    const paragraph = '长句'.repeat(170) + '。第二句。';
    const source = `标题\n\n${paragraph}\n\n结尾。`;
    const f = fixture();
    f.extension._showResultWindow(source, 'translate');
    f.config.values.set('translation-chunk-limit', 300);
    await f.extension._callLLMAPI(source, 'translate');
    const task = f.extension._activeRequest.task;
    const plan = roundTrip(source, 300);
    assert.deepEqual(plan.parts.map(p => p.paragraph), [1, 2, 2, 3]);
    assert.equal(f.requests.length, 1);
    for (let index = 0; index < plan.parts.length; index++) {
        assert.equal(f.requests[index].message.payload.messages[1].content, plan.parts[index].source);
        f.reply(index, ['Title', 'First full translated sentence.', 'Second.', 'End'][index]);
        await settle();
    }
    await task;
    assert.equal(f.extension._resultLabel.text,
        'Title\n\nFirst full translated sentence. Second.\n\nEnd');
    assert.match(f.extension._translationStatus.text, /原文 3 段/);
    assert.match(f.extension._translationStatus.text, /超限长句保留完整/);
});
