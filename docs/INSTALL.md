# Popup LLM Office Assistent — 免编译安装 / Precompiled installation

支持 GNOME Shell 45–51。扩展 UUID：
`popup-llm-officeassistent@yanjing_chen@qq.com`

2.2.4 修正渲染缩放下的跨行拖选偏差，保留已解决的中文末字选取；翻译和 OCR 等结果窗均适用。
保留 2.2.2 的首次快捷键、OCR 响应解码及等比例预览，原生截图 OCR 面向 GNOME 49–51。
45–48 保留原有六项文字功能，不宣称新 OCR 已在旧版本验证。

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

## 原生截图 OCR

复用已在 SnapMark 等程序使用的本机 Ollama 和 PaddleOCR-VL，无需另装语言包或识别环境。
OCR 项位于“自定义功能”前，与其他功能一样包含开关、模型选择和提示词；默认提示词为官方 `OCR:`。
刷新列表后在 OCR 展开项中选择实际安装的 PaddleOCR-VL。未来新模型也能从实际列表选择，不按名称过滤，不显示不存在的示例。

呼出浮动工具条后点击位于“自定义”前的相机按钮，直接进入 GNOME 原生截图。
截完并退出原生界面才出现预览弹窗；点击底部“识别”后，下方显示可选取、可复制的文字。
复制仍在顶部。取消截图不弹空窗口。顶栏菜单、原有文字选区和拖动实现不改。
截图只发本机 Ollama；在线文本接口不支持此 OCR，不自动回退云端。
系统自己的截图保存/剪贴板行为不变，插件不删除 GNOME 保存的截图。
相机按钮启动截图不依赖模型或后端在线。快捷键模式在首次登录后、空选区时也会立即呼出工具条，
无需先滑词；无文本时文字工具暂不可点，相机可直接使用。自动滑词模式不额外弹空条。
2.2.1 的原生截图到预览窗口链路已获用户确认，本版保留该入口。
预览现在按原始宽高比显示，OCR 仍发送完整原图。
响应解析不再依赖浏览器式 stream 解码参数，识别错误区分阶段；用户已确认 2.2.2 的 OCR 识别成功。
2.2.3 不改以上截图/识别模块，只修正中文和中西混排的文字选区边界。
在同一行拖过最后一个字即可完整选取，无需拖到下一行；复制、二次处理和拖动仍沿用原有接口。
2.2.4 按文字的实际资源比例换算坐标，避免缩放屏幕上鼠标已经到后面一行、选区仍停在前面。
不需要关闭系统缩放或修改字体设置；原有即时鼠标事件与绘帧跟踪不变。

若截图或识别仍有异常，请操作一次后执行以下只读诊断，贴出结果：

```bash
bash "${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/popup-llm-officeassistent@yanjing_chen@qq.com/diagnose-ocr.sh"
```

它不截图、不读取 API 密钥/提示词、不修改设置。安装后必须注销重登，日志中应出现
Loaded build=2.2.4-selection-render-scale-fix，不能只看磁盘上 metadata 的版本。
文字选择时还可看到 selection resource-scale=数值，仅记录比例，不记录文字。

## English

GNOME Shell 45–51. Extract the archive and run `bash install.sh` as your normal
desktop user, or copy the complete UUID directory into
`~/.local/share/gnome-shell/extensions/`. The GSettings schema is precompiled:
no build tools, Python or Node.js are required to install or run the extension.
Save your work, log out and log back in, enable the extension, then configure
your own model backend and select real available models in Preferences.
Use install.sh for upgrades so that the old version is backed up first.
Native screenshot OCR in 2.2.4 targets GNOME 49–51 and an existing local Ollama
PaddleOCR-VL model. No language selector or additional OCR runtime is installed.
