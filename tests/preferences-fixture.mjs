import {modelChoices, modelIdleSeconds, migrateModelIdleTime} from '../popup-llm-officeassistent@yanjing_chen@qq.com/backendUtils.js';
import {loadClass, Widget, settings} from './mocks.mjs';

export function prefsFixture({kind = 'ollama', values = {}, result} = {}) {
    Widget.all = [];
    const config = settings();
    for (const [key, value] of Object.entries(values)) config.values.set(key, value);
    const timers = new Map(); let timer = 0;
    const clients = [], writes = [];
    let nextResult = result === undefined ? {kind, models: [{id: 'a', label: 'a'}, {id: 'b', label: 'b'}],
        memoryStatus: 'supported', runtimeIdleSeconds: 600} : result;
    class Backend {
        constructor(endpoint) {this.endpoint = endpoint; clients.push(this);}
        async discover() {
            const result = await nextResult;
            if (result instanceof Error) throw result;
            return result;
        }
        async configureRuntimeIdle(seconds) {writes.push(seconds); nextResult = {...nextResult, runtimeIdleSeconds: seconds};}
        dispose() {this.disposed = true;}
    }
    const Preferences = loadClass('prefs.js', 'PopupLLMOfficeAssistentPreferences', {
        Adw: Object.fromEntries(['PreferencesPage', 'PreferencesGroup', 'SwitchRow', 'ComboRow', 'ActionRow',
            'EntryRow', 'PasswordEntryRow', 'ExpanderRow', 'SpinRow', 'MessageDialog'].map(name => [name, Widget])
            .concat([['ResponseAppearance', {SUGGESTED: 1}]])),
        Gtk: {Align: {CENTER: 1}, Button: Widget, Image: Widget, EventControllerKey: Widget, Adjustment: Widget,
            StringList: {new: names => names}, PropertyExpression: {new: () => ({})}},
        Gdk: {},
        GLib: {PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false,
            timeout_add: (_p, _ms, callback) => {timers.set(++timer, callback); return timer;},
            source_remove: id => timers.delete(id)},
        ExtensionPreferences: class {getSettings() {return config;}}, ModelBackend: Backend,
        modelChoices, modelIdleSeconds, migrateModelIdleTime,
    });
    const window = new Widget(); new Preferences().fillPreferencesWindow(window);
    return {window, config, clients, writes, timers,
        setResult: result => {nextResult = result;},
        runTimers: () => {for (const [id, callback] of [...timers]) {timers.delete(id); callback();}},
        byTitle: title => Widget.all.find(w => w.title === title),
        refresh: () => Widget.all.find(w => w.tooltip_text === '重新获取模型列表').emit('clicked'),
        // Keep original six-tool regression helpers scoped to those six;
        // allModels/ocrModel explicitly cover the new independent seventh row.
        models: () => Widget.all.filter(w => w.title === '模型名称 (Model)' &&
            w.get_parent()?.title !== '启用“文字识别” (Enable OCR)'),
        allModels: () => Widget.all.filter(w => w.title === '模型名称 (Model)'),
        ocrModel: () => Widget.all.find(w => w.title === '模型名称 (Model)' &&
            w.get_parent()?.title === '启用“文字识别” (Enable OCR)'),
        idle: () => Widget.all.find(w => w.title === '模型退出显存的时间 (Model Idle Timeout)'),
        apply: () => Widget.all.find(w => w.label === '应用到 Runtime'),
    };
}
