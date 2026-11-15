import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import {ModelBackend} from './modelBackend.js';
import {IdleModels} from './idleModels.js';
import {clampPopupPosition, migrateModelIdleTime} from './backendUtils.js';
import {ResultWindow} from './resultWindow.js';
import {NativeScreenshot} from './nativeScreenshot.js';

export default class PopupLLMOfficeAssistent extends Extension {
    enable() {
        this._generation = (this._generation || 0) + 1;
        this._settings = this.getSettings();
        migrateModelIdleTime(this._settings);
        this._lastText = null;
        this._ownerChangedId = null;
        this._windows = new Set();
        this._translateStyleState = {id: 'translate-mode', value: 'general', customValue: ''};
        this._resetModelBackend();

        this._indicator = new PanelMenu.Button(0.0, 'PopupLLMOfficeAssistent', false);
        let icon = new St.Icon({ icon_name: 'accessories-dictionary-symbolic', style_class: 'system-status-icon' });
        this._indicator.add_child(icon);

        let settingsItem = new PopupMenu.PopupMenuItem('打开设置 (Settings)');
        settingsItem.connect('activate', () => Main.extensionManager.openExtensionPrefs(this.uuid, '', null));
        this._indicator.menu.addMenuItem(settingsItem);
        Main.panel.addToStatusArea('PopupLLMOfficeAssistent', this._indicator);

        this._selection = global.display.get_selection();
        
        this._settingsChangedId = this._settings.connect('changed', (_settings, key) => {
            if (['enable-popup', 'popup-mode', 'popup-shortcut'].includes(key))
                this._updatePopupMode();
            if (['api-url', 'api-key'].includes(key))
                this._resetModelBackend();
            if (key === 'model-idle-time')
                this._idleModels?.setSeconds(this._settings.get_int(key));
            if (key === 'enable-ocr' && !this._settings.get_boolean(key))
                this._cancelOCRCapture();
        });
        this._updatePopupMode();
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            this._cancelOCRCapture();
            this._stopInteractions();
            for (const window of this._windows) {
                const actor = window._resultContainer;
                if (actor)
                    window._constrainResultWindow([actor.x + 16, actor.y + 16]);
            }
        });
        this._overviewShowingId = Main.overview.connect('showing', () => {
            this._cancelOCRCapture();
            this._stopInteractions();
        });
        this._sessionUpdatedId = Main.sessionMode.connect('updated', () => {
            if (Main.sessionMode.isLocked) {
                this._cancelOCRCapture();
                this._stopInteractions();
            }
        });
        this._escEventId = global.stage.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape && this._handleEscape())
                return Clutter.EVENT_STOP;
            return Clutter.EVENT_PROPAGATE;
        });
        // One version-only runtime marker distinguishes loaded JS modules from
        // files that were replaced on disk without starting a new Shell session.
        log(`[PopupLLM] Loaded build=2.2.4-selection-render-scale-fix shell=${Config.PACKAGE_VERSION}`);
    }

    disable() {
        this._generation = (this._generation || 0) + 1;
        this._cancelOCRCapture();
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }
        if (this._overviewShowingId) {
            Main.overview.disconnect(this._overviewShowingId);
            this._overviewShowingId = 0;
        }
        if (this._sessionUpdatedId) {
            Main.sessionMode.disconnect(this._sessionUpdatedId);
            this._sessionUpdatedId = 0;
        }
        this._unbindKey();
        if (this._ownerChangedId && this._selection) {
            this._selection.disconnect(this._ownerChangedId);
            this._ownerChangedId = null;
        }
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        if (this._escEventId) {
            global.stage.disconnect(this._escEventId);
            this._escEventId = null;
        }
        this._closeUI();
        this._idleModels?.dispose();
        this._idleModels = null;
        this._modelBackend?.dispose();
        this._modelBackend = null;
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        this._settings = null;

    }

    _resetModelBackend() {
        this._cancelOCRCapture();
        for (const window of this._windows || [])
            window._cancelActiveRequest();
        this._idleModels?.dispose();
        this._modelBackend?.dispose();
        this._modelBackend = null;
        this._idleModels = null;
        this._memoryWarningShown = false;
        try {
            const backend = new ModelBackend(this._settings.get_string('api-url'), this._settings.get_string('api-key'));
            this._modelBackend = backend;
            this._idleModels = new IdleModels({
                schedule: (ms, callback) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1, Math.ceil(ms)), () => {
                    callback();
                    return GLib.SOURCE_REMOVE;
                }),
                cancel: id => GLib.source_remove(id),
                now: () => GLib.get_monotonic_time() / 1000,
                unload: async model => {
                    const info = await backend.discover();
                    if (info.kind === 'runtime')
                        return; // Runtime owns its shared idle policy; never alter it from Shell.
                    if (info.kind === 'lmstudio-legacy' && this._settings?.get_int('model-idle-time') > 0)
                        return; // Legacy servers manage JIT TTL themselves.
                    await backend.unload(model);
                },
                report: error => {
                    if (!this._settings || this._modelBackend !== backend || this._memoryWarningShown)
                        return;
                    this._memoryWarningShown = true;
                    Main.notify('Popup LLM：未能释放模型显存', error.message);
                },
            });
            this._idleModels.setSeconds(this._settings.get_int('model-idle-time'));
        } catch (_error) {
            // Model discovery may not understand a custom URL; existing inference still works.
        }
    }

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

    _unbindKey() {
        Main.wm.removeKeybinding('popup-shortcut');
    }


    _updatePopupMode() {
        this._selectionGeneration = (this._selectionGeneration || 0) + 1;
        this._primarySerial = (this._primarySerial || 0) + 1;
        this._unbindKey();
        this._closePopupIcon();
        if (this._selectionCheckId) {
            GLib.source_remove(this._selectionCheckId);
            this._selectionCheckId = 0;
        }
        if (this._ownerChangedId) {
            this._selection.disconnect(this._ownerChangedId);
            this._ownerChangedId = null;
        }
        if (!this._settings.get_boolean('enable-popup'))
            return;
        this._ownerChangedId = this._selection.connect('owner-changed', (_selection, type) => {
            if (Meta.SelectionType && type !== Meta.SelectionType.PRIMARY)
                return;
            this._primarySerial++;
            if (this._settings.get_string('popup-mode') !== 'auto')
                return;
            if (this._selectionCheckId)
                GLib.source_remove(this._selectionCheckId);
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
                if (this._selectionCheckId !== id)
                    return GLib.SOURCE_REMOVE;
                this._selectionCheckId = 0;
                if (this._settings)
                    this._checkPrimarySelection();
                return GLib.SOURCE_REMOVE;
            });
            this._selectionCheckId = id;
        });
        if (this._settings.get_string('popup-mode') !== 'auto') {
            Main.wm.addKeybinding('popup-shortcut', this._settings, Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.ALL, () => {
                    const window = this._activeWindow;
                    const text = window?._getOutputSelection();
                    // An external PRIMARY change takes precedence over an old
                    // retained result selection, even if the text is identical.
                    if (text && window._selectionState?.primarySerial === this._primarySerial) {
                        this._showPopupIcon(text, {window});
                        return;
                    }
                    this._checkPrimarySelection(true, text ? {window, text} : null);
                });
        }
    }

    _checkPrimarySelection(force = false, fallback = null) {
        if (!this._settings || this._ocrCapture || !this._settings.get_boolean('enable-popup'))
            return;
        const settings = this._settings;
        const generation = this._generation;
        const selectionGeneration = this._selectionGeneration;
        const primarySerial = this._primarySerial;
        // A cold/empty PRIMARY may never invoke get_text's callback. Explicit
        // shortcuts must still expose input-independent actions such as OCR.
        // Enrich this particular toolbar if text arrives; never reopen one
        // already dismissed, timed out or replaced by a newer shortcut.
        let pendingToolbar = null;
        if (force) {
            this._showPopupIcon('', null, true);
            pendingToolbar = this._popupContainer;
            if (!pendingToolbar)
                return;
        }
        const onText = (_clipboard, text) => {
            if (this._settings !== settings || this._generation !== generation ||
                this._selectionGeneration !== selectionGeneration)
                return;
            if (force && (this._popupContainer !== pendingToolbar || this._primarySerial !== primarySerial))
                return;
            if (!text?.trim()) {
                if (fallback?.text?.trim() && !fallback.window._closed &&
                    fallback.window._getOutputSelection() === fallback.text)
                    this._showPopupIcon(fallback.text, {window: fallback.window});
                return;
            }
            // Native output selection uses a direct local path, not PRIMARY.
            if (!force && [...this._windows].some(window =>
                window._selectionState?.selecting || window._selectionIdleId))
                return;
            if (force || text !== this._lastText) {
                this._lastText = text;
                this._showPopupIcon(text);
            }
        };
        try {
            St.Clipboard.get_default().get_text(St.ClipboardType.PRIMARY, onText);
        } catch (_error) {
            if (force)
                log('[PopupLLM] shortcut PRIMARY unavailable; empty toolbar is ready');
        }
    }

    _onInternalSelection(window, text) {
        if (!this._settings || window._closed || !text?.trim())
            return;
        this._activateWindow(window);
        if (window._selectionState)
            window._selectionState.primarySerial = this._primarySerial;
        this._lastText = text;
        if (this._settings.get_boolean('enable-popup') &&
            this._settings.get_string('popup-mode') === 'auto')
            this._showPopupIcon(text, {window});
    }

    _showPopupIcon(text, source = null, allowEmpty = false) {
        const hasText = !!text?.trim();
        if (!this._settings || this._ocrCapture || Main.sessionMode.isLocked || (!hasText && !allowEmpty))
            return;
        this._closePopupIcon({resumeSelection: this._popupSource?.window !== source?.window});
        this._popupSource = source;
        const iconSize = this._settings.get_int('icon-size');
        const actor = this._popupContainer = this._box({
            orientation: Clutter.Orientation.HORIZONTAL, style_class: 'translator-popup-container'});
        const actions = [
            ['translate', 'translator-popup-icon', 'preferences-desktop-locale-symbolic'],
            ['explain', 'explain-popup-icon', 'accessories-dictionary-symbolic'],
            ['polish', 'translator-popup-icon', 'document-edit-symbolic'],
            ['mail', 'mail-popup-icon', 'mail-unread-symbolic'],
            ['qa', 'qa-popup-icon', 'system-help-symbolic'],
            ['ocr', 'ocr-popup-icon', 'camera-photo-symbolic'],
            ['custom', 'custom-popup-icon', 'preferences-system-symbolic'],
        ];
        let count = 0;
        for (const [action, style, icon] of actions) {
            if (!this._settings.get_boolean('enable-' + action))
                continue;
            const usable = hasText || action === 'ocr';
            const button = new St.Button({style_class: style, track_hover: true,
                reactive: usable, can_focus: usable,
                child: new St.Icon({icon_name: icon, icon_size: iconSize})});
            if (!usable)
                button.add_style_pseudo_class('insensitive');
            button.connect('clicked', () => {
                if (!usable || this._popupContainer !== actor || !this._settings)
                    return;
                // Snapshot before clearing the selection or allowing streaming to resume.
                const translateStyle = source?.window ?
                    {...source.window._translateStyleState} : {...this._translateStyleState};
                this._closePopupIcon();
                if (action === 'ocr') {
                    log('[PopupLLM OCR] camera button clicked');
                    this._startOCRCapture();
                    return;
                }
                const id = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    if (this._actionIdleId !== id)
                        return GLib.SOURCE_REMOVE;
                    this._actionIdleId = 0;
                    if (this._settings)
                        this._showResultWindow(text, action, {translateStyle});
                    return GLib.SOURCE_REMOVE;
                });
                this._actionIdleId = id;
            });
            actor.add_child(button);
            count++;
        }
        if (!count) {
            this._closePopupIcon({resumeSelection: false});
            return;
        }
        const [x, y] = global.get_pointer();
        const area = this._monitorAt(x, y);
        const position = clampPopupPosition(x + 15, y + 15,
            count * (iconSize + 22), iconSize + 16, area);
        actor.set_position(position.x, position.y);
        Main.layoutManager.addChrome(actor);
        this._raisePopupIcon();
        actor.opacity = 255; // Immediate, stable toolbar; result windows keep their own fade.
        const seconds = this._settings.get_int('auto-close-time');
        if (seconds > 0) {
            const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
                if (this._iconTimeoutId !== id || this._popupContainer !== actor)
                    return GLib.SOURCE_REMOVE;
                this._iconTimeoutId = 0;
                this._closePopupIcon({resumeSelection: false});
                return GLib.SOURCE_REMOVE;
            });
            this._iconTimeoutId = id;
        }
    }

    _closePopupIcon({resumeSelection = true} = {}) {
        for (const key of ['_iconTimeoutId', '_actionIdleId']) {
            if (this[key]) {
                GLib.source_remove(this[key]);
                this[key] = 0;
            }
        }
        const source = this._popupSource;
        this._popupSource = null;
        if (this._popupContainer) {
            const actor = this._popupContainer;
            this._popupContainer = null;
            Main.layoutManager.removeChrome(actor);
            actor.destroy();
        }
        if (resumeSelection)
            source?.window?._clearOutputSelection({dismissToolbar: false});
    }

    _showResultWindow(text, action, options = {}) {
        if (!this._settings || Main.sessionMode.isLocked)
            return null;
        this._closePopupIcon();
        const window = new ResultWindow(this, options);
        this._windows.add(window);
        if (!window._showResultWindow(text, action)) {
            window._closeUI();
            return null;
        }
        this._activateWindow(window);
        return window;
    }

    async _startOCRCapture() {
        if (!this._settings || this._ocrCapture || Main.sessionMode.isLocked ||
            !this._settings.get_boolean('enable-ocr'))
            return;
        const generation = this._generation;
        let capture = null;
        log('[PopupLLM OCR] native capture requested');
        try {
            capture = new NativeScreenshot(() => this._hideForScreenshot());
            this._ocrCapture = capture;
            const image = await capture.capture();
            if (this._ocrCapture !== capture || !this._settings || this._generation !== generation)
                return;
            this._ocrCapture = null;
            if (image && !Main.sessionMode.isLocked && this._settings.get_boolean('enable-ocr')) {
                log('[PopupLLM OCR] native capture completed');
                this._showResultWindow('', 'ocr', {ocrImage: image});
            } else {
                log('[PopupLLM OCR] native capture cancelled');
            }
        } catch (error) {
            if ((this._ocrCapture === capture || !capture) && this._settings && this._generation === generation) {
                log(`[PopupLLM OCR] native capture failed code=${error.ocrCode || 'SETUP_FAILED'}`);
                Main.notify('Popup LLM：截图未完成', error.message);
            }
        } finally {
            if (this._ocrCapture === capture)
                this._ocrCapture = null;
        }
    }

    _cancelOCRCapture() {
        const capture = this._ocrCapture;
        this._ocrCapture = null;
        capture?.cancel();
    }

    _hideForScreenshot() {
        this._closePopupIcon();
        const hidden = [];
        // Restore only actors which still belong to live windows. No window is
        // destroyed/recreated and no text-selection implementation is changed.
        const restore = () => {
            for (const {window, actor, visible} of hidden) {
                try {
                    if (!window._closed && window._resultContainer === actor)
                        actor.visible = visible;
                } catch (_error) {}
            }
        };
        try {
            for (const window of this._windows) {
                window._endPopupDrag();
                const actor = window._resultContainer;
                if (actor) {
                    hidden.push({window, actor, visible: actor.visible});
                    actor.visible = false;
                }
            }
        } catch (error) {
            restore();
            throw error;
        }
        return restore;
    }

    _topResultActor(parent) {
        const actors = new Set([...(this._windows || [])]
            .filter(window => !window._closed)
            .map(window => window._resultContainer));
        let top = null;
        for (const child of parent.get_children()) {
            if (actors.has(child))
                top = child;
        }
        return top;
    }

    _raisePopupIcon() {
        const actor = this._popupContainer;
        const parent = actor?.get_parent();
        if (!parent)
            return;
        const top = this._topResultActor(parent);
        if (!top)
            return;
        const siblings = parent.get_children();
        // Never lower a toolbar that is already above the results. Reorder
        // actual siblings only; no global-top actor, new overlay or polling.
        if (siblings.indexOf(actor) < siblings.indexOf(top))
            parent.set_child_above_sibling(actor, top);
    }

    _activateWindow(window) {
        if (!this._windows.has(window) || window._closed)
            return;
        if (this._activeWindow && this._activeWindow !== window)
            this._activeWindow._endPopupDrag();
        this._windows.delete(window);
        this._windows.add(window);
        this._activeWindow = window;
        const actor = window._resultContainer;
        const parent = actor?.get_parent();
        if (parent) {
            const top = this._topResultActor(parent);
            // Raise only among our own results, preserving Shell's other UI
            // layers. Using a null sibling here would cover the toolbar too.
            if (top && top !== actor)
                parent.set_child_above_sibling(actor, top);
        }
        this._raisePopupIcon();
    }

    _forgetWindow(window) {
        if (this._popupSource?.window === window)
            this._closePopupIcon({resumeSelection: false});
        this._windows.delete(window);
        if (this._activeWindow === window)
            this._activeWindow = [...this._windows].at(-1) || null;
    }

    _handleEscape(window = this._activeWindow) {
        if (this._ocrCapture)
            return false; // Native screenshot UI owns Esc during this task.
        if (this._popupContainer) {
            this._closePopupIcon();
            return true;
        }
        if (window && !window._closed) {
            if (window._selectionState) {
                window._clearOutputSelection();
                return true;
            }
            window._closeUI();
            return true;
        }
        return false;
    }

    _stopInteractions() {
        this._closePopupIcon();
        for (const window of this._windows) {
            window._endPopupDrag();
            window._clearOutputSelection();
        }
    }

    _closeUI() {
        this._closePopupIcon();
        if (this._selectionCheckId) {
            GLib.source_remove(this._selectionCheckId);
            this._selectionCheckId = 0;
        }
        for (const window of [...(this._windows || [])])
            window._closeUI();
        this._activeWindow = null;
        this._lastText = null;
    }

}
