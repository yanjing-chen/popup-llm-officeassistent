// OCR-only, GI-free policy. Never change text selection or the six text tools.
export const OCR_PROMPT = 'OCR:';
export const MAX_OCR_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_OCR_RESPONSE_BYTES = 2 * 1024 * 1024;

export function ocrError(code, message) {
    const error = new Error(`${message} [${code}]`);
    error.ocrCode = code;
    return error;
}

export function ocrPreviewSize(width, height, maxWidth, maxHeight) {
    if (![width, height, maxWidth, maxHeight].every(value => Number.isFinite(value) && value > 0))
        throw new Error('OCR 缩略图尺寸无效。');
    const scale = Math.min(1, maxWidth / width, maxHeight / height);
    return {width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale))};
}

export function requireOcrModel(models, saved = '') {
    if (!Array.isArray(models) || models.length === 0)
        throw new Error('尚未安装模型。请先在当前后端安装 OCR 模型，再刷新列表。');
    if (!saved?.trim())
        throw new Error('尚未选择 OCR 模型。请展开设置中的“文字识别”，选择支持图片输入的模型。');
    if (!models.some(model => model.id === saved))
        throw new Error('所选 OCR 模型已不在实际列表中，请在“文字识别”设置中重新选择。');
    return saved;
}

export function localOllamaEndpoint(endpoint) {
    // Screenshots must never follow the six tools to an online text endpoint.
    // Explicit loopback only, no credentials/query/fragment, no proxy redirects.
    const match = String(endpoint).trim().match(
        /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]+))?(\/[^?#]*)?$/i);
    if (!match || (match[2] && (+match[2] < 1 || +match[2] > 65535)))
        throw new Error('OCR 仅使用本机 Ollama。请将前部接口设置为本机 Ollama 的 /v1/chat/completions 地址。');
    const path = (match[3] || '').replace(/\/+$/, '');
    if (!path.endsWith('/v1/chat/completions'))
        throw new Error('OCR 需要本机 Ollama 的 /v1/chat/completions 接口。');
    const prefix = path.slice(0, -'/v1/chat/completions'.length);
    return `http://${match[1]}${match[2] ? ':' + match[2] : ''}${prefix}/api/generate`;
}

export function pngInfo(bytes) {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (!bytes || bytes.length < 33 || bytes.length > MAX_OCR_IMAGE_BYTES ||
        signature.some((value, index) => bytes[index] !== value) ||
        String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR')
        throw new Error('截图不是有效的 PNG，或超过 32 MiB，未发送识别。');
    const read32 = offset => bytes[offset] * 16777216 + bytes[offset + 1] * 65536 +
        bytes[offset + 2] * 256 + bytes[offset + 3];
    const width = read32(16), height = read32(20);
    if (!width || !height || width > 32768 || height > 32768 || width * height > 40000000)
        throw new Error('截图尺寸无效或超过 4000 万像素，请缩小截图区域。');
    return {width, height};
}

export function ocrPayload(model, image, prompt, streaming, idleSeconds) {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 2048)
        throw new Error('OCR 提示词不能为空或超过 2048 字符；官方默认值是 OCR:。');
    return {model, prompt, images: [image], stream: !!streaming,
        options: {temperature: 0}, keep_alive: idleSeconds};
}

export class OcrStream {
    constructor(onText = () => {}, streaming = true) {
        this.onText = onText;
        this.streaming = streaming;
        // GJS TextDecoder is not a browser decoder: stream:true can throw even
        // after Ollama has returned valid bytes. Keep incomplete UTF-8 in byte
        // buffers and decode only complete NDJSON lines (or the final JSON).
        this.decoder = new TextDecoder('utf-8', {fatal: true});
        this.pending = new Uint8Array(4096);
        this.pendingBytes = 0;
        this.text = '';
        this.bytes = 0;
        this.done = false;
    }

    push(bytes) {
        this.bytes += bytes.length;
        if (this.bytes > MAX_OCR_RESPONSE_BYTES)
            throw ocrError('RESPONSE_TOO_LARGE', 'OCR 返回内容超过安全上限，已停止接收。');
        let start = 0, end;
        while (this.streaming && (end = bytes.indexOf(10, start)) >= 0) {
            this._append(bytes.subarray(start, end));
            this._flushLine();
            start = end + 1;
        }
        this._append(bytes.subarray(start));
    }

    _append(bytes) {
        if (!bytes.length) return;
        const needed = this.pendingBytes + bytes.length;
        if (needed > this.pending.length) {
            const buffer = new Uint8Array(Math.min(MAX_OCR_RESPONSE_BYTES,
                Math.max(needed, this.pending.length * 2)));
            buffer.set(this.pending.subarray(0, this.pendingBytes));
            this.pending = buffer;
        }
        this.pending.set(bytes, this.pendingBytes);
        this.pendingBytes += bytes.length;
    }

    _flushLine() {
        if (!this.pendingBytes) return;
        const bytes = this.pending.subarray(0, this.pendingBytes);
        this.pendingBytes = 0;
        let line;
        try { line = this.decoder.decode(bytes); } catch (_error) {
            throw ocrError('DECODE_FAILED', 'OCR 返回文字解码失败，请重试或提供 OCR 诊断日志。');
        }
        this._line(line);
    }

    _line(line) {
        if (!line.trim())
            return;
        let value;
        try { value = JSON.parse(line); } catch (_error) {
            throw ocrError('INVALID_JSON', 'OCR 接口返回了无效的数据。');
        }
        if (!value || typeof value !== 'object' || Array.isArray(value))
            throw ocrError('INVALID_RESPONSE', 'OCR 接口返回了无效的数据结构。');
        if (this.done)
            throw ocrError('AFTER_DONE', 'OCR 接口在完成后继续返回数据。');
        if (value.error)
            throw ocrError('BACKEND_REJECTED', 'OCR 接口拒绝请求，请检查所选模型是否支持图片输入。');
        if (value.response !== undefined && typeof value.response !== 'string')
            throw ocrError('INVALID_RESPONSE', 'OCR 接口返回了无效的文字字段。');
        if (typeof value.response === 'string') {
            this.text += value.response;
            this.onText(this.text);
        }
        if (value.done === true)
            this.done = true;
    }

    finish() {
        this._flushLine();
        if (!this.done)
            throw ocrError('INCOMPLETE_RESPONSE', 'OCR 连接在识别完成前中断，可重新点击“识别”。');
        return this.text;
    }
}
