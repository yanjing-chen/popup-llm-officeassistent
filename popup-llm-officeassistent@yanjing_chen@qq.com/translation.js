// Pure translation planning and protocol validation. No UI, credentials or logs.
export function translationError(code, message) {
    const error = new Error(message);
    error.translationCode = code;
    return error;
}

// Plan the *entire* chapter before sending any request. The configured value is
// a soft limit: an individual sentence may exceed it, but is NEVER cut in half.
// Only recognised terminal sentence punctuation can produce an internal split.
const SENTENCE_END = new Set(['。', '！', '？', '.', '!', '?']);
const SENTENCE_CLOSERS = new Set(['"', "'", '”', '’', '）', ')', ']', '】', '』', '」', '》']);
const ABBREVIATIONS = new Set([
    'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g',
    'i.e', 'cf', 'ca', 'approx', 'fig', 'figs', 'no', 'nos', 'vol', 'vols',
    'p', 'pp', 'ed', 'eds', 'rev', 'dept', 'jan', 'feb', 'mar', 'apr',
    'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);

function isInternalPeriod(points, index) {
    const previous = points[index - 1] || '';
    const following = points[index + 1] || '';
    // Decimal numbers, URLs, filenames and initials are not sentence breaks.
    if (/^[0-9]$/.test(previous) && /^[0-9]$/.test(following))
        return true;
    if (/^[A-Za-z]$/.test(previous) && /^[A-Za-z0-9]$/.test(following))
        return true;
    let start = index - 1;
    while (start >= 0 && /[A-Za-z]/.test(points[start])) start--;
    const word = points.slice(start + 1, index).join('').toLowerCase();
    if (!word) return false;
    let hasFollowingText = false;
    for (let next = index + 1; next < points.length; next++) {
        if (!/\s/u.test(points[next])) { hasFollowingText = true; break; }
    }
    if (!hasFollowingText) return false;
    if (word.length === 1 || ABBREVIATIONS.has(word))
        return true;
    // Dotted abbreviations such as e.g., i.e., U.S.A. and their continuations.
    const prefix = points.slice(Math.max(0, index - 12), index).join('');
    return /(?:[A-Za-z]\.\s*)+[A-Za-z]$/u.test(prefix);
}

function sentenceBoundaries(points) {
    const boundaries = [];
    for (let index = 0; index < points.length; index++) {
        const character = points[index];
        if (!SENTENCE_END.has(character) || (character === '.' && isInternalPeriod(points, index)))
            continue;
        let end = index + 1;
        // Treat ?!, ..., repeated Chinese punctuation and trailing closing
        // quotation marks as belonging to the SAME complete sentence.
        while (end < points.length && SENTENCE_END.has(points[end])) end++;
        const punctuationEnd = end;
        while (end < points.length && SENTENCE_CLOSERS.has(points[end])) end++;
        const hasClosingQuote = end > punctuationEnd;
        let followingText = '';
        for (let next = end; next < points.length; next++) {
            if (!/\s/u.test(points[next])) { followingText = points[next]; break; }
        }
        // "Stop!" she said / "Wait..." he thought are still one sentence.
        if (hasClosingQuote && /^[a-z]$/u.test(followingText)) {
            index = end - 1;
            continue;
        }
        // An ellipsis followed by lowercase text may be a mid-sentence pause.
        if (points.slice(index, punctuationEnd).filter(c => c === '.').length >= 2 &&
            /^[a-z]$/u.test(followingText)) {
            index = end - 1;
            continue;
        }
        while (end < points.length && /\s/u.test(points[end])) end++;
        if (end < points.length) boundaries.push(end);
        index = end - 1;
    }
    boundaries.push(points.length);
    return boundaries;
}

function paragraphChunks(value, maxCharacters) {
    const points = Array.from(value);
    const offsets = [0];
    for (const point of points) offsets.push(offsets.at(-1) + point.length);
    const boundaries = sentenceBoundaries(points);
    const chunks = [];
    let start = 0, end = 0, count = 0;
    const flush = () => {
        if (end === start) return;
        chunks.push({source: value.slice(offsets[start], offsets[end]),
            start: offsets[start], end: offsets[end], oversized: end - start > maxCharacters,
            sentences: count});
        start = end;
        count = 0;
    };
    for (const boundary of boundaries) {
        if (boundary - start > maxCharacters && end > start)
            flush();
        end = boundary;
        count++;
        // An over-limit sentence stays intact as an exceptional single chunk.
        if (end - start > maxCharacters) flush();
    }
    flush();
    return chunks;
}

export function translationPlan(text, maxCharacters = 1400) {
    if (typeof text !== 'string' || !Number.isInteger(maxCharacters) || maxCharacters < 16)
        throw translationError('INVALID_INPUT', '翻译原文或分段大小无效。');
    // Blank lines delimit real paragraphs when present. Otherwise single line
    // breaks delimit paragraphs. Original separators are preserved byte-for-byte.
    const blankLines = /(?:\r\n|\r(?!\n)|\n)[\t ]*(?:\r\n|\r(?!\n)|\n)/.test(text);
    const separator = blankLines ? /((?:\r\n|\r(?!\n)|\n)[\t ]*(?:(?:\r\n|\r(?!\n)|\n)[\t ]*)+)/g :
        /((?:\r\n|\r|\n)+)/g;
    const spans = text.split(separator);
    const parts = [];
    let before = '', offset = 0, paragraph = 0, oversizedSentences = 0;
    for (let span = 0; span < spans.length; span++) {
        const value = spans[span];
        if (span % 2 || !value.trim()) {
            before += value;
            offset += value.length;
            continue;
        }
        paragraph++;
        const chunks = paragraphChunks(value, maxCharacters);
        for (const [index, chunk] of chunks.entries()) {
            if (!chunk.source.trim())
                throw translationError('PLAN_INCOMPLETE', '原文预判出现空句，未发送翻译请求。');
            if (chunk.oversized) oversizedSentences++;
            parts.push({source: chunk.source, before, joiner: before,
                start: offset + chunk.start, end: offset + chunk.end,
                paragraph, continuation: index > 0,
                oversized: chunk.oversized, sentences: chunk.sentences});
            before = '';
        }
        offset += value.length;
    }
    // No API request is made until the entire source has been preflighted.
    if (parts.map(part => part.before + part.source).join('') + before !== text)
        throw translationError('PLAN_INCOMPLETE', '原文分段校验失败，未发送翻译请求。');
    return {parts, suffix: before, paragraphs: paragraph, sourceLength: text.length,
        oversizedSentences};
}

function withinParagraphSpacing(previous, current) {
    const left = Array.from(previous.trimEnd().slice(-40));
    const right = Array.from(current.trimStart().slice(0, 40));
    if (!left.length || !right.length || /^[,.;:!?，。！？；：、)\]）】》”’]/u.test(right[0]))
        return '';
    // Quotation marks can surround the ends of independently translated
    // sentences. Look through nearby quotes/brackets before deciding whether
    // Latin-script translations need a space, while Han text stays adjacent.
    const endings = new Set(['"', "'", '”', '’', ')', '）', '】', '』', '」', '》', '.', '!', '?', '。', '！', '？']);
    const beginnings = new Set(['\"', "'", '“', '‘', '(', '（', '【', '『', '「', '《']);
    let atLeft = left.length - 1, atRight = 0;
    while (atLeft > 0 && endings.has(left[atLeft])) atLeft--;
    while (atRight < right.length - 1 && beginnings.has(right[atRight])) atRight++;
    const tail = left[atLeft], head = right[atRight];
    // For Latin-script output, independent fragments need one word-space;
    // for Chinese/Japanese sentences no gap should be injected.
    return /[\p{Script=Latin}0-9]/u.test(tail) || /[\p{Script=Latin}0-9]/u.test(head) ? ' ' : '';
}

export function translatedText(plan, completed, partial = '') {
    let result = '';
    const append = (value, index) => {
        const part = plan.parts[index];
        if (!part) throw translationError('PLAN_INCOMPLETE', '译文段数超过原文预判。');
        if (!part.continuation) {
            result += part.before + value;
        } else if (value) {
            // A subchunk is part of the *same* paragraph. Never fabricate a
            // newline; discard only model-added whitespace at this seam.
            const clean = value.trimStart();
            if (clean) {
                result = result.trimEnd();
                result += withinParagraphSpacing(result, clean) + clean;
            }
        }
    };
    for (let index = 0; index < completed.length; index++) append(completed[index], index);
    if (partial && completed.length < plan.parts.length) append(partial, completed.length);
    if (completed.length === plan.parts.length) result += plan.suffix;
    return result;
}

export function translationPrompt(prompt, index, total) {
    return `${prompt}\n\nTranslate the entire current source fragment (${index + 1}/${total}) faithfully. ` +
        'Do not summarize, omit sentences or paragraphs, merge repeated passages, or replace content with ellipses. ' +
        'Preserve headings, numbers, quotations and citations. Return only the translation of this fragment, ' +
        'without adding fragment numbers, introductions or conclusions.';
}

// Polishing retains the source paragraph layout. Explanation is *analysis*,
// not replacement prose: keep each fragment distinguishable with its source
// paragraph and overall progress, instead of fusing independent explanations.
export function longFormText(plan, completed, partial = '', action = 'polish') {
    if (action !== 'explain')
        return translatedText(plan, completed, partial);
    const values = [...completed];
    if (partial && values.length < plan.parts.length) values.push(partial);
    return values.map((value, index) => {
        if (plan.parts.length === 1)
            return value;
        const part = plan.parts[index];
        return `【原文第 ${part.paragraph} 段 · 第 ${index + 1}/${plan.parts.length} 块】\n${value}`;
    }).join('\n\n');
}

export function longFormPrompt(prompt, action, index, total) {
    if (action === 'polish') {
        return `${prompt}\n\n完整润色当前片段 (${index + 1}/${total})，保留所有信息、人物、数字、引文与原始含义；` +
            '不要总结、跳过、合并句子、以省略号代替内容，也不要额外添加标题或片段编号。' +
            '只输出这一片段的润色结果，不要附带解释。';
    }
    return `${prompt}\n\n请只针对当前原文片段 (${index + 1}/${total}) 进行解释，不要漏掉当前片段的主要内容。` +
        '这一片段来自较长文本，分块只是为了确保全部处理；无需假设其他片段的具体内容。' +
        '只输出当前片段的解释，不添加开场白和片段编号。';
}

function answerText(value) {
    if (value === undefined || value === null)
        return '';
    if (typeof value === 'string')
        return value;
    if (Array.isArray(value) && value.every(item => item?.type === 'text' && typeof item.text === 'string'))
        return value.map(item => item.text).join('');
    throw translationError('INVALID_CONTENT', '翻译接口返回的文字字段格式无效。');
}

function withoutLeadingThought(text) {
    // Separate reasoning channels are never substituted for the translation.
    // Hide only a leading legacy think block, not matching tags in the middle
    // of translated source documents (which the old global regexp could erase).
    if (!/^\s*<think>/.test(text))
        return text;
    const end = text.indexOf('</think>');
    return end < 0 ? '' : text.slice(end + 8).replace(/^\s*\n/, '');
}

export class TranslationResponse {
    constructor(streaming, showThoughts = false) {
        this.streaming = streaming;
        this.showThoughts = showThoughts;
        this.content = '';
        this.reasoning = '';
        this.finishReason = null;
        this.done = false;
        this.frames = 0;
        this.bytes = 0;
        this._pending = new Uint8Array(4096);
        this._length = 0;
        this._event = [];
        this._decoder = new TextDecoder();
    }

    get text() {
        const body = this.showThoughts ? this.content : withoutLeadingThought(this.content);
        return this.showThoughts && this.reasoning ? `${this.reasoning}\n${body}` : body;
    }

    push(bytes) {
        if (!(bytes instanceof Uint8Array))
            throw translationError('INVALID_BYTES', '翻译数据读取失败。');
        this.bytes += bytes.length;
        if (this.bytes > 16 * 1024 * 1024)
            throw translationError('RESPONSE_LIMIT', '本段翻译响应超过安全上限，未标记为完成。');
        for (let index = 0; index < bytes.length; index++) {
            if (this.streaming && bytes[index] === 10) {
                this._flushLine();
                continue;
            }
            if (this._length === this._pending.length) {
                if (this._length >= 16 * 1024 * 1024)
                    throw translationError('RESPONSE_LIMIT', '翻译数据超过安全上限。');
                const next = new Uint8Array(Math.min(16 * 1024 * 1024, this._pending.length * 2));
                next.set(this._pending);
                this._pending = next;
            }
            this._pending[this._length++] = bytes[index];
        }
    }

    _decode() {
        const bytes = this._pending.subarray(0, this._length);
        let text;
        try { text = this._decoder.decode(bytes); } catch (_error) {
            throw translationError('INVALID_UTF8', '翻译返回文字解码失败。');
        }
        // GJS does not support TextDecoder's browser stream option. Decode only
        // complete lines/documents, then validate by round trip (no lost glyphs).
        const encoded = new TextEncoder().encode(text);
        if (encoded.length !== bytes.length || encoded.some((value, index) => value !== bytes[index]))
            throw translationError('INVALID_UTF8', '翻译返回了损坏的 UTF-8 数据。');
        this._length = 0;
        return text;
    }

    _flushLine() {
        const line = this._decode().replace(/\r$/, '');
        if (!line) {
            this._dispatch();
            return;
        }
        if (line.startsWith(':') || /^(?:event|id|retry):/.test(line))
            return;
        if (!line.startsWith('data:'))
            throw translationError('INVALID_SSE', '翻译流格式无效；没有忽略或跳过数据。');
        const data = line.slice(5).replace(/^ /, '');
        // Some compatible APIs omit the blank line between standalone JSON
        // records. Accept that dialect without discarding multiline SSE events.
        if (this._event.length) {
            let complete = false;
            try { JSON.parse(this._event.join('\n')); complete = true; } catch (_error) {}
            if (complete || data.trim() === '[DONE]')
                this._dispatch();
        }
        if (data.trim() === '[DONE]') {
            this._dispatch();
            this.done = true;
        } else {
            this._event.push(data);
        }
    }

    _dispatch() {
        if (!this._event.length)
            return;
        const data = this._event.join('\n');
        this._event = [];
        if (!data.trim())
            return;
        this._json(data, true);
    }

    _json(data, streaming) {
        let value;
        try { value = JSON.parse(data); } catch (_error) {
            throw translationError('INVALID_JSON', '翻译接口返回了无法解析的数据；本段未完成。');
        }
        if (!value || typeof value !== 'object' || value.error)
            throw translationError('BACKEND_ERROR', '翻译接口拒绝请求或返回错误。');
        if (this.done)
            throw translationError('AFTER_DONE', '翻译接口在结束标记后又返回内容。');
        if (!Array.isArray(value.choices))
            throw translationError('INVALID_RESPONSE', '翻译接口缺少 choices 字段。');
        if (!value.choices.length && value.usage)
            return; // Optional usage-only SSE record.
        const choice = value.choices.find(item => item && (item.index === undefined || item.index === 0));
        if (!choice)
            throw translationError('INVALID_RESPONSE', '翻译接口缺少第一个回答。');
        const message = streaming ? choice.delta : choice.message;
        if (!message || typeof message !== 'object')
            throw translationError('INVALID_RESPONSE', '翻译接口缺少回答数据。');
        if (message.refusal || message.tool_calls || message.function_call)
            throw translationError('NOT_TRANSLATION', '模型返回了拒绝或工具调用，没有完成本段翻译。');
        this.content += answerText(message.content);
        this.reasoning += answerText(message.reasoning_content ?? message.reasoning);
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
            if (typeof choice.finish_reason !== 'string')
                throw translationError('INVALID_FINISH', '翻译结束状态无效。');
            this.finishReason = choice.finish_reason;
        }
        this.frames++;
    }

    finish() {
        if (this.streaming) {
            if (this._length)
                this._flushLine();
            this._dispatch();
            if (!this.done && this.finishReason !== 'stop')
                throw translationError('INCOMPLETE', '翻译连接在完成前结束，本段未确认。');
        } else {
            this._json(this._decode(), false);
        }
        if (this.finishReason && this.finishReason !== 'stop')
            throw translationError(this.finishReason === 'length' ? 'OUTPUT_LIMIT' : 'INCOMPLETE',
                this.finishReason === 'length' ? '模型达到输出限制，本段翻译尚未完成。' : '模型未正常完成本段翻译。');
        if (!withoutLeadingThought(this.content).trim())
            throw translationError('EMPTY_TRANSLATION', '模型未返回本段译文（只有空内容或思考），没有跳过该段。');
        return this.text;
    }
}
