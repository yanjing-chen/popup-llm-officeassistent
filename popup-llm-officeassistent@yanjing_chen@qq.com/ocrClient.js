import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import {localOllamaEndpoint, pngInfo, ocrPayload, OcrStream, ocrError} from './ocrUtils.js';

// The installed Ollama process performs inference. Shell only handles bounded,
// asynchronous I/O; no Python/Paddle/Tesseract process or GPU library is loaded.
export class OcrClient {
    constructor(endpoint, apiKey = '') {
        this.url = localOllamaEndpoint(endpoint);
        this.apiKey = apiKey;
        this.session = new Soup.Session({timeout: 240,
            proxy_resolver: Gio.SimpleProxyResolver.new(null, [])});
    }

    dispose() {
        this.session.abort();
        this.apiKey = '';
    }

    async recognize({model, png, prompt, streaming, idleSeconds, cancellable, onText}) {
        pngInfo(png);
        const payload = ocrPayload(model, GLib.base64_encode(png), prompt, streaming, idleSeconds);
        const message = Soup.Message.new('POST', this.url);
        message.set_flags(message.get_flags() | Soup.MessageFlags.NO_REDIRECT);
        if (this.apiKey)
            message.request_headers.append('Authorization', `Bearer ${this.apiKey}`);
        message.set_request_body_from_bytes('application/json',
            new GLib.Bytes(new TextEncoder().encode(JSON.stringify(payload))));
        let input = null;
        let phase = 'connect';
        log('[PopupLLM OCR] recognize phase=connect');
        try {
            input = await new Promise((resolve, reject) => {
                this.session.send_async(message, GLib.PRIORITY_DEFAULT, cancellable, (session, result) => {
                    try { resolve(session.send_finish(result)); } catch (error) { reject(error); }
                });
            });
            if (message.status_code !== 200)
                throw ocrError(`HTTP_${message.status_code}`, `OCR 接口返回 HTTP ${message.status_code}，识别未完成。`);
            phase = 'read';
            log('[PopupLLM OCR] recognize phase=read status=200');
            const parser = new OcrStream(() => {}, streaming);
            let displayed = '';
            // NDJSON for stream=true, one JSON object for stream=false. Both
            // use the same bounded decoder and require Ollama's done=true.
            for (;;) {
                const bytes = await new Promise((resolve, reject) => {
                    input.read_bytes_async(65536, GLib.PRIORITY_DEFAULT, cancellable, (stream, result) => {
                        try { resolve(stream.read_bytes_finish(result).get_data() || new Uint8Array()); } catch (error) { reject(error); }
                    });
                });
                if (cancellable.is_cancelled())
                    throw new Error('OCR 已取消。');
                if (bytes.length === 0)
                    break;
                parser.push(bytes);
                // Coalesce all tokens read in one chunk into one label update.
                if (parser.text !== displayed) {
                    displayed = parser.text;
                    onText?.(displayed);
                }
            }
            const text = parser.finish();
            log(`[PopupLLM OCR] recognize phase=complete bytes=${parser.bytes}`);
            return text;
        } catch (error) {
            if (cancellable.is_cancelled())
                throw ocrError('CANCELLED', 'OCR 已取消。');
            const failure = error.ocrCode ? error : ocrError(
                phase === 'connect' ? 'CONNECT_FAILED' : 'READ_FAILED',
                phase === 'connect' ? 'OCR 请求连接未完成，请重试或提供 OCR 诊断日志。' :
                    'OCR 返回数据读取或处理失败，请重试或提供 OCR 诊断日志。');
            // Never log URLs, credentials, prompts, server bodies or image data.
            log(`[PopupLLM OCR] recognize failed phase=${phase} code=${failure.ocrCode} status=${message.status_code}`);
            throw failure;
        } finally {
            input?.close_async(GLib.PRIORITY_DEFAULT, null, (stream, result) => {
                try { stream.close_finish(result); } catch (_error) {}
            });
        }
    }
}
