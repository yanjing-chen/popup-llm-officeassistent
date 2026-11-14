import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

// Actor-bound updates only for a live pointer gesture; never grabs desktop input.
export class FrameLoop {
    constructor(actor, callback, onError = () => {}) {
        this._actor = actor;
        this._callback = callback;
        this._onError = onError;
        this._active = false;
        this._timeline = null;
        this._signal = 0;
        this._fallbackId = 0;
    }

    start() {
        if (this._active)
            return;
        this._active = true;
        try {
            this._timeline = new Clutter.Timeline({actor: this._actor,
                duration: 1000, repeat_count: -1});
            this._signal = this._timeline.connect('new-frame', () => this._dispatch());
            this._timeline.start();
        } catch (_error) {
            this._stopTimeline();
            // Use the known-working timer path only if native frame setup fails.
            this._fallbackId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => this._dispatch());
        }
    }

    _dispatch() {
        if (!this._active)
            return GLib.SOURCE_REMOVE;
        try {
            if (this._callback() === false) {
                this.stop();
                return GLib.SOURCE_REMOVE;
            }
        } catch (_error) {
            this.stop();
            this._onError();
            return GLib.SOURCE_REMOVE;
        }
        return this._active ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
    }

    _stopTimeline() {
        const timeline = this._timeline;
        this._timeline = null;
        if (timeline) {
            if (this._signal) {
                try { timeline.disconnect(this._signal); } catch (_error) {}
                this._signal = 0;
            }
            try { timeline.stop(); } catch (_error) {}
            try { timeline.set_actor(null); } catch (_error) {}
        }
    }

    stop() {
        this._active = false;
        if (this._fallbackId) {
            GLib.source_remove(this._fallbackId);
            this._fallbackId = 0;
        }
        this._stopTimeline();
    }
}
