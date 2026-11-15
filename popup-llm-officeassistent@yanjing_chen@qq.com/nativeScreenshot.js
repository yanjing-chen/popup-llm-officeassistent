import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import {pngInfo, MAX_OCR_IMAGE_BYTES} from './ocrUtils.js';

// A single, explicitly initiated native capture. No monkey patch, Eval,
// synthetic Print key, directory watcher, clipboard reader or desktop grab.
export class NativeScreenshot {
    constructor(hide) {
        this.hide = hide;
        this.ui = Main.screenshotUI;
        this.signals = [];
        this.cancellable = new Gio.Cancellable();
        this.finished = false;
        this.started = false;
        this.closed = false;
        this.taken = false;
        this.reading = false;
        this.image = null;
        this.error = null;
        this.source = 0;
        this.watchdog = 0;
        this.phase = 'check';
    }

    capture() {
        return new Promise((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
            try {
                // 49+ includes the upstream fix which awaits saving the image
                // before closing the UI. Keep older six-tool support untouched.
                if (Number.parseInt(Config.PACKAGE_VERSION, 10) < 49)
                    throw this._error('UNSUPPORTED_SHELL', '本版原生截图 OCR 需要 GNOME 49–51；旧系统的原有六项功能不受影响。');
                if (!this.ui)
                    throw this._error('NO_NATIVE_UI', '未找到 GNOME 原生截图对象 Main.screenshotUI。');
                if (typeof this.ui.open !== 'function')
                    throw this._error('NO_NATIVE_OPEN', '当前原生截图对象没有可调用的 open() 接口。');
                this._checkIdle();
                this._phase('connect');
                this.signals.push(this.ui.connect('screenshot-taken', (_ui, file) => this._taken(file)));
                this.signals.push(this.ui.connect('closed', () => {
                    if (!this.started) return;
                    this.closed = true;
                    this._phase('closed');
                    this._queueFinish();
                }));
                this.signals.push(this.ui.connect('notify::visible', () => {
                    if (this.closed) this._queueFinish();
                }));
                this._phase('hide');
                this.restore = this.hide();
                this._phase('queued');
                // The clicked actor must leave event dispatch before Shell
                // opens its own modal UI. No private enum or paint signal is
                // required: native open() takes a fresh snapshot of the scene.
                this.source = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    this.source = 0;
                    this._open();
                    return GLib.SOURCE_REMOVE;
                });
            } catch (error) {
                this._finish(null, error);
            }
        });
    }

    _phase(phase) {
        this.phase = phase;
        log(`[PopupLLM OCR] phase=${phase}`);
    }

    _error(code, message) {
        const error = new Error(message);
        error.ocrCode = code;
        return error;
    }

    _checkIdle() {
        if (this.ui.visible || this.ui._openingCoroutineInProgress || this.ui.screencast_in_progress)
            throw new Error('GNOME 截图或录屏正在使用中，请结束后重试。');
        if (Main.sessionMode.isLocked)
            throw new Error('锁屏时不能截图。');
    }

    async _open() {
        if (this.finished)
            return;
        try {
            this._checkIdle();
            this.started = true;
            this._phase('open');
            this.watchdog = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10000, () => {
                this.watchdog = 0;
                const error = new Error('GNOME 原生截图打开超时，已恢复原有弹窗。');
                error.ocrCode = 'OPEN_TIMEOUT';
                this._finish(null, error);
                return GLib.SOURCE_REMOVE;
            });
            const opened = await this.ui.open();
            if (this.watchdog) GLib.source_remove(this.watchdog);
            this.watchdog = 0;
            if (this.finished) {
                // Disable/lock can happen while native open() is asynchronous.
                this.ui.close(true);
            } else if (opened === false || (this.ui.visible === false && !this.closed)) {
                throw new Error('GNOME 原生截图界面未能打开，请检查会话是否允许截图。');
            } else if (!this.closed) {
                this._phase('opened');
            }
        } catch (error) {
            this._finish(null, error);
        }
    }

    async _taken(file) {
        if (this.finished || !this.started || this.taken)
            return;
        this.taken = true;
        this.reading = true;
        this._phase('read-image');
        try {
            if (!file || typeof file.read_async !== 'function' || !file.is_native())
                throw new Error('GNOME 未返回本次截图文件；未读取旧剪贴板图片。');
            this.image = await this._readPNG(file);
        } catch (error) {
            error.ocrCode = 'READ_IMAGE';
            this.error = error;
        } finally {
            this.reading = false;
            this._queueFinish();
        }
    }

    async _readPNG(file) {
        let stream = null;
        try {
            stream = await new Promise((resolve, reject) => {
                file.read_async(GLib.PRIORITY_DEFAULT, this.cancellable, (source, result) => {
                    try { resolve(source.read_finish(result)); } catch (error) { reject(error); }
                });
            });
            const parts = [];
            let total = 0;
            for (;;) {
                const chunk = await new Promise((resolve, reject) => {
                    stream.read_bytes_async(262144, GLib.PRIORITY_DEFAULT, this.cancellable, (source, result) => {
                        try { resolve(source.read_bytes_finish(result).get_data() || new Uint8Array()); } catch (error) { reject(error); }
                    });
                });
                if (this.cancellable.is_cancelled())
                    throw new Error('截图任务已取消。');
                if (!chunk.length)
                    break;
                total += chunk.length;
                if (total > MAX_OCR_IMAGE_BYTES)
                    throw new Error('截图超过 32 MiB，请缩小截图区域。');
                parts.push(chunk);
            }
            const png = new Uint8Array(total);
            let offset = 0;
            for (const part of parts) { png.set(part, offset); offset += part.length; }
            const size = pngInfo(png);
            return {png, ...size};
        } finally {
            stream?.close_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
                try { source.close_finish(result); } catch (_error) {}
            });
        }
    }

    _queueFinish() {
        if (this.finished || this.source || !this.closed)
            return;
        this.source = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.source = 0;
            if (!this.finished && !this.ui.visible && !this.reading)
                this._finish(this.image, this.error);
            return GLib.SOURCE_REMOVE;
        });
    }

    cancel() {
        this._finish(null);
    }

    _finish(image = null, error = null) {
        if (this.finished)
            return;
        this.finished = true;
        if (error) {
            const code = error.ocrCode || this.phase.replace(/-/g, '_').toUpperCase() + '_FAILED';
            const launchPhase = ['check', 'connect', 'hide', 'queued', 'open'].includes(this.phase);
            const detail = launchPhase ? String(error.message || error)
                .replace(/(?:https?|file):\/\/\S+/g, '<address>')
                .replace(/\/(?:home|tmp|run|var)\/\S+/g, '<path>')
                .replace(/[\r\n]/g, ' ').slice(0, 180) : String(error.name || 'Error');
            log(`[PopupLLM OCR] failed phase=${this.phase} code=${code} detail=${detail}`);
            const visible = new Error(`[${code}] ${launchPhase ? detail : '无法读取本次截图，请重试；未读取旧剪贴板图片。'}`);
            visible.ocrCode = code;
            error = visible;
        }
        this.cancellable.cancel();
        for (const key of ['source', 'watchdog']) {
            if (this[key]) GLib.source_remove(this[key]);
            this[key] = 0;
        }
        for (const id of this.signals) {
            try { this.ui.disconnect(id); } catch (_error) {}
        }
        this.signals = [];
        if (this.started && !this.closed) {
            try { this.ui.close(true); } catch (_error) {}
        }
        this.image = null;
        const restore = this.restore;
        this.restore = null;
        try { restore?.(); } catch (_error) {}
        if (error) this.reject?.(error);
        else this.resolve?.(image);
    }
}
