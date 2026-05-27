import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class PopupLLMOfficeAssistentPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        const groupWakeup = new Adw.PreferencesGroup({ title: '全局唤醒与图标控制 (Wakeup & Icon Control)' });
        const groupAPI = new Adw.PreferencesGroup({ title: 'LLM API 与功能联动设置 (LLM API & Features)' });
        const groupUI = new Adw.PreferencesGroup({ title: '界面交互 (UI & Interaction)' });

        // ==========================================
        // 全局唤醒控制块 (包含优化后的快捷键录制)
        // ==========================================
        const rowEnablePopup = new Adw.SwitchRow({ title: '启用悬浮图标 (Enable Popup)', active: settings.get_boolean('enable-popup') });
        
        // 修复：精简文案长度，防止 GNOME Adwaita 控件宽度受限导致截断
        const modeNames = ['划词弹出 (Auto)', '快捷键唤出 (Shortcut)'];
        const modeCodes = ['auto', 'shortcut'];
        const rowPopupMode = new Adw.ComboRow({ title: '  └─ 唤出方式 (Mode)', model: Gtk.StringList.new(modeNames) });
        rowPopupMode.set_selected(Math.max(0, modeCodes.indexOf(settings.get_string('popup-mode'))));
        
        let currentShortcutArr = settings.get_strv('popup-shortcut');
        let currentShortcut = (currentShortcutArr && currentShortcutArr.length > 0) ? currentShortcutArr[0] : '';

        const rowShortcut = new Adw.ActionRow({ title: '  └─ 快捷键 (Shortcut Key)', subtitle: '点击右侧按钮后，直接按下新的快捷键' });
        const shortcutButton = new Gtk.Button({ label: currentShortcut, valign: Gtk.Align.CENTER });
        rowShortcut.add_suffix(shortcutButton);
        
        let keyController = new Gtk.EventControllerKey();
        let isRecording = false;

        shortcutButton.connect('clicked', () => {
            if (isRecording) {
                isRecording = false;
                let arr = settings.get_strv('popup-shortcut');
                shortcutButton.set_label((arr && arr.length > 0) ? arr[0] : '');
                shortcutButton.remove_css_class('suggested-action');
            } else {
                isRecording = true;
                shortcutButton.set_label('请按下快捷键... (Press keys)');
                shortcutButton.add_css_class('suggested-action');
            }
        });

        keyController.connect('key-pressed', (controller, keyval, keycode, state) => {
            if (!isRecording) return false;
            
            let mask = state & Gtk.accelerator_get_default_mod_mask();
            if (mask === 0 && keyval >= Gdk.KEY_Shift_L && keyval <= Gdk.KEY_Hyper_R) return false;
            
            if (keyval === Gdk.KEY_Escape && mask === 0) {
                isRecording = false;
                let arr = settings.get_strv('popup-shortcut');
                shortcutButton.set_label((arr && arr.length > 0) ? arr[0] : '');
                shortcutButton.remove_css_class('suggested-action');
                return true;
            }
            
            let shortcutString = Gtk.accelerator_name(keyval, mask);
            if (shortcutString && shortcutString.length > 0) {
                settings.set_strv('popup-shortcut', [shortcutString]);
                shortcutButton.set_label(shortcutString);
                isRecording = false;
                shortcutButton.remove_css_class('suggested-action');
                return true;
            }
            return false;
        });
        shortcutButton.add_controller(keyController);
        
        const toggleWakeupSensitivity = () => {
            let isEnabled = rowEnablePopup.get_active();
            let isShortcut = (modeCodes[rowPopupMode.get_selected()] === 'shortcut');
            rowPopupMode.set_sensitive(isEnabled);
            rowShortcut.set_sensitive(isEnabled && isShortcut);
        };
        rowEnablePopup.connect('notify::active', () => { settings.set_boolean('enable-popup', rowEnablePopup.get_active()); toggleWakeupSensitivity(); });
        rowPopupMode.connect('notify::selected', () => { settings.set_string('popup-mode', modeCodes[rowPopupMode.get_selected()]); toggleWakeupSensitivity(); });
        toggleWakeupSensitivity();
        
        groupWakeup.add(rowEnablePopup); groupWakeup.add(rowPopupMode); groupWakeup.add(rowShortcut);

        // ==========================================
        // 公共 API 配置
        // ==========================================
        const rowApiUrl = new Adw.EntryRow({ title: '接口链接 (API Endpoint)', text: settings.get_string('api-url') });
        rowApiUrl.connect('changed', (entry) => settings.set_string('api-url', entry.get_text()));
        groupAPI.add(rowApiUrl);

        const rowApiKey = new Adw.PasswordEntryRow({ title: 'API 密钥 (API Key, Optional)', text: settings.get_string('api-key') });
        rowApiKey.connect('changed', (entry) => settings.set_string('api-key', entry.get_text()));
        groupAPI.add(rowApiKey);

        // ==========================================
        // 1. 智能翻译配置块
        // ==========================================
        const rowEnableTranslate = new Adw.SwitchRow({ title: '启用“智能翻译” (Enable Translation)', active: settings.get_boolean('enable-translate') });
        const rowModelTranslate = new Adw.EntryRow({ title: '  └─ 模型名称 (Model)', text: settings.get_string('model-name') });
        const rowPromptTranslate = new Adw.EntryRow({ title: '  └─ 系统提示词 (Prompt)', text: settings.get_string('system-prompt') });
        
        const toggleTranslate = (isActive) => { rowModelTranslate.set_sensitive(isActive); rowPromptTranslate.set_sensitive(isActive); };
        rowEnableTranslate.connect('notify::active', () => { settings.set_boolean('enable-translate', rowEnableTranslate.get_active()); toggleTranslate(rowEnableTranslate.get_active()); });
        rowModelTranslate.connect('changed', (entry) => settings.set_string('model-name', entry.get_text()));
        rowPromptTranslate.connect('changed', (entry) => settings.set_string('system-prompt', entry.get_text()));
        toggleTranslate(rowEnableTranslate.get_active());
        groupAPI.add(rowEnableTranslate); groupAPI.add(rowModelTranslate); groupAPI.add(rowPromptTranslate);

        // ==========================================
        // 2. 智能解释配置块
        // ==========================================
        const rowEnableExplain = new Adw.SwitchRow({ title: '启用“核心解释” (Enable Explanation)', active: settings.get_boolean('enable-explain') });
        const rowModelExplain = new Adw.EntryRow({ title: '  └─ 模型名称 (Model)', text: settings.get_string('model-name-explain') });
        const rowPromptExplain = new Adw.EntryRow({ title: '  └─ 系统提示词 (Prompt)', text: settings.get_string('system-prompt-explain') });
        
        const toggleExplain = (isActive) => { rowModelExplain.set_sensitive(isActive); rowPromptExplain.set_sensitive(isActive); };
        rowEnableExplain.connect('notify::active', () => { settings.set_boolean('enable-explain', rowEnableExplain.get_active()); toggleExplain(rowEnableExplain.get_active()); });
        rowModelExplain.connect('changed', (entry) => settings.set_string('model-name-explain', entry.get_text()));
        rowPromptExplain.connect('changed', (entry) => settings.set_string('system-prompt-explain', entry.get_text()));
        toggleExplain(rowEnableExplain.get_active());
        groupAPI.add(rowEnableExplain); groupAPI.add(rowModelExplain); groupAPI.add(rowPromptExplain);

        // ==========================================
        // 3. 文字润色配置块
        // ==========================================
        const rowEnablePolish = new Adw.SwitchRow({ title: '启用“文字润色” (Enable Polishing)', active: settings.get_boolean('enable-polish') });
        const rowModelPolish = new Adw.EntryRow({ title: '  └─ 模型名称 (Model)', text: settings.get_string('model-name-polish') });
        const rowPromptPolish = new Adw.EntryRow({ title: '  └─ 系统提示词 (Prompt)', text: settings.get_string('system-prompt-polish') });
        
        const togglePolish = (isActive) => { rowModelPolish.set_sensitive(isActive); rowPromptPolish.set_sensitive(isActive); };
        rowEnablePolish.connect('notify::active', () => { settings.set_boolean('enable-polish', rowEnablePolish.get_active()); togglePolish(rowEnablePolish.get_active()); });
        rowModelPolish.connect('changed', (entry) => settings.set_string('model-name-polish', entry.get_text()));
        rowPromptPolish.connect('changed', (entry) => settings.set_string('system-prompt-polish', entry.get_text()));
        togglePolish(rowEnablePolish.get_active());
        groupAPI.add(rowEnablePolish); groupAPI.add(rowModelPolish); groupAPI.add(rowPromptPolish);

        // ==========================================
        // 4. 邮件回复助手配置块
        // ==========================================
        const rowEnableMail = new Adw.SwitchRow({ title: '启用“邮件助手” (Enable Mail Assistant)', active: settings.get_boolean('enable-mail') });
        const rowModelMail = new Adw.EntryRow({ title: '  └─ 模型名称 (Model)', text: settings.get_string('model-name-mail') });
        const rowPromptMail = new Adw.EntryRow({ title: '  └─ 系统提示词 (Prompt)', text: settings.get_string('system-prompt-mail') });
        
        const toggleMail = (isActive) => { rowModelMail.set_sensitive(isActive); rowPromptMail.set_sensitive(isActive); };
        rowEnableMail.connect('notify::active', () => { settings.set_boolean('enable-mail', rowEnableMail.get_active()); toggleMail(rowEnableMail.get_active()); });
        rowModelMail.connect('changed', (entry) => settings.set_string('model-name-mail', entry.get_text()));
        rowPromptMail.connect('changed', (entry) => settings.set_string('system-prompt-mail', entry.get_text()));
        toggleMail(rowEnableMail.get_active());
        groupAPI.add(rowEnableMail); groupAPI.add(rowModelMail); groupAPI.add(rowPromptMail);

        // ==========================================
        // 通用模型参数
        // ==========================================
        const rowTemp = new Adw.SpinRow({ title: '模型发散度/随机性 (Temperature)', digits: 2, adjustment: new Gtk.Adjustment({ lower: 0.0, upper: 2.0, step_increment: 0.1, value: settings.get_double('temperature') }) });
        rowTemp.connect('notify::value', () => settings.set_double('temperature', rowTemp.get_value()));
        groupAPI.add(rowTemp);

        const rowThink = new Adw.SwitchRow({ title: '保留并输出思维链 (Enable Reasoning/Think)', active: settings.get_boolean('enable-think') });
        rowThink.connect('notify::active', () => settings.set_boolean('enable-think', rowThink.get_active()));
        groupAPI.add(rowThink);

        const rowStream = new Adw.SwitchRow({ title: '开启流式打字机输出 (Enable Streaming)', active: settings.get_boolean('enable-stream') });
        rowStream.connect('notify::active', () => settings.set_boolean('enable-stream', rowStream.get_active()));
        groupAPI.add(rowStream);

        // ==========================================
        // 界面与交互行为
        // ==========================================
        const currentSize = settings.get_int('icon-size');
        const rowSize = new Adw.SpinRow({ title: '弹出图标大小 (Popup Icon Size, px)', adjustment: new Gtk.Adjustment({ lower: 16, upper: 64, step_increment: 2, value: currentSize }) });
        const previewIcon = new Gtk.Image({ icon_name: 'preferences-desktop-locale-symbolic', pixel_size: currentSize });
        const rowSizePreview = new Adw.ActionRow({ title: '图标大小实时预览' });
        rowSizePreview.add_suffix(previewIcon);
        rowSize.connect('notify::value', () => { settings.set_int('icon-size', rowSize.get_value()); previewIcon.set_pixel_size(rowSize.get_value()); });
        
        const rowTimeout = new Adw.SpinRow({ title: '图标自动关闭时间 (secs / -1 for ∞)', adjustment: new Gtk.Adjustment({ lower: -1, upper: 60, step_increment: 1, value: settings.get_int('auto-close-time') }) });
        rowTimeout.connect('notify::value', () => settings.set_int('auto-close-time', rowTimeout.get_value()));
        
        const toggleUIIconSensitivity = () => {
            let isEnabled = rowEnablePopup.get_active();
            rowSize.set_sensitive(isEnabled);
            rowTimeout.set_sensitive(isEnabled);
        };
        rowEnablePopup.connect('notify::active', () => toggleUIIconSensitivity());
        toggleUIIconSensitivity();
        
        groupUI.add(rowSize); groupUI.add(rowSizePreview); groupUI.add(rowTimeout);
        page.add(groupWakeup); page.add(groupAPI); page.add(groupUI); window.add(page);
    }
}
