import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class PopupLLMOfficeAssistentPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.set_default_size(760, 820);

        const page = new Adw.PreferencesPage({
            title: 'Popup LLM Office Assistent',
            icon_name: 'accessories-dictionary-symbolic',
        });

        const addIcon = (row, iconName) => {
            row.add_prefix(new Gtk.Image({
                icon_name: iconName,
                valign: Gtk.Align.CENTER,
            }));
        };

        // 全局唤醒与快捷键
        const groupWakeup = new Adw.PreferencesGroup({
            title: '唤醒与快捷键 (Wakeup & Shortcut)',
            description: '选择划词后自动显示功能图标，或通过快捷键手动唤出。',
        });

        const rowEnablePopup = new Adw.SwitchRow({
            title: '启用悬浮图标 (Enable Popup)',
            subtitle: '关闭后不会监听划词，也不会注册唤出快捷键',
            active: settings.get_boolean('enable-popup'),
            use_markup: false,
        });
        addIcon(rowEnablePopup, 'view-reveal-symbolic');

        const modeNames = ['划词弹出 (Auto)', '快捷键唤出 (Shortcut)'];
        const modeCodes = ['auto', 'shortcut'];
        const rowPopupMode = new Adw.ComboRow({
            title: '唤出方式 (Mode)',
            subtitle: '选择悬浮功能图标的触发方式',
            model: Gtk.StringList.new(modeNames),
            use_markup: false,
        });
        rowPopupMode.set_selected(Math.max(0, modeCodes.indexOf(settings.get_string('popup-mode'))));
        addIcon(rowPopupMode, 'preferences-system-notifications-symbolic');

        const currentShortcutArr = settings.get_strv('popup-shortcut');
        const currentShortcut = currentShortcutArr?.length > 0 ? currentShortcutArr[0] : '';
        const rowShortcut = new Adw.ActionRow({
            title: '快捷键 (Shortcut Key)',
            subtitle: '点击右侧按钮，然后直接按下新的快捷键；Esc 取消',
            use_markup: false,
        });
        addIcon(rowShortcut, 'preferences-desktop-keyboard-shortcuts-symbolic');

        const shortcutButton = new Gtk.Button({
            label: currentShortcut || '未设置 (Not set)',
            valign: Gtk.Align.CENTER,
        });
        rowShortcut.add_suffix(shortcutButton);

        const keyController = new Gtk.EventControllerKey();
        let isRecording = false;

        shortcutButton.connect('clicked', () => {
            if (isRecording) {
                isRecording = false;
                const shortcut = settings.get_strv('popup-shortcut');
                shortcutButton.set_label(shortcut?.[0] || '未设置 (Not set)');
                shortcutButton.remove_css_class('suggested-action');
                return;
            }

            isRecording = true;
            shortcutButton.set_label('请按下快捷键… (Press keys)');
            shortcutButton.add_css_class('suggested-action');
        });

        keyController.connect('key-pressed', (_controller, keyval, _keycode, state) => {
            if (!isRecording)
                return false;

            const mask = state & Gtk.accelerator_get_default_mod_mask();
            if (mask === 0 && keyval >= Gdk.KEY_Shift_L && keyval <= Gdk.KEY_Hyper_R)
                return false;

            if (keyval === Gdk.KEY_Escape && mask === 0) {
                isRecording = false;
                const shortcut = settings.get_strv('popup-shortcut');
                shortcutButton.set_label(shortcut?.[0] || '未设置 (Not set)');
                shortcutButton.remove_css_class('suggested-action');
                return true;
            }

            const shortcutString = Gtk.accelerator_name(keyval, mask);
            if (!shortcutString)
                return false;

            settings.set_strv('popup-shortcut', [shortcutString]);
            shortcutButton.set_label(shortcutString);
            shortcutButton.remove_css_class('suggested-action');
            isRecording = false;
            return true;
        });
        shortcutButton.add_controller(keyController);

        const toggleWakeupSensitivity = () => {
            const isEnabled = rowEnablePopup.get_active();
            const isShortcut = modeCodes[rowPopupMode.get_selected()] === 'shortcut';
            rowPopupMode.set_sensitive(isEnabled);
            rowShortcut.set_sensitive(isEnabled && isShortcut);
        };

        rowEnablePopup.connect('notify::active', () => {
            settings.set_boolean('enable-popup', rowEnablePopup.get_active());
            toggleWakeupSensitivity();
        });
        rowPopupMode.connect('notify::selected', () => {
            settings.set_string('popup-mode', modeCodes[rowPopupMode.get_selected()]);
            toggleWakeupSensitivity();
        });
        toggleWakeupSensitivity();

        groupWakeup.add(rowEnablePopup);
        groupWakeup.add(rowPopupMode);
        groupWakeup.add(rowShortcut);

        // API 连接
        const groupConnection = new Adw.PreferencesGroup({
            title: '大模型连接 (LLM Connection)',
            description: '支持兼容 OpenAI Chat Completions 格式的本地或在线接口。',
        });

        const rowApiUrl = new Adw.EntryRow({
            title: '接口链接 (API Endpoint)',
            text: settings.get_string('api-url'),
            use_markup: false,
        });
        rowApiUrl.connect('changed', entry => settings.set_string('api-url', entry.get_text()));

        const rowApiKey = new Adw.PasswordEntryRow({
            title: 'API 密钥 (API Key, Optional)',
            text: settings.get_string('api-key'),
            use_markup: false,
        });
        rowApiKey.connect('changed', entry => settings.set_string('api-key', entry.get_text()));

        groupConnection.add(rowApiUrl);
        groupConnection.add(rowApiKey);

        // 六项功能：只整理显示层级，不改变设置键或业务逻辑。
        const groupFeatures = new Adw.PreferencesGroup({
            title: '功能与模型 (Features & Models)',
            description: '使用右侧开关启用功能；展开项目可分别设置模型名称和系统提示词。',
        });

        const createFeatureRow = ({
            settingKey,
            title,
            subtitle,
            iconName,
            modelKey,
            promptKey,
        }) => {
            const enabled = settings.get_boolean(settingKey);
            const row = new Adw.ExpanderRow({
                title,
                subtitle,
                show_enable_switch: true,
                enable_expansion: enabled,
                expanded: false,
                use_markup: false,
            });
            addIcon(row, iconName);

            const modelRow = new Adw.EntryRow({
                title: '模型名称 (Model)',
                text: settings.get_string(modelKey),
                use_markup: false,
            });
            const promptRow = new Adw.EntryRow({
                title: '系统提示词 (System Prompt)',
                text: settings.get_string(promptKey),
                use_markup: false,
            });

            modelRow.connect('changed', entry => settings.set_string(modelKey, entry.get_text()));
            promptRow.connect('changed', entry => settings.set_string(promptKey, entry.get_text()));
            row.connect('notify::enable-expansion', () => {
                settings.set_boolean(settingKey, row.get_enable_expansion());
            });

            row.add_row(modelRow);
            row.add_row(promptRow);
            groupFeatures.add(row);
        };

        createFeatureRow({
            settingKey: 'enable-translate',
            title: '启用“智能翻译” (Enable Translation)',
            subtitle: '多语言翻译，可选择目标语言与翻译风格',
            iconName: 'preferences-desktop-locale-symbolic',
            modelKey: 'model-name',
            promptKey: 'system-prompt',
        });
        createFeatureRow({
            settingKey: 'enable-explain',
            title: '启用“核心解释” (Enable Explanation)',
            subtitle: '词语、语法、句型、语义及通用解释',
            iconName: 'accessories-dictionary-symbolic',
            modelKey: 'model-name-explain',
            promptKey: 'system-prompt-explain',
        });
        createFeatureRow({
            settingKey: 'enable-polish',
            title: '启用“文字润色” (Enable Polishing)',
            subtitle: '按不同写作风格优化所选文本',
            iconName: 'document-edit-symbolic',
            modelKey: 'model-name-polish',
            promptKey: 'system-prompt-polish',
        });
        createFeatureRow({
            settingKey: 'enable-mail',
            title: '启用“邮件助手” (Enable Mail Assistant)',
            subtitle: '根据补充要求生成邮件回复',
            iconName: 'mail-message-new-symbolic',
            modelKey: 'model-name-mail',
            promptKey: 'system-prompt-mail',
        });
        createFeatureRow({
            settingKey: 'enable-qa',
            title: '启用“智能问答” (Enable QA)',
            subtitle: '基于划选内容开始连续智能对话',
            iconName: 'system-help-symbolic',
            modelKey: 'model-name-qa',
            promptKey: 'system-prompt-qa',
        });
        createFeatureRow({
            settingKey: 'enable-custom',
            title: '启用“自定义功能” (Enable Custom Tool)',
            subtitle: '使用独立模型和提示词执行自定义任务',
            iconName: 'preferences-system-symbolic',
            modelKey: 'model-name-custom',
            promptKey: 'system-prompt-custom',
        });

        // 通用模型行为
        const groupModel = new Adw.PreferencesGroup({
            title: '模型行为 (Model Behavior)',
            description: '以下参数由六项功能共同使用。',
        });

        const rowTemp = new Adw.SpinRow({
            title: '模型发散度 / 随机性 (Temperature)',
            subtitle: '数值越高，回答越多样；数值越低，回答越稳定',
            digits: 2,
            adjustment: new Gtk.Adjustment({
                lower: 0.0,
                upper: 2.0,
                step_increment: 0.1,
                value: settings.get_double('temperature'),
            }),
            use_markup: false,
        });
        addIcon(rowTemp, 'weather-clear-symbolic');
        rowTemp.connect('notify::value', () => settings.set_double('temperature', rowTemp.get_value()));

        const rowThink = new Adw.SwitchRow({
            title: '保留并输出思维链 (Enable Reasoning/Think)',
            subtitle: '是否保留接口返回的推理内容',
            active: settings.get_boolean('enable-think'),
            use_markup: false,
        });
        addIcon(rowThink, 'system-run-symbolic');
        rowThink.connect('notify::active', () => settings.set_boolean('enable-think', rowThink.get_active()));

        const rowStream = new Adw.SwitchRow({
            title: '开启流式打字机输出 (Enable Streaming)',
            subtitle: '接收内容时逐步显示模型输出',
            active: settings.get_boolean('enable-stream'),
            use_markup: false,
        });
        addIcon(rowStream, 'media-playback-start-symbolic');
        rowStream.connect('notify::active', () => settings.set_boolean('enable-stream', rowStream.get_active()));

        groupModel.add(rowTemp);
        groupModel.add(rowThink);
        groupModel.add(rowStream);

        // 界面与交互
        const groupUI = new Adw.PreferencesGroup({
            title: '界面与交互 (Appearance & Interaction)',
            description: '调整划词后悬浮图标的大小与自动关闭时间。',
        });

        const currentSize = settings.get_int('icon-size');
        const rowSize = new Adw.SpinRow({
            title: '弹出图标大小 (Popup Icon Size)',
            subtitle: '单位：像素 (px)',
            adjustment: new Gtk.Adjustment({
                lower: 16,
                upper: 64,
                step_increment: 2,
                value: currentSize,
            }),
            use_markup: false,
        });
        addIcon(rowSize, 'image-x-generic-symbolic');

        const previewIcon = new Gtk.Image({
            icon_name: 'preferences-desktop-locale-symbolic',
            pixel_size: currentSize,
        });
        const rowSizePreview = new Adw.ActionRow({
            title: '图标大小实时预览 (Live Preview)',
            subtitle: '预览仅显示尺寸，不代表各功能的实际颜色',
            use_markup: false,
        });
        addIcon(rowSizePreview, 'view-preview-symbolic');
        rowSizePreview.add_suffix(previewIcon);

        rowSize.connect('notify::value', () => {
            const size = Math.round(rowSize.get_value());
            settings.set_int('icon-size', size);
            previewIcon.set_pixel_size(size);
        });

        const rowTimeout = new Adw.SpinRow({
            title: '图标自动关闭时间 (Auto-close Time)',
            subtitle: '单位：秒；设为 -1 时不会自动关闭',
            adjustment: new Gtk.Adjustment({
                lower: -1,
                upper: 60,
                step_increment: 1,
                value: settings.get_int('auto-close-time'),
            }),
            use_markup: false,
        });
        addIcon(rowTimeout, 'alarm-symbolic');
        rowTimeout.connect('notify::value', () => {
            settings.set_int('auto-close-time', Math.round(rowTimeout.get_value()));
        });

        const toggleUIIconSensitivity = () => {
            const isEnabled = rowEnablePopup.get_active();
            rowSize.set_sensitive(isEnabled);
            rowSizePreview.set_sensitive(isEnabled);
            rowTimeout.set_sensitive(isEnabled);
        };
        rowEnablePopup.connect('notify::active', toggleUIIconSensitivity);
        toggleUIIconSensitivity();

        groupUI.add(rowSize);
        groupUI.add(rowSizePreview);
        groupUI.add(rowTimeout);

        page.add(groupWakeup);
        page.add(groupConnection);
        page.add(groupFeatures);
        page.add(groupModel);
        page.add(groupUI);
        window.add(page);
    }
}
