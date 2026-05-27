import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup?version=3.0';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const LOADING_TEXT = '正在连接大模型... (Connecting to LLM...)';

export default class PopupLLMOfficeAssistent extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._soupSession = new Soup.Session();
        this._rawResponseText = '';
        this._lastText = null;
        this._ownerChangedId = null;
        
        this._indicator = new PanelMenu.Button(0.0, 'PopupLLMOfficeAssistent', false);
        let icon = new St.Icon({ icon_name: 'accessories-dictionary-symbolic', style_class: 'system-status-icon' });
        this._indicator.add_child(icon);

        let settingsItem = new PopupMenu.PopupMenuItem('打开设置 (Settings)');
        settingsItem.connect('activate', () => Main.extensionManager.openExtensionPrefs(this.uuid, '', null));
        this._indicator.menu.addMenuItem(settingsItem);
        Main.panel.addToStatusArea('PopupLLMOfficeAssistent', this._indicator);

        this._selection = global.display.get_selection();
        
        // 监听设置变化以动态切换唤出模式
        this._settingsChangedId = this._settings.connect('changed', this._updatePopupMode.bind(this));
        this._updatePopupMode();

        this._escEventId = global.stage.connect('key-press-event', (actor, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) this._closeUI();
            return Clutter.EVENT_PROPAGATE;
        });
    }

    disable() {
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
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        this._settings = null;
        if (this._soupSession) {
            this._soupSession.abort();
            this._soupSession = null;
        }
    }

    _updatePopupMode() {
        let enablePopup = this._settings.get_boolean('enable-popup');
        let mode = this._settings.get_string('popup-mode');
        
        this._unbindKey();
        if (this._ownerChangedId) {
            this._selection.disconnect(this._ownerChangedId);
            this._ownerChangedId = null;
        }

        if (!enablePopup) return;

        if (mode === 'auto') {
            this._ownerChangedId = this._selection.connect('owner-changed', () => {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
                    this._checkPrimarySelection();
                    return GLib.SOURCE_REMOVE;
                });
            });
        } else if (mode === 'shortcut') {
            Main.wm.addKeybinding(
                'popup-shortcut',
                this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.ALL,
                () => {
                    const clipboard = St.Clipboard.get_default();
                    clipboard.get_text(St.ClipboardType.PRIMARY, (clip, text) => {
                        if (text && text.trim().length > 0) {
                            this._lastText = text;
                            this._showPopupIcon(text);
                        }
                    });
                }
            );
        }
    }

    _unbindKey() {
        Main.wm.removeKeybinding('popup-shortcut');
    }

    _checkPrimarySelection() {
        const clipboard = St.Clipboard.get_default();
        clipboard.get_text(St.ClipboardType.PRIMARY, (clip, text) => {
            if (text && text.trim().length > 0 && text !== this._lastText) {
                this._lastText = text;
                this._showPopupIcon(text);
            }
        });
    }

    _showPopupIcon(text) {
        this._closeUI();
        const iconSize = this._settings.get_int('icon-size');
        this._popupContainer = new St.BoxLayout({ vertical: false, style_class: 'translator-popup-container' });
        let buttonsAdded = 0;

        if (this._settings.get_boolean('enable-translate')) {
            let btn = new St.Button({ style_class: 'translator-popup-icon', child: new St.Icon({ icon_name: 'preferences-desktop-locale-symbolic', icon_size: iconSize }), track_hover: true });
            btn.connect('clicked', () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { this._showResultWindow(text, 'translate'); return GLib.SOURCE_REMOVE; }));
            this._popupContainer.add_child(btn); buttonsAdded++;
        }
        if (this._settings.get_boolean('enable-explain')) {
            let btn = new St.Button({ style_class: 'explain-popup-icon', child: new St.Icon({ icon_name: 'accessories-dictionary-symbolic', icon_size: iconSize }), track_hover: true });
            btn.connect('clicked', () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { this._showResultWindow(text, 'explain'); return GLib.SOURCE_REMOVE; }));
            this._popupContainer.add_child(btn); buttonsAdded++;
        }
        if (this._settings.get_boolean('enable-polish')) {
            let btn = new St.Button({ style_class: 'translator-popup-icon', child: new St.Icon({ icon_name: 'document-edit-symbolic', icon_size: iconSize }), track_hover: true });
            btn.connect('clicked', () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { this._showResultWindow(text, 'polish'); return GLib.SOURCE_REMOVE; }));
            this._popupContainer.add_child(btn); buttonsAdded++;
        }
        if (this._settings.get_boolean('enable-mail')) {
            let btn = new St.Button({ style_class: 'mail-popup-icon', child: new St.Icon({ icon_name: 'mail-unread-symbolic', icon_size: iconSize }), track_hover: true });
            btn.connect('clicked', () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { this._showResultWindow(text, 'mail'); return GLib.SOURCE_REMOVE; }));
            this._popupContainer.add_child(btn); buttonsAdded++;
        }

        if (buttonsAdded === 0) { this._lastText = null; return; }

        let [x, y] = global.get_pointer();
        this._popupContainer.set_position(x + 15, y + 15);
        Main.layoutManager.addChrome(this._popupContainer);

        this._popupContainer.opacity = 0;
        this._popupContainer.ease({ opacity: 255, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD });

        const timeout = this._settings.get_int('auto-close-time');
        if (timeout > 0) {
            this._iconTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeout, () => { this._closeUI(); return GLib.SOURCE_REMOVE; });
        }
    }

    _showResultWindow(text, actionType) {
        try {
            if (this._iconTimeoutId) { GLib.source_remove(this._iconTimeoutId); this._iconTimeoutId = null; }
            if (this._popupContainer) { Main.layoutManager.removeChrome(this._popupContainer); this._popupContainer.destroy(); this._popupContainer = null; }

            this._resultContainer = new St.BoxLayout({ vertical: true, style_class: 'translator-result-window libadwaita-style' });

            // ======= 顶部标题栏 =======
            let headerBox = new St.BoxLayout({ vertical: false, style: 'margin-bottom: 6px;' });
            let titleText = 'LLM 助手 (Assistant)';
            if (actionType === 'translate') titleText = 'LLM 智能翻译 (Translation)';
            else if (actionType === 'explain') titleText = 'LLM 智能解释 (Explanation)';
            else if (actionType === 'polish') titleText = 'LLM 文字润色 (Polishing)';
            else if (actionType === 'mail') titleText = 'LLM 邮件助手 (Mail Assistant)';

            let titleLabel = new St.Label({ text: titleText, style: 'font-weight: bold; font-size: 11px; color: #888888; vertical-align: middle;', x_expand: true });
            
            let closeButton = new St.Button({ child: new St.Icon({ icon_name: 'window-close-symbolic', icon_size: 14 }), style_class: 'translator-close-btn' });
            closeButton.connect('clicked', () => this._closeUI());

            headerBox.add_child(titleLabel);
            
            let copyButton = new St.Button({ child: new St.Icon({ icon_name: 'edit-copy-symbolic', icon_size: 14 }), style_class: 'translator-copy-btn', margin_right: 6 });
            let copyAction = () => {
                if (this._resultLabel) {
                    let currentText = this._resultLabel.get_text();
                    if (currentText && currentText !== LOADING_TEXT && !currentText.includes('✨ 请')) {
                        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, currentText);
                        copyButton.set_child(new St.Icon({ icon_name: 'object-select-symbolic', icon_size: 14 }));
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => { if (copyButton) copyButton.set_child(new St.Icon({ icon_name: 'edit-copy-symbolic', icon_size: 14 })); return GLib.SOURCE_REMOVE; });
                    }
                }
            };
            copyButton.connect('clicked', copyAction);

            if (actionType !== 'mail') {
                headerBox.add_child(copyButton);
            }
            headerBox.add_child(closeButton);
            this._resultContainer.add_child(headerBox);

            // ======= 动态下拉菜单 (Dropdown) 与动作执行按钮 =======
            let dropdownBox = new St.BoxLayout({ vertical: true, style: 'margin-bottom: 8px;' });
            
            const createDropdown = (titlePrefix, names, codes, settingKey, actionLabel) => {
                let currentVal = this._settings.get_string(settingKey);
                let currentIndex = Math.max(0, codes.indexOf(currentVal));
                
                let rowBox = new St.BoxLayout({ vertical: false, x_expand: true });

                // 下拉触发按钮
                let triggerBtn = new St.Button({ label: `${titlePrefix}: ${names[currentIndex]} ▾`, style_class: 'translator-dropdown-trigger', x_expand: true });
                
                // 动作执行按钮 (翻译/解释/润色)
                let actionBtn = new St.Button({ label: actionLabel, style_class: 'translator-action-btn' });
                
                let menuContainer = new St.BoxLayout({ vertical: true, visible: false, style_class: 'translator-dropdown-menu' });
                
                triggerBtn.connect('clicked', () => { menuContainer.visible = !menuContainer.visible; });

                actionBtn.connect('clicked', () => {
                    menuContainer.visible = false;
                    if (this._soupSession) this._soupSession.abort();
                    this._soupSession = new Soup.Session();
                    this._resultLabel.set_text(LOADING_TEXT);
                    this._callLLMAPI(text, actionType);
                });

                codes.forEach((code, index) => {
                    let itemBtn = new St.Button({ label: names[index], style_class: 'translator-dropdown-item', x_expand: true });
                    itemBtn.connect('clicked', () => {
                        menuContainer.visible = false;
                        triggerBtn.set_label(`${titlePrefix}: ${names[index]} ▾`);
                        this._settings.set_string(settingKey, code);
                    });
                    menuContainer.add_child(itemBtn);
                });

                rowBox.add_child(triggerBtn);
                rowBox.add_child(actionBtn);

                dropdownBox.add_child(rowBox);
                dropdownBox.add_child(menuContainer);
                this._resultContainer.add_child(dropdownBox);
            };

            if (actionType === 'translate') {
                const langNames = ['简体中文', 'English', 'Nederlands', '繁體中文', 'Deutsch', 'Français', 'Español', 'Italiano', 'Português', 'Русский', '日本語', '한국어', 'العربية', 'Türkçe', 'Polski', 'हिन्दी', 'Čeština', 'Dansk', 'Ελληνικά', 'Suomi', 'Magyar', 'Norsk', 'Română', 'Svenska', 'Українська', 'Tiếng Việt', 'Bahasa Indonesia', 'ไทย'];
                const langCodes = ['zh', 'en', 'nl', 'zh-tw', 'de', 'fr', 'es', 'it', 'pt', 'ru', 'ja', 'ko', 'ar', 'tr', 'pl', 'hi', 'cs', 'da', 'el', 'fi', 'hu', 'no', 'ro', 'sv', 'uk', 'vi', 'id', 'th'];
                createDropdown('目标语言', langNames, langCodes, 'target-lang', '翻 译');
            } else if (actionType === 'explain') {
                createDropdown('解释类别', ['通用', '词语解释', '语法解释', '句型解释', '含义解释'], ['general', 'word', 'grammar', 'sentence', 'meaning'], 'explain-mode', '解 释');
            } else if (actionType === 'polish') {
                createDropdown('写作风格', ['通用', '学术文体', '文学表达', '儿童语言', '正式文体', '生活化表达'], ['general', 'academic', 'literary', 'child', 'formal', 'daily'], 'polish-mode', '润 色');
            } else if (actionType === 'mail') {
                let mailInputBox = new St.BoxLayout({ vertical: false, style_class: 'mail-entry-box', style: 'margin-bottom: 8px;' });
                this._mailEntry = new St.Entry({ hint_text: ' 输入回复要求 (例: 委婉拒绝并感谢)', x_expand: true, y_align: Clutter.ActorAlign.CENTER });
                let mailSendBtn = new St.Button({ child: new St.Icon({ icon_name: 'mail-send-symbolic', icon_size: 16 }), style_class: 'mail-send-btn' });
                
                mailInputBox.add_child(this._mailEntry);
                mailInputBox.add_child(mailSendBtn);
                this._resultContainer.add_child(mailInputBox);

                let sendAction = () => {
                    let customReq = this._mailEntry.get_text();
                    if (this._soupSession) this._soupSession.abort();
                    this._soupSession = new Soup.Session();
                    this._resultLabel.set_text(LOADING_TEXT);
                    this._callLLMAPI(text, actionType, customReq);
                };
                mailSendBtn.connect('clicked', sendAction);
                this._mailEntry.clutter_text.connect('activate', sendAction); 
            }

            // ======= 结果显示区 =======
            this._resultWindow = new St.ScrollView({ hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC, y_expand: true });
            let contentBox = new St.BoxLayout({ vertical: true, x_expand: true, y_expand: true });
            this._resultLabel = new St.Label({ text: '', style_class: 'translator-result-text', y_expand: true });
            let clutterText = this._resultLabel.get_clutter_text();
            clutterText.line_wrap = true; clutterText.line_wrap_mode = Pango.WrapMode.WORD_CHAR; clutterText.ellipsize = Pango.EllipsizeMode.NONE; 
            contentBox.add_child(this._resultLabel);
            this._resultWindow.set_child(contentBox);
            this._resultContainer.add_child(this._resultWindow);

            if (actionType === 'mail') {
                let bottomBar = new St.BoxLayout({ vertical: false, style: 'margin-top: 6px; border-top: 1px solid rgba(128,128,128,0.15); padding-top: 6px; justify-content: flex-end;' });
                let copyBtnBottom = new St.Button({ child: new St.Icon({ icon_name: 'edit-copy-symbolic', icon_size: 14 }), style_class: 'translator-copy-btn' });
                copyBtnBottom.connect('clicked', copyAction);
                bottomBar.add_child(copyBtnBottom);
                this._resultContainer.add_child(bottomBar);
            }

            // ======= 智能定位防溢出 =======
            let [x, y] = global.get_pointer();
            let monitor = Main.layoutManager.primaryMonitor;
            for (let i = 0; i < Main.layoutManager.monitors.length; i++) {
                let m = Main.layoutManager.monitors[i];
                if (x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height) { monitor = m; break; }
            }

            let popupWidth = 450;
            this._resultContainer.set_width(popupWidth);
            let maxHeight = Math.floor(monitor.height * 0.7);
            if (maxHeight > 800) maxHeight = 800; 
            this._resultContainer.set_style(`max-height: ${maxHeight}px; min-height: 140px;`);

            let targetX = x + 10;
            let targetY = y + 20;
            if (targetX + popupWidth > monitor.x + monitor.width) targetX = monitor.x + monitor.width - popupWidth - 10;
            this._resultContainer.set_position(targetX, targetY);

            this._resultContainer.connect('notify::height', () => {
                if (!this._resultContainer) return;
                let currentH = this._resultContainer.height;
                let maxAllowedY = monitor.y + monitor.height - currentH - 20;
                let finalY = targetY;
                if (finalY > maxAllowedY) finalY = maxAllowedY;
                if (finalY < monitor.y + 20) finalY = monitor.y + 20;
                this._resultContainer.set_y(finalY);
            });
            
            Main.layoutManager.addChrome(this._resultContainer);
            this._resultContainer.opacity = 0;
            this._resultContainer.ease({ opacity: 255, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_CUBIC });

            // ======= 初始化等待语 =======
            if (actionType === 'mail') {
                this._resultLabel.set_text('✨ 请在上方输入您的回复要求（如：委婉拒绝），然后按回车或点击发送按钮。');
            } else if (actionType === 'translate') {
                this._resultLabel.set_text('✨ 请确认目标语言，然后点击右上方“翻译”按钮开始执行。');
            } else if (actionType === 'explain') {
                this._resultLabel.set_text('✨ 请确认解释类别，然后点击右上方“解释”按钮开始执行。');
            } else if (actionType === 'polish') {
                this._resultLabel.set_text('✨ 请确认润色风格，然后点击右上方“润色”按钮开始执行。');
            }
        } catch (err) { log(`[PopupLLM Error] UI Build Failed: ${err.message}`); }
    }

    _callLLMAPI(text, actionType, mailCustomPrompt = '') {
        this._rawResponseText = '';
        const apiUrl = this._settings.get_string('api-url');
        const isStream = this._settings.get_boolean('enable-stream');
        
        let sysPrompt = '';
        let chosenModel = '';
        let finalUserText = text;
        
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
        } else if (actionType === 'mail') {
            sysPrompt = this._settings.get_string('system-prompt-mail');
            chosenModel = this._settings.get_string('model-name-mail');
            let customized = mailCustomPrompt.trim() ? mailCustomPrompt : "按通用礼貌格式回复";
            finalUserText = `【用户的回复指令要求】\n${customized}\n\n【需要回复的原始邮件文本】\n${text}`;
        } else {
            const targetLang = this._settings.get_string('target-lang');
            sysPrompt = this._settings.get_string('system-prompt') + `\n\n[Target Language: ${targetLang}]`;
            chosenModel = this._settings.get_string('model-name');
        }

        if (!this._settings.get_boolean('enable-think')) {
            sysPrompt += " ⚠️注意：请立刻输出纯结果，禁止输出任何包含在<think>标签内的思维链。(⚠️Note: Output pure results directly, do not generate any thinking process inside <think> tags.)";
        }

        let payload = {
            model: chosenModel, 
            temperature: this._settings.get_double('temperature'),
            stream: isStream,
            messages: [{ role: "system", content: sysPrompt }, { role: "user", content: finalUserText }]
        };

        let message = Soup.Message.new('POST', apiUrl);
        message.request_headers.append('Content-Type', 'application/json');
        
        const apiKey = this._settings.get_string('api-key');
        if (apiKey) message.request_headers.append('Authorization', `Bearer ${apiKey}`);

        const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
        message.set_request_body_from_bytes('application/json', new GLib.Bytes(payloadBytes));

        if (isStream) {
            this._soupSession.send_async(message, GLib.PRIORITY_DEFAULT, null, (session, res) => {
                try {
                    let inputStream = session.send_finish(res);
                    if (message.status_code !== 200) {
                        this._resultLabel.set_text(`连接失败 (Connection Failed)\nHTTP Code: ${message.status_code}\n请检查 API 地址或模型名称 (Check Endpoint or Model Name).`);
                        return;
                    }
                    this._resultLabel.set_text('');
                    this._startIncrementalRead(inputStream);
                } catch (e) {
                    if (this._resultLabel) this._resultLabel.set_text(`网络流被手动截断或中断 (Stream Aborted/Error): ${e.message}`);
                }
            });
        } else {
            this._soupSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, res) => {
                try {
                    let bytes = session.send_and_read_finish(res);
                    if (message.status_code !== 200) { this._resultLabel.set_text(`API 报错 (API Error)\nHTTP Code: ${message.status_code}`); return; }
                    let response = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                    let choice = response.choices && response.choices[0];
                    let content = '';
                    if (choice && choice.message) {
                        content = choice.message.content || '';
                        if (!content && choice.message.reasoning_content && this._settings.get_boolean('enable-think')) content = choice.message.reasoning_content;
                    }
                    if (!this._settings.get_boolean('enable-think')) content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
                    if (this._resultLabel) this._resultLabel.set_text(content);
                } catch (e) {
                    if (this._resultLabel) this._resultLabel.set_text(`被手动截断或解析失败 (Aborted / Parse Failed): ${e.message}`);
                }
            });
        }
    }

    _startIncrementalRead(inputStream) {
        if (!this._resultLabel || !this._resultContainer) return;

        let dataStream = new Gio.DataInputStream({
            base_stream: inputStream,
            close_base_stream: true
        });

        // 修复：GJS 中正确的读取字符串行的方式
        const readNextLine = () => {
            if (!this._resultLabel) return; 
            dataStream.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, res) => {
                try {
                    let line = null;
                    
                    // 优先尝试直接获取 utf-8 字符串
                    if (stream.read_line_finish_utf8) {
                        let [str, len] = stream.read_line_finish_utf8(res);
                        line = str;
                    } else {
                        // 回退方案：读取字节数组后通过 TextDecoder 转换
                        let [out_array, len] = stream.read_line_finish(res);
                        if (out_array) {
                            line = typeof out_array === 'string' ? out_array : new TextDecoder().decode(out_array);
                        }
                    }

                    if (line !== null) {
                        this._parseSingleSSELine(line);
                        readNextLine();
                    } else {
                        stream.close(null);
                    }
                } catch (e) {
                    // 如果流被关闭则安全退出
                }
            });
        };
        readNextLine();
    }

    _parseSingleSSELine(line) {
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
            if (this._resultLabel) this._resultLabel.set_text(processedText);
        } catch (e) {
            // 解析失败的行安全忽略，不会导致整个流崩溃
        }
    }

    _closeUI() {
        if (this._iconTimeoutId) { GLib.source_remove(this._iconTimeoutId); this._iconTimeoutId = null; }
        if (this._popupContainer) { Main.layoutManager.removeChrome(this._popupContainer); this._popupContainer.destroy(); this._popupContainer = null; }
        if (this._resultContainer) { Main.layoutManager.removeChrome(this._resultContainer); this._resultContainer.destroy(); this._resultContainer = null; this._resultWindow = null; this._resultLabel = null; }
        this._lastText = null;
    }
}