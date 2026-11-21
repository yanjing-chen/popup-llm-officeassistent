import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup?version=3.0';
import Gio from 'gi://Gio';
import Mtk from 'gi://Mtk';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import {clampPopupPosition, popupDragDamage, modelIdleSeconds, isOllamaCatalog, parseModelList} from './backendUtils.js';
import {FrameLoop} from './frameLoop.js';
import {makeTextMap, characterAtByte, selectionRange} from './textSelection.js';
import {OcrClient} from './ocrClient.js';
import {OcrPreview} from './ocrPreview.js';
import {localOllamaEndpoint, requireOcrModel, pngInfo} from './ocrUtils.js';
import {TextClient} from './textClient.js';
import {translationPlan, translatedText, translationPrompt, longFormText, longFormPrompt} from './translation.js';
import {resizeHit, resizedRect, resultFontSize, resultFontStyle} from './popupGeometry.js';

const LOADING_TEXT = '正在连接大模型... (Connecting to LLM...)';
const PRIMARY_BUTTON_MASK = Clutter.ModifierType?.BUTTON1_MASK ?? (1 << 8);
const CONTROL_MASK = Clutter.ModifierType?.CONTROL_MASK ?? (1 << 2);
const SHIFT_MASK = Clutter.ModifierType?.SHIFT_MASK ?? 1;

export class ResultWindow {
    constructor(owner, {translateStyle = null, ocrImage = null} = {}) {
        this._owner = owner;
        this._settings = owner._settings;
        this._soupSession = new Soup.Session();
        this._closed = false;
        // The pin protects this one popup, not every result window.
        // It is intentionally session-local and does not lock the extension itself.
        this._pinned = false;
        this._pinButton = null;
        this._closeButton = null;
        this._rawResponseText = '';
        this._activeRequest = null;
        this._positionIdleId = 0;
        this._scrollTimeoutId = 0;
        this._resultSize = null;
        this._resultWorkArea = null;
        this._resultContainer = null;
        this._qaHistory = [];
        this._lastLLMResponse = '';
        this._copyButtons = new Set();
        this._outputLabels = new Set();
        this._translateStyleState = {...(translateStyle || owner._translateStyleState)};
        this._ocrImage = ocrImage;
        this._resizeState = null;
        const [width, height] = this._settings.get_value?.('saved-result-size').deep_unpack() || [];
        this._manualResultSize = width > 0 && height > 0 ? {width, height} : null;
        this._fontLabels = new Map();
        this._fontSettingsId = this._settings.connect?.('changed::result-font-size', () => this._refreshResultFont()) || 0;
    }

    get _idleModels() { return this._owner?._idleModels; }
    get _modelBackend() { return this._owner?._modelBackend; }

    _finishRequest(request) {
        if (request.finished)
            return;
        request.finished = true;
        request.memory?.finish(request.model);
        if (this._activeRequest === request)
            this._activeRequest = null;
    }

    _cancelActiveRequest() {
        if (!this._activeRequest)
            return;
        const request = this._activeRequest;
        request.cancelled = true;
        request.cancellable.cancel();
        this._finishRequest(request);
    }

    _requestIsCurrent(request) {
        return !this._closed && !request.cancelled && !request.finished && this._activeRequest === request &&
            !!this._settings && this._resultContainer === request.container;
    }

    // St.BoxLayout gained orientation in 48. Retain 45–47 compatibility as well.

    _box(properties) {
        if (Number.parseInt(Config.PACKAGE_VERSION, 10) < 48) {
            const {orientation, ...rest} = properties;
            return new St.BoxLayout({...rest, vertical: orientation === Clutter.Orientation.VERTICAL});
        }
        return new St.BoxLayout(properties);
    }

    _monitorAt(x, y) {
        const monitors = Main.layoutManager.monitors;
        const index = monitors.findIndex(m => x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height);
        const monitor = monitors[index] || Main.layoutManager.primaryMonitor;
        if (!monitor)
            return {x: 0, y: 0, width: global.stage.width, height: global.stage.height};
        const workspace = global.workspace_manager.get_active_workspace();
        return workspace.get_work_area_for_monitor(index >= 0 ? index : monitor.index);
    }

    _constrainResultWindow(pointer = null) {
        const actor = this._resultContainer;
        if (!actor || this._dragState || this._resizeState)
            return;
        const monitor = pointer ? this._monitorAt(...pointer) :
            this._resultWorkArea || this._monitorAt(actor.x + 16, actor.y + 16);
        this._resultWorkArea = monitor;
        const manual = this._manualResultSize;
        const maxHeight = Math.max(80, manual ? monitor.height - 16 : Math.min(800, Math.floor(monitor.height * 0.7)));
        const width = Math.max(80, Math.min(manual?.width || 450, monitor.width - 16));
        if (manual) {
            manual.width = width;
            manual.height = Math.max(Math.min(this._resizeMinHeight || 260, maxHeight), Math.min(manual.height, maxHeight));
            actor.set_height(manual.height);
        }
        const previous = this._resultSize;
        // Compare requested constraints, not the actor's theme-adjusted allocation.
        // This function is NEVER called synchronously from notify::height.
        if (!previous || previous.width !== width)
            actor.set_width(width);
        if (!previous || previous.maxHeight !== maxHeight)
            actor.set_style(`max-height: ${maxHeight}px; min-height: ${Math.min(140, maxHeight)}px;`);
        this._resultSize = {width, maxHeight};
        this._fitOcrPreview();
        this._applyResultPosition();
    }

    _applyResultPosition() {
        const actor = this._resultContainer;
        if (!actor || this._pinned || this._dragState || this._resizeState || !this._resultWorkArea || this._applyingPosition)
            return;
        const position = this._resultPosition || {x: actor.x, y: actor.y};
        const next = clampPopupPosition(position.x, position.y,
            actor.width || this._resultSize.width,
            Math.min(actor.height, this._resultSize.maxHeight), this._resultWorkArea);
        this._resultPosition = next;
        if (Math.round(actor.x) === next.x && Math.round(actor.y) === next.y)
            return;
        this._applyingPosition = true;
        try {
            actor.set_position(next.x, next.y);
        } finally {
            this._applyingPosition = false;
        }
    }

    _queueResultPosition() {
        if (this._dragState || this._resizeState || this._positionIdleId || !this._resultContainer)
            return;
        const actor = this._resultContainer;
        this._positionIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._positionIdleId = 0;
            if (this._resultContainer === actor)
                this._applyResultPosition();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelResultPosition() {
        if (this._positionIdleId) {
            GLib.source_remove(this._positionIdleId);
            this._positionIdleId = 0;
        }
    }

    _movePopupToPointer(state, x, y) {
        if (this._dragState !== state || !Number.isFinite(x) || !Number.isFinite(y))
            return;
        if (x === state.lastX && y === state.lastY)
            return;
        state.lastX = x;
        state.lastY = y;
        const area = this._monitorAt(x, y);
        const actor = state.actor;
        const next = clampPopupPosition(x - state.offsetX, y - state.offsetY,
            actor.width || state.width, actor.height || state.height, area);
        const previous = state.visual;
        state.damageWidth = Math.max(state.damageWidth || state.width, actor.width || 0);
        state.damageHeight = Math.max(state.damageHeight || state.height, actor.height || 0);
        state.visual = next;
        state.area = area;
        this._resultPosition = next;
        if (previous.x === next.x && previous.y === next.y)
            return;
        // Keep the allocation anchored throughout the gesture. One actor, no clones,
        // no repeated set_position()/set_width()/style updates while dragging.
        actor.set_translation(next.x - state.baseX, next.y - state.baseY, 0);
        // Translation already invalidates Clutter's old/new paint volumes.
        // Do not add a second stage-wide damage request for every pointer frame.
    }

    _redrawPopupSweep(state, from, to) {
        // Retain the largest painted size until release, including a response that
        // grows and then shrinks while the gesture is held.
        const width = state.damageWidth = Math.max(state.damageWidth || state.width, state.actor.width || 0);
        const height = state.damageHeight = Math.max(state.damageHeight || state.height, state.actor.height || 0);
        const rectangle = popupDragDamage(from, to, width, height);
        try {
            if (!state.clipRedrawUnavailable && typeof global.stage.queue_redraw_with_clip === 'function') {
                global.stage.queue_redraw_with_clip(new Mtk.Rectangle(rectangle));
                return;
            }
        } catch (_error) {
            // Some older Clutter versions have different clip bindings. Do not retry
            // a bad native signature every frame, and never turn on full-screen polling.
            state.clipRedrawUnavailable = true;
        }
        state.actor.queue_redraw();
    }

    _beginPopupDrag(handle, event) {
        if (this._pinned)
            return Clutter.EVENT_STOP;
        if (event.get_button() !== 1 || !this._resultContainer)
            return Clutter.EVENT_PROPAGATE;
        this._clearOutputSelection();
        this._owner?._closePopupIcon();
        this._owner?._activateWindow(this);
        this._endPopupDrag();
        const [x, y] = event.get_coords();
        const actor = this._resultContainer;
        if (!Number.isFinite(x) || !Number.isFinite(y))
            return Clutter.EVENT_PROPAGATE;
        this._cancelResultPosition();
        const state = {actor, handle, baseX: actor.x, baseY: actor.y,
            width: actor.width, height: actor.height,
            visual: {x: actor.x, y: actor.y}, area: this._resultWorkArea,
            offsetX: x - actor.x, offsetY: y - actor.y, lastX: x, lastY: y,
            scrollPending: Boolean(this._scrollTimeoutId), pendingText: null};
        this._dragState = state;
        this._cancelResultScroll();
        try {
            // A half-faded actor must not be dragged while its opacity also changes.
            actor.remove_transition('opacity');
            actor.opacity = 255;
            handle.add_style_pseudo_class('active');
            // Flatten the complete popup while moving it, not each text/scroll
            // child separately. This is Clutter's native offscreen surface, not
            // a screenshot/clone or another actor. Restore the exact prior flags
            // on every exit. ON_IDLE would allow the path to switch mid-gesture.
            if (Clutter.OffscreenRedirect?.ALWAYS !== undefined &&
                typeof actor.get_offscreen_redirect === 'function' &&
                typeof actor.set_offscreen_redirect === 'function') {
                state.offscreenRedirect = actor.get_offscreen_redirect();
                actor.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);
            }
            // Update at the actor's frame clock, including high-refresh monitors.
            this._dragLoop = new FrameLoop(actor, () => {
                if (this._dragState !== state)
                    return false;
                const stop = () => {
                    this._endPopupDrag();
                    return false;
                };
                if (this._resultContainer !== actor || !this._settings ||
                    actor.visible === false || Main.sessionMode?.isLocked || Main.overview?.visible)
                    return stop();
                try {
                    const [pointerX, pointerY, modifiers] = global.get_pointer();
                    this._movePopupToPointer(state, pointerX, pointerY);
                    if (!(modifiers & PRIMARY_BUTTON_MASK))
                        return stop();
                    return this._dragState === state;
                } catch (_error) {
                    return stop();
                }
            }, () => this._endPopupDrag());
            this._dragLoop.start();
        } catch (_error) {
            this._endPopupDrag();
            return Clutter.EVENT_PROPAGATE;
        }
        return Clutter.EVENT_STOP;
    }

    _releasePopupDrag(event) {
        if (!this._dragState || event.get_button() !== 1)
            return Clutter.EVENT_PROPAGATE;
        try {
            const [x, y] = event.get_coords();
            this._movePopupToPointer(this._dragState, x, y);
        } catch (_error) {
            // A monitor/actor may disappear between release and layout update.
        } finally {
            this._endPopupDrag();
        }
        return Clutter.EVENT_STOP;
    }

    _endPopupDrag({commit = true} = {}) {
        const state = this._dragState;
        this._dragState = null;
        const loop = this._dragLoop;
        this._dragLoop = null;
        loop?.stop();
        if (state?.handle) {
            try {
                const actor = state.actor;
                const target = state.visual;
                // Commit layout once, then clear the temporary transform within the
                // same main-loop turn, before the next paint can occur.
                if (commit && this._resultContainer === actor) {
                    this._resultPosition = target;
                    this._resultWorkArea = state.area || this._resultWorkArea;
                    if (Math.round(actor.x) !== target.x || Math.round(actor.y) !== target.y)
                        actor.set_position(target.x, target.y);
                }
                actor.set_translation(0, 0, 0);
                this._redrawPopupSweep(state, {x: state.baseX, y: state.baseY}, target);
            } catch (_error) {
                // Cleanup must not hold input or a source open if an actor disappeared.
                try { state.actor.set_translation(0, 0, 0); } catch (_ignored) {}
            }
            try {
                state.handle.remove_style_pseudo_class('active');
            } catch (_error) {
                // The actor may have been destroyed externally; cleanup remains complete.
            }
            try {
                if (state.offscreenRedirect !== undefined)
                    state.actor.set_offscreen_redirect(state.offscreenRedirect);
            } catch (_error) {
                // A destroyed actor must not prevent input/source cleanup.
            }
            const pending = state.pendingText;
            state.pendingText = null;
            if (commit && this._resultContainer === state.actor) {
                // Buffer reception and QA history have continued normally. Only
                // the last visible text is applied, once, after the move ends.
                if (pending && pending.label === this._resultLabel)
                    this._setResultText(pending.text);
                try { this._constrainResultWindow(); } catch (_error) {}
                if ((state.scrollPending || pending) && state.actor.visible !== false &&
                    !Main.sessionMode?.isLocked && !Main.overview?.visible)
                    this._scrollToBottom();
            }
        }
    }

    _resizeEdgeAt(x, y) {
        const actor = this._resultContainer;
        if (!actor || this._pinned || this._dragState || this._selectionState?.selecting)
            return null;
        const [ok, localX, localY] = actor.transform_stage_point(x, y);
        return ok ? resizeHit(localX, localY, actor.width, actor.height) : null;
    }

    _resizeCursor(edge) {
        const cursor = edge ? Clutter.CursorType?.[edge.toUpperCase() + '_RESIZE'] : Clutter.CursorType?.INHERIT;
        if (cursor !== undefined)
            this._resultContainer?.set_cursor_type?.(cursor);
    }

    _captureResizeEvent(event) {
        const type = event.type();
        if (this._resizeState) {
            if (type === Clutter.EventType.MOTION) {
                // The frame clock reads the latest native pointer; queued motion
                // events never replace it with an older sample.
                return true;
            }
            if (type === Clutter.EventType.BUTTON_RELEASE && event.get_button() === 1) {
                try { this._movePopupResize(this._resizeState, ...event.get_coords()); }
                finally { this._endPopupResize(); }
                return true;
            }
            if (type === Clutter.EventType.KEY_PRESS && event.get_key_symbol() === Clutter.KEY_Escape) {
                this._endPopupResize({commit: false});
                return true;
            }
        }
        if (type === Clutter.EventType.MOTION && !this._dragState && !this._selectionState?.selecting)
            this._resizeCursor(this._resizeEdgeAt(...event.get_coords()));
        if (type === Clutter.EventType.BUTTON_PRESS && event.get_button() === 1) {
            const edge = this._resizeEdgeAt(...event.get_coords());
            if (edge) {
                const source = global.stage.get_event_actor(event);
                if ([...this._outputLabels].some(label => source && label.contains(source)))
                    return false; // A text hit always belongs to selection, not resizing.
                return this._beginPopupResize(edge, event);
            }
        }
        return false;
    }

    _beginPopupResize(edge, event) {
        if (this._closed || this._pinned || this._dragState || this._resizeState || !this._resultContainer)
            return false;
        const [x, y] = event.get_coords();
        if (!Number.isFinite(x) || !Number.isFinite(y))
            return false;
        this._clearOutputSelection();
        this._owner?._closePopupIcon();
        this._owner?._activateWindow(this);
        this._cancelResultPosition();
        const actor = this._resultContainer;
        const state = {actor, edge, startX: x, startY: y,
            original: {x: actor.x, y: actor.y, width: actor.width, height: actor.height},
            previousSize: this._manualResultSize ? {...this._manualResultSize} : null,
            area: this._monitorAt(actor.x + 16, actor.y + 16),
            pendingText: null, scrollPending: Boolean(this._scrollTimeoutId), lastX: x, lastY: y};
        this._resizeState = state;
        this._cancelResultScroll();
        try {
            actor.remove_transition('opacity');
            actor.opacity = 255;
            this._resizeCursor(edge);
            this._resizeLoop = new FrameLoop(actor, () => {
                if (this._resizeState !== state)
                    return false;
                if (this._closed || this._resultContainer !== actor || actor.visible === false ||
                    Main.sessionMode?.isLocked || Main.overview?.visible) {
                    this._endPopupResize();
                    return false;
                }
                const [px, py, modifiers] = global.get_pointer();
                this._movePopupResize(state, px, py);
                if (!(modifiers & PRIMARY_BUTTON_MASK)) {
                    this._endPopupResize();
                    return false;
                }
                return true;
            }, () => this._endPopupResize());
            this._resizeLoop.start();
        } catch (_error) {
            this._endPopupResize({commit: false});
            return false;
        }
        return true;
    }

    _movePopupResize(state, x, y) {
        if (this._resizeState !== state || !Number.isFinite(x) || !Number.isFinite(y) ||
            (state.lastX === x && state.lastY === y))
            return;
        state.lastX = x;
        state.lastY = y;
        const rect = resizedRect(state.original, state.edge, x - state.startX, y - state.startY,
            state.area, 300, this._resizeMinHeight || 260);
        if (state.rect && ['x', 'y', 'width', 'height'].every(key => state.rect[key] === rect[key]))
            return;
        if (!state.rect)
            state.actor.set_style(`max-height: ${state.area.height - 16}px; min-height: ${Math.min(this._resizeMinHeight || 260, state.area.height - 16)}px;`);
        state.rect = rect;
        this._manualResultSize = {width: rect.width, height: rect.height};
        this._resultPosition = {x: rect.x, y: rect.y};
        this._resultWorkArea = state.area;
        this._resultSize = {width: rect.width, maxHeight: state.area.height - 16};
        if (state.actor.width !== rect.width)
            state.actor.set_width(rect.width);
        if (state.actor.height !== rect.height)
            state.actor.set_height(rect.height);
        if (state.actor.x !== rect.x || state.actor.y !== rect.y)
            state.actor.set_position(rect.x, rect.y);
        this._fitOcrPreview();
        // Native layout invalidates the old/new paint volumes. No clones,
        // global input grabs, stage-wide repaint loops or resize timers.
    }

    _endPopupResize({commit = true} = {}) {
        const state = this._resizeState;
        this._resizeState = null;
        const loop = this._resizeLoop;
        this._resizeLoop = null;
        loop?.stop();
        if (!state)
            return;
        try { this._resizeCursor(null); } catch (_error) {}
        if (this._closed || this._resultContainer !== state.actor)
            return;
        try {
            if (!commit) {
                this._manualResultSize = state.previousSize;
                state.actor.set_width(state.original.width);
                state.actor.set_height(state.previousSize ? state.original.height : -1);
                state.actor.set_position(state.original.x, state.original.y);
                this._resultPosition = {x: state.original.x, y: state.original.y};
                this._resultSize = null;
            } else if (state.rect) {
                const {width, height} = state.rect;
                this._settings.set_value?.('saved-result-size', new GLib.Variant('(ii)', [width, height]));
            }
            this._constrainResultWindow([state.actor.x + 16, state.actor.y + 16]);
        } catch (_error) { /* A disappearing actor must not retain its frame loop. */ }
        if (state.pendingText?.label === this._resultLabel)
            this._setResultText(state.pendingText.text);
        if ((state.scrollPending || state.pendingText) && state.actor.visible !== false &&
            !Main.sessionMode?.isLocked && !Main.overview?.visible)
            this._scrollToBottom();
    }

    _setPinned(pinned) {
        if (this._closed || !this._resultContainer || this._pinned === Boolean(pinned))
            return;
        // Finish a pending gesture before locking the final displayed position.
        this._endPopupResize();
        this._endPopupDrag();
        this._cancelResultPosition();
        this._pinned = Boolean(pinned);
        if (this._pinned) {
            const actor = this._resultContainer;
            this._resultPosition = {x: actor.x, y: actor.y};
        }
        // Pin status is visible; the disabled close button cannot accidentally
        // dismiss a pinned result. A second internal guard protects against Esc.
        this._pinButton?.[this._pinned ? 'add_style_pseudo_class' : 'remove_style_pseudo_class']('checked');
        if (this._pinButton)
            this._pinButton.accessible_name = this._pinned ? '解除固定弹窗' : '固定弹窗位置并禁止关闭';
        // St.Button is a Clutter actor, NOT Gtk.Widget: set_sensitive() is
        // not supported here (unlike Adw preferences rows). Use the native
        // reactive/focus properties and an explicit visual locked state.
        this._closeButton?.set_reactive(!this._pinned);
        this._closeButton?.set_can_focus(!this._pinned);
        this._closeButton?.[this._pinned ? 'add_style_pseudo_class' : 'remove_style_pseudo_class']('locked');
        this._resizeCursor(null);
        if (!this._pinned)
            this._queueResultPosition();
    }

    _fitOcrPreview() {
        const preview = this._ocrPreview;
        if (!preview?.actor || !this._resultContainer)
            return;
        // Resize only the already-decoded view; never touch the original PNG,
        // re-run OCR or decode a new texture during a pointer gesture.
        const factor = Math.min(1, Math.max(1, this._resultContainer.width - 52) / preview.size.width);
        const width = preview.size.width * factor, height = preview.size.height * factor;
        preview.actor.set_width(width);
        preview.actor.set_height(height);
        const child = preview.actor.get_child();
        if (child?.content) {
            child.set_width(width);
            child.set_height(height);
        }
    }

    _styleOutputFont(label) {
        if (!this._fontLabels.has(label))
            this._fontLabels.set(label, label.get_style?.() || '');
        const size = resultFontSize(this._settings?.get_int('result-font-size'));
        // An empty base style previously produced "; font-size: 22pt;".
        // GNOME Shell's St CSS parser is strict about malformed declarations:
        // build a valid inline style instead of blindly prepending a semicolon.
        label.set_style(resultFontStyle(this._fontLabels.get(label), size));
        this._applyVisibleTextFont(label, size);
    }

    _applyVisibleTextFont(label, size) {
        // A St.Label may be constructed before its window joins the stage.
        // get_theme_node() is unsafe before attachment: defer this extra
        // guarantee until it is on the stage. The inline CSS is already set.
        if (!label.get_stage?.())
            return;
        const font = label.get_theme_node?.()?.get_font?.()?.copy?.();
        const text = label.get_clutter_text?.();
        if (!font || !text?.set_font_description)
            return;
        // Use the resolved theme font to retain the system family and the
        // bold weight of QA user messages, modifying *only* the point size.
        font.set_size(resultFontSize(size) * Pango.SCALE);
        text.set_font_description(font);
    }

    _refreshResultFont() {
        if (this._closed)
            return;
        this._endPopupResize();
        this._endPopupDrag();
        this._clearOutputSelection();
        for (const label of this._fontLabels.keys())
            this._styleOutputFont(label);
        this._queueResultPosition();
    }

    _setResultText(text) {
        const label = this._resultLabel;
        if (!label)
            return;
        if (this._resizeState) {
            this._resizeState.pendingText = {label, text};
            return;
        }
        if (this._dragState && this._dragState.actor === this._resultContainer) {
            // Do not dirty/reflow the moving text surface for each SSE token.
            // Keep the latest complete display value, including errors and ''.
            this._dragState.pendingText = {label, text};
            return;
        }
        if (this._selectionState) {
            this._selectionState.pendingText = {label, text};
            return;
        }
        this._writingText = true;
        try { label.set_text(text); } finally { this._writingText = false; }
    }

    _showResultWindow(text, actionType) {
        if (this._closed)
            return false;
        try {
            this._resultContainer = this._box({ orientation: Clutter.Orientation.VERTICAL,
                reactive: true, style_class: 'translator-result-window libadwaita-style' });
            this._resultContainer.connect('captured-event', (_actor, event) => {
                if (this._captureResizeEvent(event))
                    return Clutter.EVENT_STOP;
                const selecting = this._selectionState;
                if (selecting?.selecting && event.type() === Clutter.EventType.MOTION) {
                    this._updateOutputSelection(selecting, ...event.get_coords());
                    return Clutter.EVENT_STOP;
                }
                if (selecting?.selecting && event.type() === Clutter.EventType.BUTTON_RELEASE)
                    return this._releaseOutputSelection(selecting.label, event);
                if (event.type() === Clutter.EventType.BUTTON_PRESS) {
                    // Button/motion events no longer carry an actor in
                    // event.get_source() (that source is for crossing events).
                    // Resolve the stage's actual target BEFORE raising this
                    // window, then route locally before text/scroll defaults.
                    const source = global.stage.get_event_actor(event);
                    if (selecting?.selecting)
                        this._finishOutputSelection(selecting);
                    this._owner?._activateWindow(this);
                    const state = this._selectionState;
                    const copyButton = [...this._copyButtons].find(button => source && button.contains(source));
                    this._copyIntent = copyButton ? {button: copyButton, text: this._getOutputSelection()} : null;
                    if (state && !state.selecting && !copyButton && (!source || !state.label.contains(source)))
                        this._clearOutputSelection();
                    const label = [...this._outputLabels].find(output => source && output.contains(source));
                    if (label)
                        return this._beginOutputSelection(label, event);
                }
                // Only output-selection events inside this result are handled;
                // title dragging, buttons and all desktop input keep propagating.
                return Clutter.EVENT_PROPAGATE;
            });
            this._resultContainer.connect('notify::visible', actor => {
                if (!actor.visible) {
                    this._endPopupResize();
                    this._endPopupDrag();
                    this._clearOutputSelection();
                }
            });
            this._resizeMinHeight = actionType === 'ocr' ? 420 : 260;

            // ======= 顶部标题栏 =======
            let headerBox = this._box({ orientation: Clutter.Orientation.HORIZONTAL, style: 'margin-bottom: 6px;' });
            let titleText = 'LLM 助手 (Assistant)';
            if (actionType === 'translate') titleText = 'LLM 智能翻译 (Translation)';
            else if (actionType === 'explain') titleText = 'LLM 智能解释 (Explanation)';
            else if (actionType === 'polish') titleText = 'LLM 文字润色 (Polishing)';
            else if (actionType === 'mail') titleText = 'LLM 邮件助手 (Mail Assistant)';
            else if (actionType === 'qa') titleText = 'LLM 智能问答 (Q&A)';
            else if (actionType === 'custom') titleText = 'LLM 自定义功能 (Custom)';
            else if (actionType === 'ocr') titleText = 'LLM 文字识别 (OCR)';

            const dragHandle = this._box({orientation: Clutter.Orientation.HORIZONTAL,
                style_class: 'translator-drag-handle', x_expand: true, reactive: true, track_hover: true});
            const titleLabel = new St.Label({text: '⠿ ' + titleText,
                style: 'font-weight: bold; font-size: 11px; color: #888888;',
                x_expand: true, reactive: false, y_align: Clutter.ActorAlign.CENTER});
            dragHandle.add_child(titleLabel);
            dragHandle.connect('button-press-event', (handle, event) => this._beginPopupDrag(handle, event));
            dragHandle.connect('button-release-event', (_handle, event) => this._releasePopupDrag(event));
            dragHandle.connect('destroy', () => {
                if (this._dragState?.handle === dragHandle)
                    this._endPopupDrag({commit: false});
            });
            
            // Keep the pin at the top-left, outside the title drag handle.
            const pinButton = new St.Button({
                child: new St.Icon({icon_name: 'view-pin-symbolic', icon_size: 14}),
                style_class: 'translator-pin-btn',
                accessible_name: '固定弹窗位置并禁止关闭',
                can_focus: true,
            });
            pinButton.connect('clicked', () => this._setPinned(!this._pinned));
            this._pinButton = pinButton;
            headerBox.add_child(pinButton);

            let closeButton = new St.Button({ child: new St.Icon({ icon_name: 'window-close-symbolic', icon_size: 14 }), style_class: 'translator-close-btn', reactive: true, can_focus: true });
            this._closeButton = closeButton;
            closeButton.connect('clicked', () => this._closeUI());

            headerBox.add_child(dragHandle);
            
            let copyButton = new St.Button({ child: new St.Icon({ icon_name: 'edit-copy-symbolic', icon_size: 14 }), style_class: 'translator-copy-btn', margin_right: 6 });
            this._copyButtons.add(copyButton);
            let copyAction = button => {
                let textToCopy = this._copyIntent?.button === button ?
                    this._copyIntent.text : this._getOutputSelection();
                this._copyIntent = null;
                if (!textToCopy && actionType === 'qa') {
                    textToCopy = this._lastLLMResponse;
                } else if (!textToCopy && this._resultLabel) {
                    let currentText = this._resultLabel.get_text();
                    if (currentText && currentText !== LOADING_TEXT && !currentText.includes('✨ 请')) {
                        textToCopy = currentText;
                    }
                }

                if (textToCopy) {
                    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, textToCopy);
                    button.set_child(new St.Icon({ icon_name: 'object-select-symbolic', icon_size: 14 }));
                    this._scheduleCopyReset(button);
                }
            };
            copyButton.connect('clicked', copyAction);

            if (actionType !== 'mail') {
                headerBox.add_child(copyButton);
            }
            headerBox.add_child(closeButton);
            this._resultContainer.add_child(headerBox);

            if (actionType === 'ocr') {
                if (!this._ocrImage)
                    throw new Error('OCR requires a completed native screenshot');
                pngInfo(this._ocrImage.png);
                const [px, py] = global.get_pointer();
                const area = this._monitorAt(px, py);
                const preview = this._box({orientation: Clutter.Orientation.VERTICAL,
                    style_class: 'ocr-preview', x_expand: true});
                this._ocrPreview = new OcrPreview(this._ocrImage.png,
                    Math.max(1, Math.min(480, area.width - 80)),
                    Math.max(1, Math.min(220, Math.floor(area.height * 0.24))));
                const currentPreview = this._ocrPreview;
                currentPreview.ready.then(() => {
                    if (!this._closed && this._ocrPreview === currentPreview)
                        this._fitOcrPreview();
                });
                preview.add_child(this._ocrPreview.actor);
                this._resultContainer.add_child(preview);
            }

            // ======= 动态区域划分 =======
            let dropdownBox = this._box({ orientation: Clutter.Orientation.VERTICAL, style: 'margin-bottom: 8px;' });
            
            const createDropdown = (titlePrefix, names, codes, settingKey, actionLabel, memState = null) => {
                let currentVal = memState ? memState.value : this._settings.get_string(settingKey);
                let currentIndex = Math.max(0, codes.indexOf(currentVal));
                
                let rowBox = this._box({ orientation: Clutter.Orientation.HORIZONTAL, x_expand: true, style: 'margin-bottom: 4px;' });
                let triggerBtn = new St.Button({ label: `${titlePrefix}: ${names[currentIndex]} ▾`, style_class: 'translator-dropdown-trigger', x_expand: true });
                
                let actionBtn = null;
                if (actionLabel) {
                    actionBtn = new St.Button({ label: actionLabel, style_class: 'translator-action-btn' });
                }
                
                let menuScroll = new St.ScrollView({
                    hscrollbar_policy: St.PolicyType.NEVER,
                    vscrollbar_policy: St.PolicyType.AUTOMATIC,
                    visible: false,
                    style_class: 'translator-dropdown-scroll'
                });
                
                let menuContainer = this._box({ orientation: Clutter.Orientation.VERTICAL, style_class: 'translator-dropdown-menu' });
                menuScroll.set_child(menuContainer);
                
                let customInputBox = this._box({ orientation: Clutter.Orientation.HORIZONTAL, style: 'margin-top: 2px; margin-bottom: 4px;', visible: (currentVal === 'custom') });
                if (settingKey === 'polish-mode' || (memState && memState.id === 'translate-mode')) {
                    let hintStr = (memState && memState.id === 'translate-mode') ? ' 输入自定义翻译风格 (例: 鲁迅文风)' : ' 输入自定义润色风格 (例: 幽默讽刺)';
                    let customEntry = new St.Entry({ hint_text: hintStr, x_expand: true });
                    
                    let savedText = '';
                    if (!memState) {
                        try { savedText = this._settings.get_string('polish-custom-style'); } catch(e){}
                    }
                    
                    customEntry.set_text(memState ? memState.customValue : savedText);
                    customEntry.clutter_text.connect('text-changed', () => {
                        if (memState) {
                            memState.customValue = customEntry.get_text();
                            if (this._owner)
                                this._owner._translateStyleState = {...memState};
                        } else {
                            try { this._settings.set_string('polish-custom-style', customEntry.get_text()); } catch(e){}
                        }
                    });
                    customInputBox.add_child(customEntry);
                }

                triggerBtn.connect('clicked', () => { 
                    menuScroll.visible = !menuScroll.visible; 
                });

                if (actionBtn) {
                    actionBtn.connect('clicked', () => {
                        menuScroll.visible = false;
                        if (this._soupSession) this._soupSession.abort();
                        this._soupSession = new Soup.Session();
                        this._setResultText(LOADING_TEXT);
                        this._callLLMAPI(text, actionType);
                    });
                }

                codes.forEach((code, index) => {
                    let itemBtn = new St.Button({ label: names[index], style_class: 'translator-dropdown-item', x_expand: true });
                    itemBtn.connect('clicked', () => {
                        menuScroll.visible = false;
                        triggerBtn.set_label(`${titlePrefix}: ${names[index]} ▾`);
                        
                        if (memState) {
                            memState.value = code;
                            if (this._owner)
                                this._owner._translateStyleState = {...memState};
                        }
                        else this._settings.set_string(settingKey, code);
                        
                        if (customInputBox) {
                            customInputBox.visible = (code === 'custom');
                        }
                    });
                    menuContainer.add_child(itemBtn);
                });

                rowBox.add_child(triggerBtn);
                if (actionBtn) rowBox.add_child(actionBtn);

                dropdownBox.add_child(rowBox);
                dropdownBox.add_child(customInputBox);
                dropdownBox.add_child(menuScroll);
            };

            if (actionType === 'translate') {
                const langNames = ['简体中文', 'English', 'Nederlands', '繁體中文', 'Deutsch', 'Français', 'Español', 'Italiano', 'Português', 'Русский', '日本語', '한국어', 'العربية', 'Türkçe', 'Polski', 'हिन्दी', 'Čeština', 'Dansk', 'Ελληνικά', 'Suomi', 'Magyar', 'Norsk', 'Română', 'Svenska', 'Українська', 'Tiếng Việt', 'Bahasa Indonesia', 'ไทย'];
                const langCodes = ['zh', 'en', 'nl', 'zh-tw', 'de', 'fr', 'es', 'it', 'pt', 'ru', 'ja', 'ko', 'ar', 'tr', 'pl', 'hi', 'cs', 'da', 'el', 'fi', 'hu', 'no', 'ro', 'sv', 'uk', 'vi', 'id', 'th'];
                
                createDropdown('目标语言', langNames, langCodes, 'target-lang', null);
                
                const styleNames = ['通用', '学术', '文学', '科技', '法律', '儿童', '正式文体', '生活化', '自定义'];
                const styleCodes = ['general', 'academic', 'literary', 'tech', 'legal', 'child', 'formal', 'daily', 'custom'];
                createDropdown('翻译风格', styleNames, styleCodes, null, '翻 译', this._translateStyleState);
                
            } else if (actionType === 'explain') {
                createDropdown('解释类别', ['通用', '词语解释', '语法解释', '句型解释', '含义解释'], ['general', 'word', 'grammar', 'sentence', 'meaning'], 'explain-mode', '解 释');
            } else if (actionType === 'polish') {
                createDropdown('写作风格', ['通用', '学术文体', '文学表达', '儿童语言', '正式文体', '生活化表达', '自定义风格...'], ['general', 'academic', 'literary', 'child', 'formal', 'daily', 'custom'], 'polish-mode', '润 色');
            } else if (actionType === 'custom') {
                let rowBox = this._box({ orientation: Clutter.Orientation.HORIZONTAL, x_expand: true });
                let infoLabel = new St.Label({ text: '⚙️ 独立自定义扩展功能已就绪', style: 'font-size: 11px; color: #aaaaaa; vertical-align: middle;', x_expand: true });
                let actionBtn = new St.Button({ label: '执 行', style_class: 'translator-action-btn' });
                rowBox.add_child(infoLabel);
                rowBox.add_child(actionBtn);
                dropdownBox.add_child(rowBox);

                actionBtn.connect('clicked', () => {
                    if (this._soupSession) this._soupSession.abort();
                    this._soupSession = new Soup.Session();
                    this._setResultText(LOADING_TEXT);
                    this._callLLMAPI(text, actionType);
                });
            } else if (actionType === 'mail') {
                let mailInputBox = this._box({ orientation: Clutter.Orientation.HORIZONTAL, style_class: 'mail-entry-box', style: 'margin-bottom: 8px;' });
                this._mailEntry = new St.Entry({ hint_text: ' 输入回复要求 (例: 委婉拒绝并感谢)', x_expand: true, y_align: Clutter.ActorAlign.CENTER });
                let mailSendBtn = new St.Button({ child: new St.Icon({ icon_name: 'mail-send-symbolic', icon_size: 16 }), style_class: 'mail-send-btn' });
                
                mailInputBox.add_child(this._mailEntry);
                mailInputBox.add_child(mailSendBtn);
                this._resultContainer.add_child(mailInputBox);

                let sendAction = () => {
                    let customReq = this._mailEntry.get_text();
                    if (this._soupSession) this._soupSession.abort();
                    this._soupSession = new Soup.Session();
                    this._setResultText(LOADING_TEXT);
                    this._callLLMAPI(text, actionType, customReq);
                };
                mailSendBtn.connect('clicked', sendAction);
                this._mailEntry.clutter_text.connect('activate', sendAction); 
            }

            // 【关键修复】确保将构建好的下拉菜单容器挂载到窗口上
            if (['translate', 'explain', 'polish', 'custom'].includes(actionType)) {
                this._resultContainer.add_child(dropdownBox);
            }

            // ======= 结果显示区 / 智能问答对话框 =======
            if (['translate', 'polish', 'explain'].includes(actionType)) {
                this._translationStatus = new St.Label({text: '', visible: false,
                    style_class: 'translator-translation-status'});
                this._resultContainer.add_child(this._translationStatus);
            }
            if (actionType === 'qa') {
                this._qaHistory = [];
                this._lastLLMResponse = '';

                this._resultWindow = new St.ScrollView({ hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC, y_expand: true, style: 'margin-bottom: 6px; min-height: 0px;' });
                this._chatContainer = this._box({ orientation: Clutter.Orientation.VERTICAL, x_expand: true });
                this._resultWindow.set_child(this._chatContainer);
                this._resultContainer.add_child(this._resultWindow);

                let qaInputBox = this._box({ orientation: Clutter.Orientation.HORIZONTAL, style_class: 'mail-entry-box' });
                
                this._qaEntry = new St.Entry({ hint_text: ' 输入您的问题 (按回车发送)...', x_expand: true, y_align: Clutter.ActorAlign.CENTER });
                let qaSendBtn = new St.Button({ child: new St.Icon({ icon_name: 'mail-send-symbolic', icon_size: 16 }), style_class: 'mail-send-btn' });
                
                qaInputBox.add_child(this._qaEntry);
                qaInputBox.add_child(qaSendBtn);
                this._resultContainer.add_child(qaInputBox);

                let sendQAAction = () => {
                    let question = this._qaEntry.get_text().trim();
                    if (!question) return;

                    // Keyboard submission can happen while the title is held.
                    // Finish that gesture before adding a new pair of bubbles.
                    this._endPopupDrag();
                    this._clearOutputSelection();

                    this._qaEntry.set_text('');

                    let userLabel = new St.Label({ text: `问: ${question}`, style_class: 'qa-chat-user', x_expand: true });
                    let userClutter = userLabel.get_clutter_text();
                    userClutter.line_wrap = true;
                    userClutter.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
                    userClutter.ellipsize = Pango.EllipsizeMode.NONE;
                    this._chatContainer.add_child(userLabel);
                    this._styleOutputFont(userLabel);
                    this._makeOutputSelectable(userLabel);

                    let llmLabel = new St.Label({ text: '答：' + LOADING_TEXT, style_class: 'qa-chat-llm', x_expand: true, style: 'text-align: left;' });
                    let llmClutter = llmLabel.get_clutter_text();
                    llmClutter.line_wrap = true;
                    llmClutter.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
                    llmClutter.ellipsize = Pango.EllipsizeMode.NONE;
                    this._chatContainer.add_child(llmLabel);
                    this._styleOutputFont(llmLabel);
                    this._makeOutputSelectable(llmLabel);

                    this._resultLabel = llmLabel;
                    
                    let actualPrompt = question;
                    if (this._qaHistory.length === 0 && text && text.trim().length > 0) {
                        actualPrompt = `【参考背景文本】\n${text}\n\n【我的问题】\n${question}`;
                    }
                    this._qaHistory.push({ role: 'user', content: actualPrompt });

                    if (this._soupSession) this._soupSession.abort();
                    this._soupSession = new Soup.Session();
                    this._callLLMAPI('', 'qa');
                };

                qaSendBtn.connect('clicked', sendQAAction);
                this._qaEntry.clutter_text.connect('activate', sendQAAction);

                let introLabel = new St.Label({ text: '✨ 请在下方输入问题以开始连续智能对话。', style_class: 'qa-chat-llm', x_expand: true, style: 'text-align: left;' });
                let introClutter = introLabel.get_clutter_text();
                introClutter.line_wrap = true;
                introClutter.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
                introClutter.ellipsize = Pango.EllipsizeMode.NONE;
                this._chatContainer.add_child(introLabel);
                this._styleOutputFont(introLabel);

            } else {
                this._resultWindow = new St.ScrollView({ hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC, y_expand: true, style: 'min-height: 0px;' });
                let contentBox = this._box({ orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_expand: true });
                this._resultLabel = new St.Label({ text: '', style_class: 'translator-result-text', y_expand: true });
                let clutterText = this._resultLabel.get_clutter_text();
                clutterText.line_wrap = true; clutterText.line_wrap_mode = Pango.WrapMode.WORD_CHAR; clutterText.ellipsize = Pango.EllipsizeMode.NONE; 
                contentBox.add_child(this._resultLabel);
                this._styleOutputFont(this._resultLabel);
                this._makeOutputSelectable(this._resultLabel);
                this._resultWindow.set_child(contentBox);
                this._resultContainer.add_child(this._resultWindow);
            }

            if (actionType === 'mail') {
                let bottomBar = this._box({ orientation: Clutter.Orientation.HORIZONTAL, style: 'margin-top: 6px; border-top: 1px solid rgba(128,128,128,0.15); padding-top: 6px; justify-content: flex-end;' });
                let copyBtnBottom = new St.Button({ child: new St.Icon({ icon_name: 'edit-copy-symbolic', icon_size: 14 }), style_class: 'translator-copy-btn' });
                this._copyButtons.add(copyBtnBottom);
                copyBtnBottom.connect('clicked', copyAction);
                bottomBar.add_child(copyBtnBottom);
                this._resultContainer.add_child(bottomBar);
            }
            if (actionType === 'ocr') {
                this._ocrRunButton = new St.Button({label: '识别',
                    style_class: 'translator-action-btn ocr-recognize-btn',
                    x_align: Clutter.ActorAlign.END});
                this._ocrRunButton.connect('clicked', () => this._runOCR());
                this._resultContainer.add_child(this._ocrRunButton);
            }

            // ======= 智能定位防溢出 =======
            const [x, y] = global.get_pointer();
            this._resultPosition = {x: x + 10, y: y + 20};
            this._constrainResultWindow([x, y]);
            const resultActor = this._resultContainer;
            resultActor.connect('notify::height', () => {
                if (this._resultContainer === resultActor)
                    this._queueResultPosition();
            });
            resultActor.connect('destroy', () => {
                if (!this._closed && this._resultContainer === resultActor)
                    this._closeUI({actorDestroyed: true});
            });
            
            Main.layoutManager.addChrome(this._resultContainer);
            // Force the actual Clutter.Text font after the theme node becomes
            // available; otherwise the first opened window relies on CSS only.
            for (const label of this._fontLabels.keys())
                this._applyVisibleTextFont(label, this._settings?.get_int('result-font-size'));
            this._resultContainer.opacity = 0;
            this._resultContainer.ease({ opacity: 255, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_CUBIC });

            // ======= 初始化等待语 =======
            if (actionType === 'mail') {
                this._setResultText('✨ 请在上方输入您的回复要求（如：委婉拒绝），然后按回车或点击发送按钮。');
            } else if (actionType === 'translate') {
                this._setResultText('✨ 请确认目标语言与翻译风格，然后点击右上方“翻译”按钮开始执行。');
            } else if (actionType === 'explain') {
                this._setResultText('✨ 请确认解释类别，然后点击右上方“解释”按钮开始执行。');
            } else if (actionType === 'polish') {
                this._setResultText('✨ 请确认润色风格，然后点击右上方“润色”按钮开始执行。');
            } else if (actionType === 'custom') {
                this._setResultText('✨ 请点击右上方“执行”按钮开始运行您的自定义系统提示词功能。');
            } else if (actionType === 'ocr') {
                this._setResultText('');
            }
            return true;
        } catch (err) {
            log(`[PopupLLM Error] UI Build Failed: ${err.message}`);
            this._closeUI();
            return false;
        }
    }

    async _callLLMAPI(text, actionType, mailCustomPrompt = '') {
        this._cancelActiveRequest();
        this._rawResponseText = '';
        const apiUrl = this._settings.get_string('api-url');
        const isStream = this._settings.get_boolean('enable-stream');
        
        let sysPrompt = '';
        let chosenModel = '';
        let finalUserText = text;
        let messagesPayload = [];
        
        if (actionType === 'explain') {
            sysPrompt = this._settings.get_string('system-prompt-explain');
            chosenModel = this._settings.get_string('model-name-explain');
            let mode = this._settings.get_string('explain-mode');
            if (mode === 'word') sysPrompt += '\n\n[当前核心要求：请侧重于“词语解释”，详细拆解词义与词根词缀]';
            else if (mode === 'grammar') sysPrompt += '\n\n[当前核心要求：请侧重于“语法解释”，分析句子结构与语法规则]';
            else if (mode === 'sentence') sysPrompt += '\n\n[当前核心要求：请侧重于“句型解释”，总结句式特征与替换用法]';
            else if (mode === 'meaning') sysPrompt += '\n\n[当前核心要求：请侧重于“含义解释”，深度剖析特定语境下的深层含义与隐喻]';
        } else if (actionType === 'polish') {
            sysPrompt = this._settings.get_string('system-prompt-polish');
            chosenModel = this._settings.get_string('model-name-polish');
            let mode = this._settings.get_string('polish-mode');
            if (mode === 'academic') sysPrompt += '\n\n[当前核心要求：请使用“学术文体”润色，严谨、客观、专业词汇准确]';
            else if (mode === 'literary') sysPrompt += '\n\n[当前核心要求：请使用“文学表达”润色，追求文采、意境和修辞之美]';
            else if (mode === 'child') sysPrompt += '\n\n[当前核心要求：请使用“儿童语言”润色，通俗易懂、生动活泼、富有童趣]';
            else if (mode === 'formal') sysPrompt += '\n\n[当前核心要求：请使用“正式文体”润色，庄重得体，适合公文或商务邮件]';
            else if (mode === 'daily') sysPrompt += '\n\n[当前核心要求：请使用“生活化表达”润色，自然流畅，符合母语口语习惯]';
            else if (mode === 'custom') {
                let custStyle = '';
                try { custStyle = this._settings.get_string('polish-custom-style'); } catch(e){}
                sysPrompt += `\n\n[当前核心要求：请完全使用用户指定的自定义风格完成文字润色调整：${custStyle || '通用风格'}]`;
            }
        } else if (actionType === 'mail') {
            sysPrompt = this._settings.get_string('system-prompt-mail');
            chosenModel = this._settings.get_string('model-name-mail');
            let customized = mailCustomPrompt.trim() ? mailCustomPrompt : "按通用礼貌格式回复";
            finalUserText = `【用户的回复指令要求】\n${customized}\n\n【需要回复的原始邮件文本】\n${text}`;
        } else if (actionType === 'qa') {
            sysPrompt = this._settings.get_string('system-prompt-qa');
            chosenModel = this._settings.get_string('model-name-qa');
        } else if (actionType === 'custom') {
            sysPrompt = this._settings.get_string('system-prompt-custom');
            chosenModel = this._settings.get_string('model-name-custom');
        } else {
            const targetLang = this._settings.get_string('target-lang');
            sysPrompt = this._settings.get_string('system-prompt') + `\n\n[Target Language: ${targetLang}]`;
            
            // 拼接翻译模块专属的“风格”提示词
            if (this._translateStyleState) {
                let styleMode = this._translateStyleState.value;
                if (styleMode === 'academic') sysPrompt += '\n[当前核心要求：请使用“学术”风格进行翻译，严谨、客观、专业词汇准确。]';
                else if (styleMode === 'literary') sysPrompt += '\n[当前核心要求：请使用“文学”风格进行翻译，追求文采、意境和修辞之美。]';
                else if (styleMode === 'tech') sysPrompt += '\n[当前核心要求：请使用“科技”风格进行翻译，术语精准，逻辑严密，符合技术文档规范。]';
                else if (styleMode === 'legal') sysPrompt += '\n[当前核心要求：请使用“法律”风格进行翻译，用词严谨、无歧义，符合法律法规。]';
                else if (styleMode === 'child') sysPrompt += '\n[当前核心要求：请使用“儿童”风格进行翻译，通俗易懂、生动活泼、富有童趣。]';
                else if (styleMode === 'formal') sysPrompt += '\n[当前核心要求：请使用“正式文体”进行翻译，庄重得体，适合公文或商务邮件。]';
                else if (styleMode === 'daily') sysPrompt += '\n[当前核心要求：请使用“生活化”风格进行翻译，自然流畅，符合母语口语习惯。]';
                else if (styleMode === 'custom') {
                    let custStyle = this._translateStyleState.customValue || '通用风格';
                    sysPrompt += `\n[当前核心要求：请完全使用用户指定的自定义风格完成翻译：${custStyle}]`;
                }
            }

            chosenModel = this._settings.get_string('model-name');
        }

        messagesPayload.push({ role: "system", content: sysPrompt });
        if (actionType === 'qa') {
            this._qaHistory.forEach(msg => {
                messagesPayload.push({ role: msg.role, content: msg.content });
            });
        } else {
            messagesPayload.push({ role: "user", content: finalUserText });
        }

        if (!chosenModel.trim()) {
            this._setResultText('尚未选择模型。请在扩展设置中，从后端实际提供的模型列表选择本功能的模型；尚未安装模型时请先安装，再刷新列表。');
            return;
        }

        let payload = {
            model: chosenModel, 
            temperature: this._settings.get_double('temperature'),
            stream: isStream,
            messages: messagesPayload
        };

        const request = {
            model: chosenModel,
            memory: this._idleModels,
            container: this._resultContainer,
            cancellable: new Gio.Cancellable(),
            finished: false,
            cancelled: false,
        };
        this._activeRequest = request;
        const waitingForUnload = request.memory?.begin(chosenModel);
        try {
            await waitingForUnload;
            const idleSeconds = modelIdleSeconds(this._settings?.get_int('model-idle-time'));
            if (this._modelBackend) {
                const info = await this._modelBackend.discover().catch(() => null);
                if (idleSeconds > 0 && ['lmstudio', 'lmstudio-legacy'].includes(info?.kind))
                    payload.ttl = idleSeconds;
            }
        } catch (_error) {
            // A failed capability probe must not block an existing compatible inference API.
        }
        if (!this._requestIsCurrent(request)) {
            this._finishRequest(request);
            return;
        }

        // All long-form plans are validated before their first API request.
        if (['translate', 'polish', 'explain'].includes(actionType)) {
            request.task = actionType === 'translate' ?
                this._runTranslation(request, payload, text, apiUrl) :
                this._runLongForm(request, payload, text, apiUrl, actionType);
        } else {
            // Keep mail, QA and arbitrary custom actions as single requests:
            // their instructions can depend on the complete input context.
            // Use the same completion-aware parser so a length stop is visible.
            request.task = this._runSingleRequest(request, payload, apiUrl, actionType);
        }
    }

    async _runSingleRequest(request, payload, endpoint, actionType) {
        const client = new TextClient(this._soupSession, endpoint, this._settings.get_string('api-key'));
        const isQA = actionType === 'qa';
        try {
            const result = await client.complete(payload, {
                cancellable: request.cancellable,
                showThoughts: this._settings.get_boolean('enable-think'),
                onText: content => {
                    if (!this._requestIsCurrent(request)) return;
                    this._rawResponseText = content;
                    this._setResultText(isQA ? `答：${content}` : content);
                    this._scrollToBottom();
                },
            });
            if (!this._requestIsCurrent(request)) return;
            this._rawResponseText = result.text;
            this._setResultText(isQA ? `答：${result.text}` : result.text);
            if (isQA) {
                this._qaHistory.push({role: 'assistant', content: result.text});
                this._lastLLMResponse = result.text;
            }
            this._scrollToBottom();
        } catch (error) {
            if (this._requestIsCurrent(request)) {
                const partial = error.partialText ? `\n\n【尚未确认的部分输出】\n${error.partialText}` : '';
                this._setResultText(`【处理未完成】${error.message.replaceAll('翻译', '处理')}${partial}`);
            }
        } finally {
            client.dispose();
            this._finishRequest(request);
        }
    }

    async _runLongForm(request, payload, source, endpoint, actionType) {
        const client = new TextClient(this._soupSession, endpoint, this._settings.get_string('api-key'));
        const done = [];
        const label = actionType === 'polish' ? '润色' : '解释';
        let plan = null;
        try {
            const limitKey = actionType === 'polish' ? 'polish-chunk-limit' : 'explain-chunk-limit';
            plan = translationPlan(source, this._settings.get_int(limitKey) || 1400);
            if (!plan.parts.length) throw new Error('没有可处理的原文。');
            const oversizeNote = plan.oversizedSentences ?
                ` · ${plan.oversizedSentences} 个超限长句保留完整` : '';
            for (let index = 0; index < plan.parts.length; index++) {
                if (!this._requestIsCurrent(request)) return;
                if (this._translationStatus) {
                    this._translationStatus.visible = plan.parts.length > 1;
                    this._translationStatus.set_text(`正在${label} ${index + 1}/${plan.parts.length} 块 · 原文 ${plan.paragraphs} 段${oversizeNote}`);
                }
                const part = plan.parts[index];
                const result = await client.complete({...payload, messages: [
                    {role: 'system', content: longFormPrompt(payload.messages[0].content,
                        actionType, index, plan.parts.length)},
                    {role: 'user', content: part.source},
                ]}, {cancellable: request.cancellable,
                    // Returning reasoning in replacement prose would destroy
                    // paragraph reconstruction: use only final output for polish.
                    showThoughts: actionType === 'explain' && this._settings.get_boolean('enable-think'),
                    onText: content => {
                        if (!this._requestIsCurrent(request)) return;
                        this._rawResponseText = longFormText(plan, done, content, actionType);
                        this._setResultText(this._rawResponseText);
                        this._scrollToBottom();
                    }});
                if (!this._requestIsCurrent(request)) return;
                done.push(result.text);
                this._rawResponseText = longFormText(plan, done, '', actionType);
                this._setResultText(this._rawResponseText);
                this._scrollToBottom();
                log(`[PopupLLM ${label}] part=${index + 1}/${plan.parts.length} source-chars=${part.source.length} bytes=${result.bytes} frames=${result.frames} finish=${result.finishReason}`);
            }
            if (this._translationStatus)
                this._translationStatus.set_text(`${label}完成 ${done.length}/${plan.parts.length} 块 · 原文 ${plan.paragraphs} 段${oversizeNote}`);
        } catch (error) {
            if (this._requestIsCurrent(request)) {
                const index = done.length + 1, total = plan?.parts.length || 1;
                const prefix = plan ? longFormText(plan, done, '', actionType) : '';
                const partial = error.partialText ? `\n本块尚未确认的部分输出：\n${error.partialText}` : '';
                this._setResultText(`${prefix}${prefix ? '\n\n' : ''}【第 ${index}/${total} 块${label}未完成】${error.message.replaceAll('翻译', label)}${partial}`);
                if (this._translationStatus) {
                    this._translationStatus.visible = true;
                    this._translationStatus.set_text(`${label}未完成：已完成 ${done.length}/${total} 块，请重试`);
                }
            }
        } finally {
            client.dispose();
            this._finishRequest(request);
        }
    }

    async _runTranslation(request, payload, source, endpoint) {
        const client = new TextClient(this._soupSession, endpoint, this._settings.get_string('api-key'));
        const completed = [];
        let plan = null;
        try {
            plan = translationPlan(source, this._settings.get_int('translation-chunk-limit') || 1400);
            if (!plan.parts.length)
                throw new Error('没有可翻译的原文。');
            // All paragraph/sentence cuts were preflighted before the first API call.
            const oversizeNote = plan.oversizedSentences ?
                ` · ${plan.oversizedSentences} 个超限长句保留完整` : '';
            for (let index = 0; index < plan.parts.length; index++) {
                if (!this._requestIsCurrent(request))
                    return;
                if (this._translationStatus) {
                    this._translationStatus.visible = plan.parts.length > 1;
                    this._translationStatus.set_text(`正在翻译 ${index + 1}/${plan.parts.length} 块 · 原文 ${plan.paragraphs} 段${oversizeNote}`);
                }
                const part = plan.parts[index];
                const result = await client.complete({...payload, messages: [
                    {role: 'system', content: translationPrompt(payload.messages[0].content, index, plan.parts.length)},
                    {role: 'user', content: part.source},
                ]}, {cancellable: request.cancellable,
                    showThoughts: this._settings.get_boolean('enable-think'),
                    onText: text => {
                        if (this._requestIsCurrent(request)) {
                            this._rawResponseText = translatedText(plan, completed, text);
                            this._setResultText(this._rawResponseText);
                            this._scrollToBottom();
                        }
                    }});
                if (!this._requestIsCurrent(request))
                    return;
                completed.push(result.text);
                this._rawResponseText = translatedText(plan, completed);
                this._setResultText(this._rawResponseText);
                this._scrollToBottom();
                log(`[PopupLLM Translation] part=${index + 1}/${plan.parts.length} source-chars=${part.source.length} bytes=${result.bytes} frames=${result.frames} finish=${result.finishReason}`);
            }
            if (this._translationStatus)
                this._translationStatus.set_text(`翻译完成 ${completed.length}/${plan.parts.length} 块 · 原文 ${plan.paragraphs} 段${oversizeNote}`);
        } catch (error) {
            if (this._requestIsCurrent(request)) {
                const index = completed.length + 1;
                const total = plan?.parts.length || 1;
                const code = error.translationCode || 'PLAN_FAILED';
                log(`[PopupLLM Translation] failed part=${index}/${total} completed=${completed.length} code=${code}`);
                const prefix = plan ? translatedText(plan, completed) : '';
                const partial = error.partialText ? `\n本段尚未确认的部分结果：\n${error.partialText}` : '';
                this._setResultText(`${prefix}${prefix ? '\n\n' : ''}【第 ${index}/${total} 段未完成】${error.message}${partial}`);
                if (this._translationStatus) {
                    this._translationStatus.visible = true;
                    this._translationStatus.set_text(`翻译未完成：已完成 ${completed.length}/${total} 块，请重试`);
                }
            }
        } finally {
            client.dispose();
            this._finishRequest(request);
        }
    }

    async _runOCR() {
        if (this._closed || !this._ocrImage || this._activeRequest || !this._settings)
            return;
        const request = {model: '', memory: null, container: this._resultContainer,
            cancellable: new Gio.Cancellable(), finished: false, cancelled: false};
        this._activeRequest = request;
        this._ocrRunButton.reactive = false;
        this._ocrRunButton.can_focus = false;
        this._ocrRunButton.add_style_pseudo_class('insensitive');
        this._ocrRunButton.set_label('正在识别……');
        let client = null;
        let phase = 'model-discovery';
        try {
            if (!this._settings.get_boolean('enable-ocr'))
                throw new Error('OCR 功能已关闭。');
            const endpoint = this._settings.get_string('api-url');
            localOllamaEndpoint(endpoint); // Reject remote screenshots before even probing.
            const info = await this._modelBackend?.discover();
            if (!this._requestIsCurrent(request))
                return;
            if (info?.kind !== 'ollama')
                throw new Error('未识别到本机 Ollama，未发送截图。请检查前部接口设置。');
            // Do not use a cached catalog if a model was installed/removed
            // while Shell remained running.
            phase = 'model-catalog';
            const catalog = await this._modelBackend.request(this._modelBackend.urls.ollamaTags);
            if (!this._requestIsCurrent(request))
                return;
            if (!isOllamaCatalog(catalog))
                throw new Error('Ollama 模型列表无效，未发送截图。');
            request.model = requireOcrModel(parseModelList(catalog), this._settings.get_string('model-name-ocr'));
            request.memory = this._idleModels;
            phase = 'model-lease';
            await request.memory?.begin(request.model);
            if (!this._requestIsCurrent(request))
                return;
            client = new OcrClient(endpoint, this._settings.get_string('api-key'));
            this._setResultText('');
            phase = 'recognize';
            const result = await client.recognize({
                model: request.model, png: this._ocrImage.png,
                prompt: this._settings.get_string('system-prompt-ocr'),
                streaming: this._settings.get_boolean('enable-stream'),
                idleSeconds: modelIdleSeconds(this._settings.get_int('model-idle-time')),
                cancellable: request.cancellable,
                onText: text => {
                    if (this._requestIsCurrent(request)) {
                        this._setResultText(text);
                        this._scrollToBottom();
                    }
                },
            });
            if (this._requestIsCurrent(request))
                this._setResultText(result || '未识别到文字。');
        } catch (error) {
            if (this._requestIsCurrent(request)) {
                const code = error.ocrCode || phase.replace(/-/g, '_').toUpperCase() + '_FAILED';
                log(`[PopupLLM OCR] recognize failed phase=${phase} code=${code}`);
                this._setResultText(error.message?.startsWith('OCR') || error.message?.includes('模型') ||
                    error.message?.includes('Ollama') || error.message?.includes('提示词') ?
                    error.message : `OCR 插件处理未完成 [${code}]，请提供 OCR 诊断日志。`);
            }
        } finally {
            client?.dispose();
            const current = this._activeRequest === request;
            this._finishRequest(request);
            if (!this._closed && this._ocrRunButton && (current || !this._activeRequest)) {
                this._ocrRunButton.set_label('识别');
                this._ocrRunButton.reactive = true;
                this._ocrRunButton.can_focus = true;
                this._ocrRunButton.remove_style_pseudo_class('insensitive');
            }
        }
    }

    _startIncrementalRead(inputStream, actionType, request) {
        if (!this._requestIsCurrent(request)) {
            inputStream.close(null);
            this._finishRequest(request);
            return;
        }

        let dataStream = new Gio.DataInputStream({
            base_stream: inputStream,
            close_base_stream: true
        });

        const readNextLine = () => {
            if (!this._requestIsCurrent(request)) {
                dataStream.close(null);
                this._finishRequest(request);
                return;
            }
            dataStream.read_line_async(GLib.PRIORITY_DEFAULT, request.cancellable, (stream, res) => {
                try {
                    let line = null;
                    if (stream.read_line_finish_utf8) {
                        let [str, len] = stream.read_line_finish_utf8(res);
                        line = str;
                    } else {
                        let [out_array, len] = stream.read_line_finish(res);
                        if (out_array) {
                            line = typeof out_array === 'string' ? out_array : new TextDecoder().decode(out_array);
                        }
                    }

                    if (!this._requestIsCurrent(request)) {
                        stream.close(null);
                        this._finishRequest(request);
                        return;
                    }
                    if (line !== null && !/^data:\s*\[DONE\]\s*$/.test(line.trim())) {
                        this._parseSingleSSELine(line, actionType);
                        readNextLine();
                    } else {
                        stream.close(null);
                        if (actionType === 'qa' && this._rawResponseText) {
                            let cleanText = this._rawResponseText;
                            if (!this._settings.get_boolean('enable-think')) {
                                cleanText = cleanText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
                            }
                            this._qaHistory.push({ role: 'assistant', content: cleanText });
                            this._lastLLMResponse = cleanText;
                        }
                        this._finishRequest(request);
                    }
                } catch (e) {
                    try { stream.close(null); } catch (_error) {}
                    this._finishRequest(request);
                }
            });
        };
        readNextLine();
    }

    _parseSingleSSELine(line, actionType) {
        let target = line.trim();
        if (!target.startsWith('data:')) return;
        if (target === 'data: [DONE]' || target === 'data:[DONE]') return;
        
        let jsonStr = target.startsWith('data: ') ? target.substring(6).trim() : target.substring(5).trim();
        try {
            let data = JSON.parse(jsonStr);
            if (!data.choices || !data.choices[0] || !data.choices[0].delta) return;
            
            let delta = data.choices[0].delta;
            let content = delta.content || (this._settings.get_boolean('enable-think') ? delta.reasoning_content : '');
            
            if (content) this._rawResponseText += content;
            let processedText = this._rawResponseText;
            
            if (!this._settings.get_boolean('enable-think')) {
                processedText = processedText.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*/g, ''); 
            }
            if (this._resultLabel) {
                this._setResultText(actionType === 'qa' ? '答：' + processedText : processedText);
                this._scrollToBottom();
            }
        } catch (e) {
        }
    }

    _scrollToBottom() {
        const window = this._resultWindow;
        if (!window)
            return;
        if (this._resizeState) {
            this._resizeState.scrollPending = true;
            return;
        }
        if (this._selectionState) {
            this._selectionState.scrollPending = true;
            return;
        }
        if (this._dragState && this._dragState.actor === this._resultContainer) {
            this._dragState.scrollPending = true;
            return;
        }
        if (this._scrollTimeoutId)
            return;
        const adjustment = window.get_vscroll_bar?.()?.get_adjustment?.();
        if (!adjustment)
            return;
        // One tracked source, not an unbounded queue of callbacks per SSE chunk.
        const sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
            if (this._scrollTimeoutId !== sourceId)
                return GLib.SOURCE_REMOVE;
            this._scrollTimeoutId = 0;
            if (this._resultWindow === window) {
                if (this._dragState && this._dragState.actor === this._resultContainer) {
                    this._dragState.scrollPending = true;
                } else {
                    adjustment.set_value(adjustment.get_upper() - adjustment.get_page_size());
                }
            }
            return GLib.SOURCE_REMOVE;
        });
        this._scrollTimeoutId = sourceId;
    }

    _cancelResultScroll() {
        if (this._scrollTimeoutId) {
            GLib.source_remove(this._scrollTimeoutId);
            this._scrollTimeoutId = 0;
        }
    }

    _makeOutputSelectable(label) {
        this._outputLabels.add(label);
        label.reactive = true;
        label.can_focus = true;
        const text = label.get_clutter_text();
        text.reactive = true;
        text.editable = false;
        text.selectable = true;
        text.cursor_visible = false;
        // Mutter 51 manages the pointer cursor per actor. A read-only Text
        // does not automatically request an I-beam; set it on both possible
        // pick targets. Never override the desktop cursor globally.
        if (Clutter.CursorType?.TEXT !== undefined) {
            label.set_cursor_type?.(Clutter.CursorType.TEXT);
            text.set_cursor_type?.(Clutter.CursorType.TEXT);
        }
        const Color = Clutter.Color || Cogl.Color;
        text.set_selection_color(new Color({red: 53, green: 132, blue: 228, alpha: 255}));
        text.set_selected_text_color(new Color({red: 255, green: 255, blue: 255, alpha: 255}));
        // Handle both possible pick targets. Do not rely on Clutter's editable
        // text press handler to create a selection in this read-only label.
        const press = (_actor, event) => this._beginOutputSelection(label, event);
        const release = (_actor, event) => this._releaseOutputSelection(label, event);
        const motion = (_actor, event) => {
            if (this._selectionState?.selecting && this._selectionState.label === label) {
                this._updateOutputSelection(this._selectionState, ...event.get_coords());
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        };
        for (const target of [label, text]) {
            target.connect('button-press-event', press);
            target.connect('button-release-event', release);
            target.connect('motion-event', motion);
        }
        text.connect('key-press-event', (_actor, event) => {
            const key = event.get_key_symbol();
            if (key === Clutter.KEY_Escape && this._owner?._handleEscape(this))
                return Clutter.EVENT_STOP;
            if (!(event.get_state() & CONTROL_MASK))
                return Clutter.EVENT_PROPAGATE;
            if (key === Clutter.KEY_c || key === Clutter.KEY_C) {
                const selected = this._getOutputSelection();
                if (selected) {
                    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, selected);
                    return Clutter.EVENT_STOP;
                }
            }
            if (key === Clutter.KEY_a || key === Clutter.KEY_A) {
                const state = this._ensureSelectionState(label);
                this._applyOutputRange(state, 0, state.map.characters.length);
                this._queueSelectionFinish(label);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _beginOutputSelection(label, event) {
        if (this._closed || this._dragState)
            return Clutter.EVENT_PROPAGATE;
        const button = event.get_button();
        if (button === 3 && this._getOutputSelection() &&
            this._settings.get_boolean('enable-popup')) {
            this._owner?._showPopupIcon(this._getOutputSelection(), {window: this});
            return Clutter.EVENT_STOP;
        }
        if (button !== 1)
            return Clutter.EVENT_PROPAGATE;
        this._copyIntent = null;
        this._owner?._activateWindow(this);
        const state = this._ensureSelectionState(label);
        const position = this._outputPositionAt(state, ...event.get_coords());
        if (position === null) {
            this._clearOutputSelection();
            return Clutter.EVENT_PROPAGATE;
        }
        state.textActor.grab_key_focus();
        const extend = typeof event.get_state === 'function' && (event.get_state() & SHIFT_MASK);
        const anchor = extend && Number.isFinite(state.anchor) ? state.anchor : position;
        state.selecting = true;
        this._applyOutputRange(state, anchor, position);
        this._stopSelectionLoop();
        this._selectionLoop = new FrameLoop(this._resultContainer, () => {
            if (this._selectionState !== state || this._closed)
                return false;
            if (this._resultContainer.visible === false ||
                Main.sessionMode?.isLocked || Main.overview?.visible) {
                this._clearOutputSelection();
                return false;
            }
            const [x, y, modifiers] = global.get_pointer();
            this._updateOutputSelection(state, x, y);
            if (!(modifiers & PRIMARY_BUTTON_MASK)) {
                this._finishOutputSelection(state);
                return false;
            }
            return true;
        }, () => this._clearOutputSelection());
        this._selectionLoop.start();
        return Clutter.EVENT_STOP;
    }

    _outputPositionAt(state, stageX, stageY) {
        if (!Number.isFinite(stageX) || !Number.isFinite(stageY))
            return null;
        const actor = state.textActor;
        const [ok, x, y] = actor.transform_stage_point(stageX, stageY);
        if (!ok || !Number.isFinite(x) || !Number.isFinite(y))
            return null;
        if (y < 0)
            return 0;
        if (actor.height > 0 && y > actor.height)
            return state.map.characters.length;
        if (state.map.bytes.at(-1) !== state.map.characters.length) {
            // Pango reports a UTF-8 byte index AND a trailing character count.
            // Rounding a compact hit down to a byte boundary loses a Chinese
            // glyph's trailing edge. Preserve both, including clamped hits in
            // the blank area after a line (where inside is deliberately false).
            try {
                const layout = actor.get_layout();
                const [offsetX, offsetY] = actor.get_layout_offsets();
                // Actor-local pointer coordinates are logical pixels; the
                // backing Pango layout and its offsets use render pixels.
                // This is independent of the actor transform already undone
                // above. Read the scale each hit so moving between monitors
                // cannot leave a cached 1x/2x conversion behind.
                const resourceScale = actor.get_resource_scale?.() ?? 1;
                if (Number.isFinite(offsetX) && Number.isFinite(offsetY) &&
                    Number.isFinite(resourceScale) && resourceScale > 0) {
                    if (this._selectionResourceScale !== resourceScale) {
                        this._selectionResourceScale = resourceScale;
                        // One metadata-only marker per window/scale change,
                        // never the selected text or per-motion logging.
                        log(`[PopupLLM] selection resource-scale=${resourceScale}`);
                    }
                    const layoutX = Math.round((x * resourceScale - offsetX) * Pango.SCALE);
                    const layoutY = Math.round((y * resourceScale - offsetY) * Pango.SCALE);
                    let [inside, index, trailing] = layout.xy_to_index(layoutX, layoutY);
                    if (!inside && trailing === 0 && Number.isInteger(index) &&
                        index >= 0 && index < state.map.bytes.at(-1)) {
                        // Soft-wrapped lines can suppress their last trailing
                        // edge. Step one native grapheme only when the pointer
                        // is past that edge on the SAME visual line; never
                        // blindly add one character or move into the next line.
                        const rect = layout.index_to_pos(index);
                        const pastEdge = rect.width > 0 ? layoutX >= rect.x + rect.width :
                            rect.width < 0 && layoutX <= rect.x + rect.width;
                        if (pastEdge && layoutY >= rect.y && layoutY < rect.y + rect.height)
                            [index, trailing] = layout.move_cursor_visually(true, index, 0, rect.width > 0 ? 1 : -1);
                    }
                    if (Number.isInteger(index) && index >= 0 && index <= state.map.bytes.at(-1) &&
                        Number.isInteger(trailing) && trailing >= 0 && trailing <= state.map.characters.length)
                        return Math.min(state.map.characters.length, characterAtByte(state.map, index) + trailing);
                }
            } catch (_error) { /* Preserve the legacy hit path if the layout API is unavailable. */ }
        }
        const position = actor.coords_to_position(x, y);
        if (!Number.isFinite(position))
            return null;
        // Legacy Clutter exposes the Pango UTF-8 byte index. Calibrate against
        // an end-caret round trip so a future character-index binding also works.
        if (state.hitUsesCharacters)
            return Math.max(0, Math.min(state.map.characters.length, position < 0 ?
                state.map.characters.length : Math.trunc(position)));
        return characterAtByte(state.map, position);
    }

    _updateOutputSelection(state, x, y) {
        if (this._selectionState !== state || !state.selecting)
            return;
        const position = this._outputPositionAt(state, x, y);
        if (position !== null)
            this._applyOutputRange(state, state.anchor, position);
    }

    _applyOutputRange(state, anchor, focus) {
        if (state.rendered && state.anchor === anchor && state.focus === focus)
            return;
        state.anchor = anchor;
        state.focus = focus;
        const range = selectionRange(state.map, anchor, focus);
        state.snapshot = range.text;
        state.rendered = true;
        // Keep native selection metadata when supported, but rendering/copying
        // do not depend on editable-only cursor/selection handling.
        try { state.textActor.set_selection(anchor, focus); } catch (_error) {}
        // Paint with Pango attributes: the highlight must not depend on editable,
        // caret visibility or which actor currently owns keyboard focus.
        const attributes = state.baseAttributes?.copy() || new Pango.AttrList();
        if (range.start !== range.end) {
            for (const attr of [
                Pango.attr_background_new(53 * 257, 132 * 257, 228 * 257),
                Pango.attr_foreground_new(65535, 65535, 65535),
            ]) {
                attr.start_index = range.byteStart;
                attr.end_index = range.byteEnd;
                attributes.insert(attr);
            }
        }
        state.textActor.set_attributes(attributes);
        state.textActor.queue_redraw();
        state.label.queue_redraw();
    }

    _finishOutputSelection(state) {
        if (this._selectionState !== state)
            return;
        state.selecting = false;
        this._stopSelectionLoop();
        this._queueSelectionFinish(state.label);
    }

    _releaseOutputSelection(label, event) {
        const state = this._selectionState;
        if (event.get_button() !== 1 || !state?.selecting || state.label !== label)
            return Clutter.EVENT_PROPAGATE;
        this._updateOutputSelection(state, ...event.get_coords());
        this._finishOutputSelection(state);
        return Clutter.EVENT_STOP;
    }

    _ensureSelectionState(label) {
        if (this._selectionState?.label !== label)
            this._clearOutputSelection();
        if (!this._selectionState) {
            const textActor = label.get_clutter_text();
            const map = makeTextMap(textActor.get_text());
            let hitUsesCharacters = false;
            if (map.bytes.at(-1) !== map.characters.length) {
                try {
                    const [ok, x, y, height] = textActor.position_to_coords(map.characters.length);
                    if (ok)
                        hitUsesCharacters = textActor.coords_to_position(x, y + Math.max(1, height / 2)) === map.characters.length;
                } catch (_error) { /* Legacy byte-index path remains the default. */ }
            }
            this._selectionState = {label, textActor, map, hitUsesCharacters,
                baseAttributes: textActor.get_attributes()?.copy() || null,
                selecting: false, pendingText: null, snapshot: null,
                scrollPending: Boolean(this._scrollTimeoutId)};
            this._cancelResultScroll();
        }
        // The same label can be reselected while its previous toolbar is visible.
        if (this._owner?._popupSource?.window === this)
            this._owner._closePopupIcon({resumeSelection: false});
        return this._selectionState;
    }

    _queueSelectionFinish(label) {
        if (this._closed || this._selectionIdleId)
            return;
        const id = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (this._selectionIdleId !== id)
                return GLib.SOURCE_REMOVE;
            this._selectionIdleId = 0;
            if (this._closed || this._writingText || this._selectionState?.selecting)
                return GLib.SOURCE_REMOVE;
            const selected = this._getOutputSelection();
            if (!selected?.length) {
                if (this._selectionState?.label === label)
                    this._clearOutputSelection();
                return GLib.SOURCE_REMOVE;
            }
            const state = this._ensureSelectionState(label);
            state.snapshot = selected;
            if (selected.trim())
                this._owner?._onInternalSelection(this, selected);
            return GLib.SOURCE_REMOVE;
        });
        this._selectionIdleId = id;
    }

    _getOutputSelection() {
        const state = this._selectionState;
        return state ? state.snapshot ?? state.textActor.get_selection() ?? '' : '';
    }

    _stopSelectionLoop() {
        const loop = this._selectionLoop;
        this._selectionLoop = null;
        loop?.stop();
    }

    _clearOutputSelection({flush = true, dismissToolbar = true} = {}) {
        this._copyIntent = null;
        this._stopSelectionLoop();
        if (this._selectionIdleId) {
            GLib.source_remove(this._selectionIdleId);
            this._selectionIdleId = 0;
        }
        const state = this._selectionState;
        this._selectionState = null;
        if (dismissToolbar && this._owner?._popupSource?.window === this)
            this._owner._closePopupIcon({resumeSelection: false});
        if (!state)
            return;
        const writing = this._writingText;
        this._writingText = true;
        try { state.textActor.set_selection(0, 0); } catch (_error) {}
        try {
            state.textActor.set_attributes(state.baseAttributes);
            state.textActor.queue_redraw();
            state.label.queue_redraw();
        } catch (_error) {}
        this._writingText = writing;
        const pending = state.pendingText;
        state.pendingText = null;
        if (flush && !this._closed) {
            if (pending && pending.label === this._resultLabel)
                this._setResultText(pending.text);
            if ((state.scrollPending || pending) && this._resultContainer?.visible !== false &&
                !Main.sessionMode?.isLocked && !Main.overview?.visible)
                this._scrollToBottom();
        }
    }

    _scheduleCopyReset(button) {
        if (this._copyResetId)
            GLib.source_remove(this._copyResetId);
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            if (this._copyResetId !== id)
                return GLib.SOURCE_REMOVE;
            this._copyResetId = 0;
            if (!this._closed)
                button.set_child(new St.Icon({icon_name: 'edit-copy-symbolic', icon_size: 14}));
            return GLib.SOURCE_REMOVE;
        });
        this._copyResetId = id;
    }

    _closeUI({actorDestroyed = false, force = false} = {}) {
        if (this._closed || (this._pinned && !actorDestroyed && !force))
            return;
        this._closed = true;
        this._endPopupResize({commit: false});
        this._endPopupDrag({commit: false});
        this._clearOutputSelection({flush: false});
        this._cancelResultPosition();
        this._cancelResultScroll();
        this._copyIntent = null;
        this._copyButtons.clear();
        this._outputLabels.clear();
        this._fontLabels.clear();
        if (this._fontSettingsId) {
            this._settings.disconnect?.(this._fontSettingsId);
            this._fontSettingsId = 0;
        }
        if (this._copyResetId) {
            GLib.source_remove(this._copyResetId);
            this._copyResetId = 0;
        }
        this._cancelActiveRequest();
        const actor = this._resultContainer;
        this._resultContainer = null;
        this._resultWindow = null;
        this._resultLabel = null;
        this._translationStatus = null;
        this._pinButton = null;
        this._closeButton = null;
        this._pinned = false;
        this._manualResultSize = null;
        this._ocrImage = null;
        this._ocrPreview?.dispose();
        this._ocrPreview = null;
        this._ocrRunButton = null;
        if (actor && !actorDestroyed) {
            Main.layoutManager.removeChrome(actor);
            actor.destroy();
        }
        this._resultSize = null;
        this._resultWorkArea = null;
        this._resultPosition = null;
        this._qaHistory = [];
        this._lastLLMResponse = '';
        this._qaEntry = null;
        this._chatContainer = null;
        this._soupSession?.abort();
        this._soupSession = null;
        const owner = this._owner;
        this._owner = null;
        this._settings = null;
        owner?._forgetWindow(this);
    }

}
