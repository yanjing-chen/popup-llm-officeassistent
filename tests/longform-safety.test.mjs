import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './extension-fixture.mjs';
import {prefsFixture} from './preferences-fixture.mjs';
import {settle} from './mocks.mjs';
import {translationPlan, longFormText} from '../popup-llm-officeassistent@yanjing_chen@qq.com/translation.js';
import {migrateIndependentChunkLimits} from '../popup-llm-officeassistent@yanjing_chen@qq.com/backendUtils.js';
import {settings} from './mocks.mjs';

const original = '第一段开头。下一句收尾。\n\n第二段开头。第二段结尾。';

function reply(f, index, content, reason = 'stop') {
    const request = f.requests[index];
    request.callback(request.session, {choices: [{message: {content}, finish_reason: reason}]});
}

const plans = [
    ['polish', ['润色一。', '润色二。'], '润色一。\n\n润色二。'],
    ['explain', ['解释一。', '解释二。'], '【原文第 1 段 · 第 1/2 块】\n解释一。\n\n【原文第 2 段 · 第 2/2 块】\n解释二。'],
];

for (const [action, completed, expected] of plans) {
    test(`${action}: two paragraphs issue two requests and assemble every response`, async () => {
        const f = fixture(); f.extension._showResultWindow(original, action);
        await f.extension._callLLMAPI(original, action);
        const task = f.extension._activeRequest.task;
        assert.equal(f.requests.length, 1);
        assert.match(f.extension._translationStatus.text, /1\/2/);
        for (let i = 0; i < 2; i++) {
            assert.equal(f.requests[i].message.payload.messages[1].content, original.split('\n\n')[i]);
            reply(f, i, completed[i]); await settle();
        }
        await task;
        assert.equal(f.requests.length, 2);
        assert.equal(f.extension._resultLabel.text, expected);
        assert.match(f.extension._translationStatus.text, /完成 2\/2/);
        assert.deepEqual(f.begins, ['old-model']); assert.deepEqual(f.finishes, ['old-model']);
    });
    test(`${action}: truncation aborts subsequent fragments and keeps prefix with explicit incomplete label`, async () => {
        const f = fixture(); f.extension._showResultWindow(original, action);
        await f.extension._callLLMAPI(original, action);
        const task = f.extension._activeRequest.task;
        reply(f, 0, completed[0]); await settle();
        reply(f, 1, 'unfinished middle', 'length'); await task;
        assert.equal(f.requests.length, 2);
        assert.match(f.extension._resultLabel.text, new RegExp(completed[0]));
        assert.match(f.extension._resultLabel.text, /第 2\/2 块.*未完成/);
        assert.match(f.extension._resultLabel.text, /unfinished middle/);
        assert.match(f.extension._translationStatus.text, /未完成/);
    });
}

test('polishing a long single paragraph only separates whole sentences and rejoins without newline', async () => {
    const source = '第一句完整结束。第二句完整结束。第三句完整结束。';
    const f = fixture(); f.config.values.set('polish-chunk-limit', 16);
    await f.extension._callLLMAPI(source, 'polish');
    const task = f.extension._activeRequest.task;
    const plan = translationPlan(source, 16);
    assert.ok(plan.parts.length > 1);
    for (let i = 0; i < plan.parts.length; i++) {
        assert.equal(f.requests[i].message.payload.messages[1].content, plan.parts[i].source);
        reply(f, i, `Revised sentence ${i + 1}.`); await settle();
    }
    await task;
    assert.ok(!f.extension._resultLabel.text.includes('\n'));
    assert.equal(f.extension._resultLabel.text, plan.parts.map((_, i) => `Revised sentence ${i + 1}.`).join(' '));
});

test('overlong single sentence is preserved for polish and explanation', async () => {
    const source = 'longword '.repeat(1500) + 'ends.';
    for (const action of ['polish', 'explain']) {
        const f = fixture(); f.config.values.set(action === 'polish' ? 'polish-chunk-limit' : 'explain-chunk-limit', 300);
        await f.extension._callLLMAPI(source, action);
        const task = f.extension._activeRequest.task;
        assert.equal(f.requests.length, 1);
        assert.equal(f.requests[0].message.payload.messages[1].content, source);
        reply(f, 0, 'finished'); await task;
        assert.equal(f.extension._resultLabel.text, 'finished');
    }
});

test('explanation fragment labels make source paragraph and chunk traceable', () => {
    const plan = translationPlan('第一句。第二句。第三句。', 16);
    assert.equal(longFormText(plan, ['解答'], '临时', 'explain'), '解答');
    const two = translationPlan('甲。\n\n乙。', 300);
    assert.match(longFormText(two, ['A', 'B'], '', 'explain'), /第 1 段[\s\S]*A[\s\S]*第 2 段[\s\S]*B/);
});

test('three independent native SpinRows each save the right setting in their own feature', async () => {
    // Upgrading from v2.3.4 with a custom shared limit should initialize all
    // three to that prior value, and then each may be edited independently.
    const f = prefsFixture({values: {'translation-chunk-limit': 2400}}); await settle();
    const items = [
        ['翻译单块字符软上限', 'translation-chunk-limit', '启用“智能翻译” (Enable Translation)', 3200],
        ['解释单块字符软上限', 'explain-chunk-limit', '启用“核心解释” (Enable Explanation)', 700],
        ['润色单块字符软上限', 'polish-chunk-limit', '启用“文字润色” (Enable Polishing)', 1100],
    ];
    for (const [title, key, parent, updated] of items) {
        const row = f.byTitle(title);
        assert.ok(row, title);
        assert.equal(row.get_value(), 2400);
        assert.equal(row.digits, 0);
        assert.equal(row.adjustment.lower, 300);
        assert.equal(row.adjustment.upper, 12000);
        assert.equal(row.adjustment.step_increment, 100);
        assert.equal(row.parent.title, parent);
        row.set_value(updated);
        assert.equal(f.config.get_int(key), updated);
        assert.deepEqual(f.config.writes.at(-1), [key, updated]);
    }
    assert.equal(f.config.get_int('translation-chunk-limit'), 3200);
    assert.equal(f.config.get_int('explain-chunk-limit'), 700);
    assert.equal(f.config.get_int('polish-chunk-limit'), 1100);
    assert.equal(f.config.get_boolean('independent-chunk-limits-initialized'), true);
});

test('one-time migration preserves previous shared limit, never overwrites independent choices', () => {
    const settingsOld = settings();
    settingsOld.set_int('translation-chunk-limit', 2700);
    settingsOld.set_int('explain-chunk-limit', 1600); // an existing per-tool choice
    assert.equal(migrateIndependentChunkLimits(settingsOld), true);
    assert.equal(settingsOld.get_int('translation-chunk-limit'), 2700);
    assert.equal(settingsOld.get_int('explain-chunk-limit'), 1600);
    assert.equal(settingsOld.get_int('polish-chunk-limit'), 2700);
    settingsOld.set_int('translation-chunk-limit', 3100);
    assert.equal(migrateIndependentChunkLimits(settingsOld), false);
    assert.equal(settingsOld.get_int('explain-chunk-limit'), 1600);
    assert.equal(settingsOld.get_int('polish-chunk-limit'), 2700);
    assert.equal(settingsOld.writes.filter(([key]) => key === 'polish-chunk-limit').length, 1);
});

test('translation, polishing and explanation use their own request limit, not shared setting', async () => {
    const source = '这是一个完整的测试句子。'.repeat(85);
    for (const [action, limit] of [['translate', 300], ['polish', 500], ['explain', 1200]]) {
        const f = fixture();
        f.config.values.set('translation-chunk-limit', 300);
        f.config.values.set('polish-chunk-limit', 500);
        f.config.values.set('explain-chunk-limit', 1200);
        f.extension._showResultWindow(source, action);
        await f.extension._callLLMAPI(source, action);
        const task = f.extension._activeRequest.task;
        const planned = translationPlan(source, limit);
        assert.ok(planned.parts.length >= 1);
        for (const [i, part] of planned.parts.entries()) {
            assert.equal(f.requests.length, i + 1, action);
            assert.equal(f.requests[i].message.payload.messages[1].content, part.source);
            reply(f, i, `Reply ${i + 1}.`);
            await settle();
        }
        await task;
        assert.equal(f.requests.length, planned.parts.length, action);
        assert.match(f.extension._translationStatus.text, /完成/);
    }
});

for (const action of ['mail', 'qa', 'custom']) {
    test(`${action}: length stop shows an explicit incomplete message, retains partial and releases model`, async () => {
        const f = fixture();
        await f.extension._callLLMAPI('source', action);
        const task = f.extension._activeRequest.task;
        reply(f, 0, 'partial response', 'length');
        await task;
        assert.equal(f.requests.length, 1);
        assert.match(f.extension._resultLabel.text, /处理未完成/);
        assert.match(f.extension._resultLabel.text, /输出限制/);
        assert.match(f.extension._resultLabel.text, /partial response/);
        assert.deepEqual(f.finishes, ['old-model']);
        if (action === 'qa') {
            assert.equal(f.extension._qaHistory.length, 1);
            assert.equal(f.extension._lastLLMResponse, '');
        }
    });
    test(`${action}: a normal finish leaves the original single-call behavior`, async () => {
        const f = fixture(); await f.extension._callLLMAPI('source', action);
        const task = f.extension._activeRequest.task;
        reply(f, 0, 'complete'); await task;
        assert.equal(f.requests.length, 1);
        assert.equal(f.extension._resultLabel.text, action === 'qa' ? '答：complete' : 'complete');
    });
}

test('custom SSE stream with explicit length stop never looks like success', async () => {
    const f = fixture({stream: true});
    await f.extension._callLLMAPI('source', 'custom');
    const task = f.extension._activeRequest.task;
    const stream = {lines: [
        'data: {"choices":[{"delta":{"content":"partial"}}]}', '',
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}', '',
        'data: [DONE]', ''], close() {this.closed = true;}};
    f.requests[0].callback(f.requests[0].session, stream);
    await task;
    assert.match(f.extension._resultLabel.text, /处理未完成/);
    assert.match(f.extension._resultLabel.text, /partial/);
});
