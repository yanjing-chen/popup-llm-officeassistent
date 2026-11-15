import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import {pngInfo, ocrPreviewSize} from './ocrUtils.js';

// OCR-only image view, not an icon: St.Icon forces icon geometry. Decode a
// small, aspect-preserving texture asynchronously from the in-memory PNG;
// keep the independent original bytes for inference. No temporary files.
export class OcrPreview {
    constructor(png, maxWidth, maxHeight) {
        const original = pngInfo(png);
        this.size = ocrPreviewSize(original.width, original.height, maxWidth, maxHeight);
        this.cancellable = new Gio.Cancellable();
        this.actor = new St.Bin({...this.size, x_expand: false, y_expand: false,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this.actor.connect('destroy', () => this.dispose());
        this.ready = this._load(png);
    }

    async _load(png) {
        let stream = null;
        try {
            const scale = Math.max(1, Math.min(4,
                St.ThemeContext.get_for_stage(global.stage).scale_factor || 1));
            stream = Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(png));
            const pixbuf = await new Promise((resolve, reject) => {
                GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream,
                    Math.ceil(this.size.width * scale), Math.ceil(this.size.height * scale),
                    true, this.cancellable, (_source, result) => {
                        try {resolve(GdkPixbuf.Pixbuf.new_from_stream_finish(result));}
                        catch (error) {reject(error);}
                    });
            });
            if (this.disposed)
                return;
            // GNOME 48+ takes an explicit Cogl.Context. OCR capture targets 49+.
            const context = global.stage.context.get_backend().get_cogl_context();
            const content = St.ImageContent.new_with_preferred_size(this.size.width, this.size.height);
            content.set_bytes(context, pixbuf.read_pixel_bytes(),
                pixbuf.get_has_alpha() ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
                pixbuf.get_width(), pixbuf.get_height(), pixbuf.get_rowstride());
            this.actor.set_child(new St.Widget({...this.size, content,
                content_gravity: Clutter.ContentGravity.RESIZE_ASPECT}));
        } catch (_error) {
            if (!this.disposed) {
                log('[PopupLLM OCR] preview failed code=PREVIEW_LOAD_FAILED');
                const label = new St.Label({text: '缩略图未加载；原图仍可识别。'});
                label.clutter_text.line_wrap = true;
                this.actor.set_child(label);
            }
        } finally {
            stream?.close_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
                try {source.close_finish(result);} catch (_error) {}
            });
        }
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.cancellable.cancel();
        this.actor = null;
    }
}
