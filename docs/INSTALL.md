# Popup LLM Office Assistent — 免编译安装 / Precompiled installation

支持 GNOME Shell 45–51。扩展 UUID：
`popup-llm-officeassistent@yanjing_chen@qq.com`

2.3.6：结果弹窗左上角新增图钉。固定后禁止关闭、Esc 关闭、拖动、边缘缩放以及自动位置调整，解除固定后恢复；禁用扩展时仍可安全清理。
2.3.5 将翻译、解释、润色的字符软上限拆成三个独立的 Adw.SpinRow 数字设置（各功能展开项下；升级继承旧上限值）。2.3.4 新增润色和解释的整章预判与分块、通用输出异常检测，并把字符上限改为与模型发散度一致的 Adw.SpinRow 数字设置。2.3.3 增加整章预判与仅在完整句末切分（整句绝不拆词），保留 2.3.1 的字符软上限设置及 2.3.0 的结果弹框缩放和字号设置，保留中文末字与渲染比例下的选区修正。
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

## 图钉固定弹窗（2.3.6）

每个结果弹窗左上角有图钉：点击后变蓝，关闭按钮变灰，Esc 不会关闭它，标题栏无法拖动，边缘拖动缩放及内容增长时的自动位置修正均被锁定。此时仍可选取、复制文本、继续翻译及滚动内容。再次点击图钉解除固定，才能关闭或移动弹窗。每个弹窗分别固定；新弹窗默认不固定。关闭 GNOME Shell 扩展或重新登录属于强制释放，会照常清理弹窗，图钉不是操作系统层面的永久窗口锁。

## 调整弹框尺寸和字体

鼠标移到弹框边缘或四角，按住左键拖拉改变宽高；标题栏仍用于移动，正文仍可划选与按需复制。
窗口尺寸各自独立，在当前窗口中保持；新窗口沿用上次手动调整的尺寸。
设置 → 界面视觉设置 → 结果文字大小：8–32 pt，默认 11 pt；字号保存并对已打开结果即时生效。
标题、按钮及系统字体不变。OCR 缩略图仍等比显示，识别仍使用原始截图。

长文翻译、润色、解释分别按自己的数字框软上限，在请求前一次性预判所有段落与完整句末：段落不超当前功能上限就整段发送；超限只在句末分块，单句超限仍完整发送。不同段落保留原换行，同段落子块不新增换行；空译文和异常响应会标出块号而不是跳过。
进度不进入复制内容，整次翻译共享同一模型租用；更多请求会增加提示词开销。
它不能代替人工语义校对。如仍漏译，运行安装目录内 bash diagnose-translation.sh，并提供脱敏原文与缺译位置。

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
Loaded build=2.3.6-pin-lock，不能只看磁盘上 metadata 的版本。
文字选择时还可看到 selection resource-scale=数值，仅记录比例，不记录文字。

## English

GNOME Shell 45–51. Extract the archive and run `bash install.sh` as your normal
desktop user, or copy the complete UUID directory into
`~/.local/share/gnome-shell/extensions/`. The GSettings schema is precompiled:
no build tools, Python or Node.js are required to install or run the extension.
Save your work, log out and log back in, enable the extension, then configure
your own model backend and select real available models in Preferences.
Use install.sh for upgrades so that the old version is backed up first.
Native screenshot OCR in 2.3.0 targets GNOME 49–51 and an existing local Ollama
PaddleOCR-VL model. No language selector or additional OCR runtime is installed.
