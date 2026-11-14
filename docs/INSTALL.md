# Popup LLM Office Assistent — 免编译安装 / Precompiled installation

支持 GNOME Shell 45–51。扩展 UUID：
`popup-llm-officeassistent@yanjing_chen@qq.com`

本包的 UUID 文件夹已经含有 `schemas/gschemas.compiled`，不需要执行
`glib-compile-schemas`，不需要 Node.js、Python、编译器或自行构建。
不要使用 sudo 安装扩展。

## 推荐安装：自动备份旧版

解压后关闭扩展设置，在包含本文件和 install.sh 的目录执行：

```bash
bash install.sh
```

脚本先校验完整性和预编译 schema，再备份、安装；失败会恢复旧扩展。
备份位于当前用户的数据目录 `popup-llm-officeassistent/backups/`，不放在扩展扫描目录。
不重置其他设置，不修改 GNOME 或显卡驱动。

安装结束后保存工作，**注销并重新登录**。然后在“扩展”中启用本扩展，
或执行：

```bash
gnome-extensions enable 'popup-llm-officeassistent@yanjing_chen@qq.com'
gnome-extensions prefs 'popup-llm-officeassistent@yanjing_chen@qq.com'
```

## 直接复制

将解压出来的 **整个 UUID 文件夹** 复制到：

```text
~/.local/share/gnome-shell/extensions/
```

最终结构应为：
`~/.local/share/gnome-shell/extensions/popup-llm-officeassistent@yanjing_chen@qq.com/metadata.json`
以及同目录的 `schemas/gschemas.compiled`。

升级时建议使用 install.sh，避免与旧目录混合；不需要覆盖其他扩展目录。
此 ZIP 是“复制安装包”，不是 metadata.json 位于 ZIP 根目录的 `.shell-extension.zip`；
不要将它交给 `gnome-extensions install`。

## 模型连接

自行启动 Ollama 或兼容接口，准备实际模型。在设置中填写 API 地址，
例如 Ollama 默认本地接口 `http://127.0.0.1:11434/v1/chat/completions`，
刷新模型列表，并给六项功能分别选择模型。没有安装模型时不会显示示例名称。
本扩展不附带模型、不自动下载、不启动后端。设置窗口不属于可拖动的结果弹框。

## English

GNOME Shell 45–51. Extract the archive and run `bash install.sh` as your normal
desktop user, or copy the complete UUID directory into
`~/.local/share/gnome-shell/extensions/`. The GSettings schema is precompiled:
no build tools, Python or Node.js are required to install or run the extension.
Save your work, log out and log back in, enable the extension, then configure
your own model backend and select real available models in Preferences.
Use install.sh for upgrades so that the old version is backed up first.
