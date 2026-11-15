import {clampPopupPosition, popupDragDamage, modelIdleSeconds, migrateModelIdleTime,
    isOllamaCatalog, parseModelList} from '../popup-llm-officeassistent@yanjing_chen@qq.com/backendUtils.js';
import {pngInfo, MAX_OCR_IMAGE_BYTES, MAX_OCR_RESPONSE_BYTES, OcrStream, ocrPayload,
    requireOcrModel, localOllamaEndpoint, ocrPreviewSize, ocrError} from '../popup-llm-officeassistent@yanjing_chen@qq.com/ocrUtils.js';
import {IdleModels} from '../popup-llm-officeassistent@yanjing_chen@qq.com/idleModels.js';
import {makeTextMap, characterAtByte, selectionRange} from '../popup-llm-officeassistent@yanjing_chen@qq.com/textSelection.js';
import {loadClass, Widget, settings} from './mocks.mjs';

export function fixture({stream = false, kind = 'ollama', version = '51', nativeFrames = true, chromeBoundary = false, ocrModels = [], ocr = false, screenshotExports = {UIMode: {SCREENSHOT_ONLY: 'screenshot-only'}}} = {}) {
    const config = settings(); config.values.set('enable-stream', stream);
    config.values.set('enable-ocr', ocr);
    const settingsSignals = new Widget();
    config.connect = (...args) => settingsSignals.connect(...args);
    config.disconnect = id => settingsSignals.disconnect(id);
    config.emit = (...args) => settingsSignals.emit(...args);
    Widget.focused = null;
    const stage = new Widget(); let grabCalls = 0;
    const coglContext = {nativeContext: true};
    stage.context = {get_backend: () => ({get_cogl_context: () => coglContext})};
    stage.grab = () => { grabCalls++; throw new Error('Global input grabs forbidden'); };
    stage.get_key_focus = () => Widget.focused || null;
    // In Mutter 45–51 a pointer/button event does not carry its picked actor
    // in get_source(). The current event actor belongs to the stage instead.
    const eventActors = new WeakMap();
    const eventActorQueries = [];
    stage.get_event_actor = event => {eventActorQueries.push(event); return eventActors.get(event) || null;};
    const damages = [];
    stage.queue_redraw_with_clip = rectangle => damages.push({...rectangle});
    let pointer = [100, 150, 0], sourceId = 0, now = 0;
    // This map includes actor frame callbacks as well as GLib sources.
    const sources = new Map();
    const runSource = id => {
        const source = sources.get(id);
        if (!source) return;
        if (!source.callback()) sources.delete(id);
    };
    const runTimeouts = () => {
        for (const [id, source] of [...sources])
            if (source.type === 'timeout' || source.type === 'frame') runSource(id);
    };
    const frames = () => {
        for (const [id, source] of [...sources]) if (source.type === 'frame') runSource(id);
    };
    const flushIdles = () => {
        let iterations = 0;
        while ([...sources.values()].some(source => source.type === 'idle')) {
            if (++iterations > 10) throw new Error('Repeated allocation/reposition feedback');
            for (const [id, source] of [...sources]) if (source.type === 'idle') runSource(id);
        }
        return iterations;
    };
    const GLib = {PRIORITY_DEFAULT: 0, PRIORITY_DEFAULT_IDLE: 200, SOURCE_REMOVE: false, SOURCE_CONTINUE: true,
        source_remove: id => sources.delete(id),
        timeout_add: (_priority, ms, callback) => {sources.set(++sourceId, {type: 'timeout', ms, callback}); return sourceId;},
        timeout_add_seconds: (_priority, sec, callback) => {sources.set(++sourceId, {type: 'timeout', ms: sec * 1000, callback}); return sourceId;},
        idle_add: (_priority, callback) => {sources.set(++sourceId, {type: 'idle', callback}); return sourceId;},
        get_monotonic_time: () => now * 1000,
        base64_encode: data => Buffer.from(data).toString('base64'),
        Bytes: class {constructor(data) {this.data = data;} get_data() {return this.data;}}};
    const timelines = [];
    class Timeline {
        constructor(props) {
            if (!nativeFrames) throw new Error('native frame setup unavailable');
            Object.assign(this, props); this.signals = new Map(); this.signalId = 0;
            timelines.push(this);
        }
        connect(signal, callback) { const id = ++this.signalId; this.signals.set(id, {signal, callback}); return id; }
        disconnect(id) { this.signals.delete(id); }
        start() {
            this.running = true; this.sourceId = ++sourceId;
            sources.set(this.sourceId, {type: 'frame', timeline: this, callback: () => {
                if (!this.running) return false;
                let result = true;
                for (const {callback} of [...this.signals.values()]) result = callback(this, 0);
                return result;
            }});
        }
        stop() { this.running = false; sources.delete(this.sourceId); }
        set_actor(actor) {this.actor = actor;}
    }
    const Color = class {constructor(props) {Object.assign(this, props);}};
    const events = {MOTION: 1, BUTTON_RELEASE: 2, KEY_PRESS: 3, BUTTON_PRESS: 4};
    const Clutter = {Orientation: {HORIZONTAL: 0, VERTICAL: 1}, EventType: events, Timeline,
        ...(Number.parseInt(version, 10) < 47 ? {Color} : {}),
        ...(Number.parseInt(version, 10) >= 51 ? {CursorType: {INHERIT: 0, DEFAULT: 2, TEXT: 10}} : {}),
        OffscreenRedirect: {AUTOMATIC_FOR_OPACITY: 1, ALWAYS: 2, ON_IDLE: 4},
        ModifierType: {BUTTON1_MASK: 256, CONTROL_MASK: 4},
        EVENT_STOP: 1, EVENT_PROPAGATE: 0, KEY_Escape: 27,
        KEY_a: 97, KEY_A: 65, KEY_c: 99, KEY_C: 67,
        ContentGravity: {RESIZE_ASPECT: 1},
        ActorAlign: {CENTER: 0, END: 2}, AnimationMode: {EASE_OUT_CUBIC: 0}};
    const rectangles = [{x: 0, y: 32, width: 1920, height: 1048, index: 0},
        {x: 1920, y: 0, width: 1280, height: 800, index: 1}];
    const chrome = new Widget(), layoutSignals = new Widget(), selection = new Widget();
    // Optional reserved Shell UI boundary: ordinary addChrome actors are
    // inserted below it, not appended above every existing chrome actor.
    const chromeBoundaryActor = chromeBoundary ? new Widget({name: 'reserved-shell-ui'}) : null;
    if (chromeBoundaryActor) chrome.add_child(chromeBoundaryActor);
    const layout = {monitors: rectangles, primaryMonitor: rectangles[0],
        connect: (...args) => layoutSignals.connect(...args), disconnect: id => layoutSignals.disconnect(id),
        addChrome: actor => {
            chrome.add_child(actor);
            if (chromeBoundaryActor) chrome.set_child_below_sibling(actor, chromeBoundaryActor);
        },
        removeChrome: actor => {chrome.children = chrome.children.filter(child => child !== actor); actor.parent = null;}};
    const overview = new Widget({visible: false}), sessionMode = new Widget({isLocked: false});
    const main = {layoutManager: layout, overview, sessionMode, notify() {},
        wm: {addKeybinding() {}, removeKeybinding() {}},
        panel: {addToStatusArea() {}}, extensionManager: {openExtensionPrefs() {}}};
    const screenshotUI = new Widget({visible: false});
    screenshotUI.open = async mode => {screenshotUI.mode = mode; screenshotUI.opens = (screenshotUI.opens || 0) + 1; screenshotUI.visible = true; return true;};
    screenshotUI.close = () => {screenshotUI.visible = false; screenshotUI.emit('closed'); screenshotUI.emit('notify::visible');};
    main.screenshotUI = screenshotUI;
    const alerts = [];
    main.notify = (...args) => alerts.push(args);
    const requests = [], finishes = [], begins = [], logs = [], clipboardWrites = [];
    const clipboardValues = new Map();
    const clipboard = {get_text: (type, callback) => callback(clipboard, clipboardValues.get(type)),
        set_text: (type, text) => { clipboardValues.set(type, text); clipboardWrites.push({type, text}); }};
    const previewLoads = [], previewTextures = [];
    const St = Object.fromEntries(['BoxLayout', 'Button', 'Label', 'Icon', 'Entry', 'ScrollView', 'Bin', 'Widget'].map(name => [name, Widget])
        .concat([['PolicyType', {NEVER: 0, AUTOMATIC: 1}],
            ['ThemeContext', {get_for_stage: () => ({scale_factor: 1})}],
            ['ImageContent', {new_with_preferred_size: (width, height) => ({width, height,
                set_bytes(context, bytes, format, pixelWidth, pixelHeight, rowstride) {
                    if (context !== coglContext) throw new Error('explicit native Cogl context required');
                    previewTextures.push({context, bytes, format, pixelWidth, pixelHeight, rowstride});
                }})}],
            ['Clipboard', {get_default: () => clipboard}], ['ClipboardType', {PRIMARY: 0, CLIPBOARD: 1}]]));
    class Session {
        constructor(props = {}) {Object.assign(this, props);}
        send_and_read_async(message, _priority, cancellable, callback) {requests.push({message, cancellable, callback, session: this});}
        send_and_read_finish(result) {return {get_data: () => new TextEncoder().encode(JSON.stringify(result))};}
        send_async(message, _priority, cancellable, callback) {requests.push({message, cancellable, callback, session: this});}
        send_finish(result) {return result;}
        abort() {this.aborted = true;}
    }
    const shared = {
        Config: {PACKAGE_VERSION: version}, clampPopupPosition, popupDragDamage, modelIdleSeconds, migrateModelIdleTime,
        makeTextMap, characterAtByte, selectionRange,
        Mtk: {Rectangle: class {constructor(properties) {Object.assign(this, properties);}}},
        St, Clutter, Cogl: {Color, PixelFormat: {RGBA_8888: 4, RGB_888: 3}}, GLib,
        GdkPixbuf: {Pixbuf: {
            new_from_stream_at_scale_async(stream, width, height, preserve, cancellable, callback) {
                previewLoads.push({stream, width, height, preserve, cancellable, callback});
                const original = pngInfo(stream.bytes.data);
                const size = ocrPreviewSize(original.width, original.height, width, height);
                queueMicrotask(() => callback(null, {size, cancellable}));
            },
            new_from_stream_finish(result) {
                if (result.cancellable.is_cancelled()) throw new Error('cancelled');
                return {get_width: () => result.size.width, get_height: () => result.size.height,
                    get_has_alpha: () => true, get_rowstride: () => result.size.width * 4,
                    read_pixel_bytes: () => new GLib.Bytes(new Uint8Array(result.size.width * result.size.height * 4))};
            },
        }},
        Gio: {Cancellable: class {cancel() {this.cancelled = true;} is_cancelled() {return !!this.cancelled;}},
            BytesIcon: class {constructor(props) {Object.assign(this, props);}},
            MemoryInputStream: {new_from_bytes: bytes => ({bytes, closed: false,
                close_async(_p, _c, callback) {this.closed = true; callback?.(this, {});}, close_finish() {}})},
            SimpleProxyResolver: {new: () => ({localOnly: true})},
            DataInputStream: class {
                constructor(props) {Object.assign(this, props); this.lines = [...props.base_stream.lines];}
                read_line_async(_priority, cancellable, callback) {queueMicrotask(() => callback(this, {line: this.lines.shift() ?? null, cancellable}));}
                read_line_finish_utf8(result) {
                    if (result.cancellable.cancelled) throw new Error('cancelled');
                    return [result.line, 0];
                }
                close() {this.base_stream.closed = true;}
            }},
        Soup: {Session, MessageFlags: {NO_REDIRECT: 8}, Message: {new: (_method, url) => ({url, status_code: 200,
            get_flags() {return this.flags || 0;}, set_flags(value) {this.flags = value;}, request_headers: {append() {}},
            set_request_body_from_bytes(_type, bytes) {this.payload = JSON.parse(new TextDecoder().decode(bytes.data));}})}},
        Pango: {SCALE: 1024, WrapMode: {WORD_CHAR: 0}, EllipsizeMode: {NONE: 0},
            AttrList: class {
                constructor() {this.items = [];}
                insert(value) {this.items.push(value);}
                copy() {const result = new this.constructor(); result.items = this.items.map(item => ({...item})); return result;}
            },
            attr_background_new: (red, green, blue) => ({kind: 'background', red, green, blue}),
            attr_foreground_new: (red, green, blue) => ({kind: 'foreground', red, green, blue})},
        Main: main, log: value => logs.push(value),
        global: {stage, get_pointer: () => pointer, display: {get_selection: () => selection},
            workspace_manager: {get_active_workspace: () => ({get_work_area_for_monitor: index => rectangles[index]})}},
    };
    const FrameLoop = loadClass('frameLoop.js', 'FrameLoop', shared);
    const OcrClient = loadClass('ocrClient.js', 'OcrClient', {...shared, pngInfo, localOllamaEndpoint, ocrPayload,
        OcrStream, ocrError, MAX_OCR_RESPONSE_BYTES});
    const OcrPreview = loadClass('ocrPreview.js', 'OcrPreview', {...shared, pngInfo, ocrPreviewSize});
    const NativeScreenshot = loadClass('nativeScreenshot.js', 'NativeScreenshot', {...shared, pngInfo, MAX_OCR_IMAGE_BYTES,
        Screenshot: screenshotExports});
    const ResultWindow = loadClass('resultWindow.js', 'ResultWindow', {...shared, FrameLoop, OcrClient, OcrPreview,
        pngInfo, localOllamaEndpoint, requireOcrModel, isOllamaCatalog, parseModelList});
    const Manager = loadClass('extension.js', 'PopupLLMOfficeAssistent', {...shared, ResultWindow, NativeScreenshot,
        Extension: class {}, IdleModels,
        ModelBackend: class {async discover() {return {kind};} dispose() {} async unload() {}},
        PanelMenu: {Button: class extends Widget {constructor(...args) {super(); this.menu = new Widget();}}},
        PopupMenu: {PopupMenuItem: class extends Widget {constructor(text) {super({text});}}},
        Meta: {KeyBindingFlags: {NONE: 0}, SelectionType: {PRIMARY: 0}}, Shell: {ActionMode: {ALL: 1}}});
    const manager = new Manager();
    manager.getSettings = () => config;
    manager._settings = config; manager._windows = new Set(); manager._selection = selection;
    manager._translateStyleState = {id: 'translate-mode', value: 'general', customValue: ''};
    manager._idleModels = {begin: async model => begins.push(model), finish: model => finishes.push(model), dispose() {}};
    let serverModels = ocrModels;
    manager._modelBackend = {discover: async () => ({kind}), dispose() {},
        urls: {ollamaTags: 'http://localhost:11434/api/tags'},
        request: async () => ({models: serverModels.map(name => ({name, digest: 'actual-digest'}))})};
    const extension = new ResultWindow(manager);
    manager._windows.add(extension); manager._activeWindow = extension;
    // A minimal attached result is sufficient for pure request/positioning tests.
    extension._resultContainer = new Widget(); extension._resultLabel = new Widget();
    extension._qaHistory = [{role: 'user', content: 'question'}];
    return {extension, manager, config, requests, finishes, begins, stage, events, logs, sources, main, damages, timelines,
        OcrClient, OcrPreview, previewLoads, previewTextures, NativeScreenshot, screenshotUI, alerts,
        Gio: shared.Gio, setOcrModels: models => {serverModels = models;},
        eventActorQueries, registerEventActor: (event, actor) => eventActors.set(event, actor),
        St, Clutter, GLib, Pango: shared.Pango, chrome, chromeBoundaryActor, selection, clipboardValues, clipboardWrites, ResultWindow, FrameLoop,
        pointer: value => {pointer = value;}, runTimeouts, tick: runTimeouts, frames, flushIdles,
        advance: ms => {now += ms;}, grabCalls: () => grabCalls,
        createWindow: (text = 'selected text', action = 'translate', options = {}) => manager._showResultWindow(text, action, options),
        reply: (index, content = 'answer') => requests[index].callback(requests[index].session, {choices: [{message: {content}}]}),
    };
}
