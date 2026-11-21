import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import {TranslationResponse, translationError} from './translation.js';

// Uses the window's existing session and the same configured model endpoint.
// Sequential fragment requests share one model lease; no extra backend/runtime.
export class TextClient {
    constructor(session, endpoint, apiKey = '') {
        this.session = session;
        this.endpoint = endpoint;
        this.apiKey = apiKey;
    }

    dispose() {
        this.apiKey = '';
        this.session = null;
    }

    async complete(payload, {cancellable, showThoughts = false, onText} = {}) {
        const message = Soup.Message.new('POST', this.endpoint);
        if (!message)
            throw translationError('INVALID_URL', '翻译接口地址无效。');
        message.set_flags(message.get_flags() | Soup.MessageFlags.NO_REDIRECT);
        if (this.apiKey)
            message.request_headers.append('Authorization', `Bearer ${this.apiKey}`);
        message.set_request_body_from_bytes('application/json',
            new GLib.Bytes(new TextEncoder().encode(JSON.stringify(payload))));
        const parser = new TranslationResponse(payload.stream === true, showThoughts);
        let input = null;
        try {
            if (payload.stream !== true) {
                const bytes = await new Promise((resolve, reject) => {
                    this.session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (session, result) => {
                        try { resolve(session.send_and_read_finish(result).get_data() || new Uint8Array()); }
                        catch (error) { reject(error); }
                    });
                });
                if (cancellable?.is_cancelled())
                    throw translationError('CANCELLED', '翻译已取消。');
                if (message.status_code !== 200)
                    throw translationError(`HTTP_${message.status_code}`, `翻译接口返回 HTTP ${message.status_code}。`);
                parser.push(bytes);
            } else {
                input = await new Promise((resolve, reject) => {
                    this.session.send_async(message, GLib.PRIORITY_DEFAULT, cancellable, (session, result) => {
                        try { resolve(session.send_finish(result)); } catch (error) { reject(error); }
                    });
                });
                if (message.status_code !== 200)
                    throw translationError(`HTTP_${message.status_code}`, `翻译接口返回 HTTP ${message.status_code}。`);
                let displayed = '';
                for (;;) {
                    if (cancellable?.is_cancelled())
                        throw translationError('CANCELLED', '翻译已取消。');
                    const bytes = await new Promise((resolve, reject) => {
                        input.read_bytes_async(65536, GLib.PRIORITY_DEFAULT, cancellable, (stream, result) => {
                            try { resolve(stream.read_bytes_finish(result).get_data() || new Uint8Array()); }
                            catch (error) { reject(error); }
                        });
                    });
                    if (!bytes.length)
                        break;
                    parser.push(bytes);
                    if (parser.text !== displayed) {
                        displayed = parser.text;
                        onText?.(displayed);
                    }
                }
            }
            const text = parser.finish();
            return {text, bytes: parser.bytes, frames: parser.frames, finishReason: parser.finishReason || 'unspecified'};
        } catch (error) {
            if (cancellable?.is_cancelled())
                throw translationError('CANCELLED', '翻译已取消。');
            const failure = error.translationCode ? error :
                translationError('READ_FAILED', '翻译连接或返回数据处理失败，本段没有完成。');
            failure.partialText = parser.text;
            throw failure;
        } finally {
            input?.close_async(GLib.PRIORITY_DEFAULT, null, (stream, result) => {
                try { stream.close_finish(result); } catch (_error) {}
            });
        }
    }
}
