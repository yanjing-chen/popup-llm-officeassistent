import {readFileSync} from 'node:fs';
import {deflateSync} from 'node:zlib';

// A real tiny PNG, generated test fixture only; no user screenshot is retained.
export function image() {
    const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==', 'base64'));
    return {png, width: 1, height: 1};
}

// Genuine PNGs with correct chunk CRCs, for geometry tests and optional native
// GdkPixbuf checks. No user screenshot or additional fixture file is required.
export function rectangleImage(width, height) {
    const chunk = (name, data) => {
        const bytes = Buffer.concat([Buffer.from(name), data]);
        let crc = 0xffffffff;
        for (const byte of bytes) {
            crc ^= byte;
            for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
        }
        const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
        length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
        return Buffer.concat([length, bytes, checksum]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
    const stride = width * 4 + 1, pixels = Buffer.alloc(stride * height, 255);
    for (let row = 0; row < height; row++) pixels[row * stride] = 0;
    const png = new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]));
    return {png, width, height};
}

export function input(chunks, {hold = false, readError = null} = {}) {
    let index = 0;
    const stream = {reads: 0, closed: false, pending: [],
        read_bytes_async(_count, _priority, cancellable, callback) {
            stream.reads++;
            const result = {bytes: chunks[index++] || new Uint8Array(), cancellable};
            if (hold) stream.pending.push(() => callback(stream, result));
            else queueMicrotask(() => callback(stream, result));
        },
        read_bytes_finish(result) {
            if (readError) throw readError;
            if (result.cancellable?.is_cancelled()) throw new Error('cancelled');
            return {get_data: () => result.bytes};
        },
        close_async(_p, _c, callback) {stream.closed = true; callback?.(stream, {});},
    };
    return stream;
}

export function screenshotFile(data = image().png, options = {}) {
    const stream = input([data], options);
    const file = {stream, is_native: () => options.native !== false,
        read_async(_p, cancellable, callback) {
            queueMicrotask(() => callback(file, {cancellable}));
        },
        read_finish(result) {
            if (result.cancellable.is_cancelled()) throw new Error('cancelled');
            return stream;
        },
    };
    return file;
}

export async function microtasks() {
    for (let i = 0; i < 36; i++) await Promise.resolve();
}

export function runIdles(f) {f.flushIdles();}

export async function openNative(f) {
    f.stage.emit('after-paint');
    f.flushIdles();
    await microtasks();
}

export function respond(f, value = [{response: '识别文字', done: true}], index = f.requests.length - 1) {
    const body = typeof value === 'string' ? value : value.map(row => JSON.stringify(row)).join('\n') + '\n';
    const stream = input([new TextEncoder().encode(body)]);
    const request = f.requests[index];
    request.callback(request.session, stream);
    return stream;
}

export const extensionSource = name => readFileSync(
    new URL(`../popup-llm-officeassistent@yanjing_chen@qq.com/${name}`, import.meta.url), 'utf8');
