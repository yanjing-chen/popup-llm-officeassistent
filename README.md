# Popup LLM Office Assistent

GNOME Shell / Wayland 原生划词大模型助手。保留 GNOME 45–51 的六项文字功能，并新增面向 GNOME 49–51 的原生截图 OCR，当前重点验收 GNOME 51。连接自己的 Ollama 或 OpenAI Chat Completions 兼容后端。

仓库：[yanjing-chen/popup-llm-officeassistent](https://github.com/yanjing-chen/popup-llm-officeassistent) · [下载 Release](https://github.com/yanjing-chen/popup-llm-officeassistent/releases/latest) · [构建记录](https://github.com/yanjing-chen/popup-llm-officeassistent/actions)

2.3.6 发布测试修正版仅修复发布自测里的旧标签引用；插件功能与运行文件保持一致。

2.3.6 新增结果弹窗左上角图钉，开启后锁定位置和边缘尺寸并阻止关闭，取消后恢复；每个弹窗分别控制。2.3.5 在 2.3.4 基础上将翻译、解释、润色的单块字符软上限拆成三个独立数字框（300–12000），升级时继承原共用值，随后各自保存。2.3.4 扩展润色／解释的长文本处理和所有文字任务的输出超限检测。此前 2.3.3 改为“整段优先、超限仅按完整句末切分、整句绝不拆词”，并保留 2.3.1 可调字符上限及 2.3.0 弹框缩放和字号设置。
保留 2.2.4 的文字渲染缩放换算，修正中文拖选时鼠标到第四行、选区仍落在第二行的偏差。
保留 2.2.3 已获用户确认的中文末字修正，翻译和 OCR 等结果窗统一生效；西文 ASCII 路径不变。
不更改系统缩放设置或提高轮询频率。截图、OCR 识别和等比例预览仍沿用用户已确认成功的 2.2.2。

## 功能

- 翻译、解释、润色、邮件、智能问答、自定义六项功能；分别选择实际模型及系统提示词。
- 新增截图 OCR：浮动按钮位于智能问答之后、自定义之前；点击后直接进入 GNOME 原生截图，截图完成后才弹出预览窗口。
- OCR 弹窗顶部复制、上方缩略图、下方识别文本、底部“识别”；没有语言选择、额外操作栏或耗时显示。
- 模型菜单自动读取配置后端的实际列表；没有模型显示“尚未安装模型”，不填充示例名称。
- 划词自动呼出或使用自定义快捷键；首次登录后无选中文字也能按快捷键唤出，直接用相机截图。没有文本时文字功能暂不可点。
- 功能按钮位于本插件全部结果窗上方。
- 结果窗口可拖动，多轮结果独立保留；正文选区、按需复制及选中片段二次处理。
- 流式输出、连续问答、翻译目标语言/风格、解释类别和润色风格。
- 支持已确认协议的后端空闲卸载，0–86400 秒，默认 60 秒；不删除模型文件。

## 长文本翻译、缩放与字号（2.3.5）

- 翻译、润色、解释各有独立的“单块字符软上限”数字框（默认 1400，300–12000，步进 100），分别在对应功能的展开设置中。升级时首次复制旧共用值，此后互不影响。
- 翻译按原文段落顺序逐段请求；超长段落仅按完整句末切分。单句本身超出设置值时保持整句完整发送，**不按词语边界切分**。
  发送前核对所有原文片段可以无损拼回原文，不截掉中间内容，不合并重复段落。
- 每段保留目标语言、风格、实际模型、温度与流式开关；只有返回有效译文且正常结束才进入下一段。
  进度显示在译文外，不进入复制文本。请求数会增加；模型空闲释放从整次翻译结束/取消后计算。
- 空译文、损坏的 SSE/JSON、未确认结束及模型输出限制都会标明具体段号，保留已完成译文并停止，不跳过后显示“完成”。
- 这是完整性防护，不是语义校对器；模型仍可能在单段内部漏译或误译。此处没有对应用户原文及后端原始响应，
  不能断言历史漏译完全来自模型或完全来自网络。可用下方只读诊断核对分段状态。
- 将鼠标放在结果弹框边缘或四角，按住左键拖拉即可改变宽度、高度。标题栏仍用于移动，正文仍用于选取。
  每个弹框尺寸独立；调整后不会被后续译文重置，新窗口沿用上次手动调整的尺寸。
- 设置 → “界面视觉设置” → **结果文字大小**，范围 **8–32 pt**，默认 **11 pt**。
  翻译、OCR、解释、润色、邮件及问答消息即时更新；标题和操作按钮保持原大小。字号保存供以后使用。
- 保留稳定的蓝色选区、按需复制、二次弹窗、无阴影拖动和原生 OCR。OCR 缩略图随可用宽度等比缩小，不修改原图。

如仍漏译，完成一次操作后运行：

```bash
bash "${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/popup-llm-officeassistent@yanjing_chen@qq.com/diagnose-translation.sh"
```

只读取版本、开关、字号及分段数量/字节计数，不读取原文、译文、API 密钥或提示词，不修改设置。
若日志全部分段完成但译文仍遗漏，请提供可公开或已脱敏的原文及缺译位置，核对模型的实际翻译内容。
本轮自动测试不等同于 GNOME 51 显卡/缩放环境的实机验收；安装后必须注销重登。

## 安装要求

- GNOME Shell **45–51**，Wayland 会话。请用 `gnome-shell --version` 确认版本。
- 新增原生截图 OCR 使用 GNOME **49–51** 的截图事件顺序，当前候选版需在 GNOME 51 实机验收；45–48 的原有六项功能保留，不宣称新 OCR 已在旧版本验证。
- 系统的 GNOME 扩展、GSettings、GTK4/libadwaita 环境；Ubuntu GNOME 通常已具备。
- 自行准备可访问的模型后端和实际模型。扩展不附带模型，不自动下载模型或启动后端。
- **安装和运行不需要 Node.js、Python、编译器，也不需要执行 glib-compile-schemas。**

## 安装方法一：下载免编译插件包（推荐）

到 [Releases](https://github.com/yanjing-chen/popup-llm-officeassistent/releases/latest) 下载：

**`popup-llm-officeassistent-precompiled.zip`**

这是插件安装包，内含 UUID 文件夹和已编译的 `schemas/gschemas.compiled`。
版本号保存在包内 metadata.json。不要把 GitHub 自动生成的“Source code”当作首选插件下载。

解压后，在含 install.sh 的目录以普通桌面用户运行：

```bash
bash install.sh
```

默认只校验、备份并复制预编译文件，**不会执行编译**。升级时旧版完整备份到当前用户的数据目录 `popup-llm-officeassistent/backups/`，不重置其他配置。不要使用 `sudo bash install.sh`，不要 `source install.sh`。

### 从终端下载并安装最新 Release

需要 curl 和 unzip。整段放在子 shell 中执行，错误不会关闭原来的终端：

```bash
(
  set -e
  POPUP_RELEASE_BASE='https://github.com/yanjing-chen/popup-llm-officeassistent/releases/latest/download'
  POPUP_DOWNLOAD_DIR=$(mktemp -d)
  cd "$POPUP_DOWNLOAD_DIR"
  curl --fail --location "$POPUP_RELEASE_BASE/popup-llm-officeassistent-precompiled.zip" --output popup-llm-officeassistent-precompiled.zip
  curl --fail --location "$POPUP_RELEASE_BASE/SHA256SUMS" --output SHA256SUMS
  sha256sum --check --ignore-missing SHA256SUMS
  unzip -q popup-llm-officeassistent-precompiled.zip -d package
  bash package/install.sh
)
```

### 安装方法二：直接复制文件夹

1. 解压免编译插件包。
2. 将整个 `popup-llm-officeassistent@yanjing_chen@qq.com` 文件夹复制到当前用户的 `~/.local/share/gnome-shell/extensions/`，没有目录时先创建。
3. 确认最终存在以下两个文件：

```text
~/.local/share/gnome-shell/extensions/popup-llm-officeassistent@yanjing_chen@qq.com/metadata.json
~/.local/share/gnome-shell/extensions/popup-llm-officeassistent@yanjing_chen@qq.com/schemas/gschemas.compiled
```

升级建议使用 install.sh 自动备份，避免旧目录与新文件混合。ZIP 内附安装说明。
此包是“复制安装包”，不是 metadata.json 位于 ZIP 根目录的标准 .shell-extension.zip；不要对它执行 `gnome-extensions install`。

### 启用与打开设置

安装后先保存工作，**注销并重新登录 GNOME**，再启用并打开设置：

```bash
gnome-extensions enable 'popup-llm-officeassistent@yanjing_chen@qq.com'
gnome-extensions prefs 'popup-llm-officeassistent@yanjing_chen@qq.com'
```

也可以通过 GNOME“扩展”应用操作。只禁用/启用不足以保证已替换的 JS 模块重新加载；不要在 Wayland 会话中强行重启 Shell。

### 从完整源码安装

仓库和完整源码包同样含有预编译 schema：

```bash
git clone https://github.com/yanjing-chen/popup-llm-officeassistent.git
cd popup-llm-officeassistent
bash install.sh
```

## 首次配置与使用

1. 自行启动 Ollama 或其他兼容后端，准备模型。以 Ollama 默认本地接口为例，在设置中填写 `http://127.0.0.1:11434/v1/chat/completions`。
2. 点击“自动识别模型”旁的刷新按钮，展开六项功能，选择各功能使用的实际模型；可分别调整提示词。
3. 启用需要的功能和悬浮图标。划选文本后选择功能；翻译/解释/润色等可先确认参数，再点击执行。
4. 按住结果窗标题拖动。可以保留多个结果窗口，选取正文中的一部分后继续处理。
5. `Ctrl+C` 或复制按钮优先复制选区；没有选区时复制按钮复制完整结果。选区工具条隐藏后可右击选区再次呼出。

## 截图 OCR（2.2.2）

1. 可以复用 SnapMark 已有的本机 Ollama 和 PaddleOCR-VL；不需要运行 SnapMark，也不需要安装 Tesseract、语言包、Python Paddle 环境或 Local AI Runtime。
2. 使用前部已有的本机接口，例如 `http://127.0.0.1:11434/v1/chat/completions`，刷新模型列表。展开“文字识别”，像其他功能一样选择实际模型；不再在连接组放单独的条件式选择器。
3. “启用文字识别”位于“启用自定义功能”之前，包含启用开关、模型选择和系统提示词。提示词默认官方文本任务 `OCR:`，不指定语言、不追加翻译、问答或思维链指令。
4. 划词或按自定义快捷键呼出浮动工具条，点击橙色相机 OCR 按钮。无选区、首次登录后也能直接按快捷键，不必先滑词；此时文字功能暂不可点，相机可用。原生截图先打开，不先创建插件弹窗；顶栏菜单不增加 OCR 入口。
5. 截图完成且原生界面退出后才打开 OCR 弹窗。上方显示等比例缩略图，下方是识别文本，顶部复制/关闭按钮与原有弹窗一致，底部“识别”才会发送原始 PNG 给本机 Ollama。
6. 识别结果复用现有稳定的选区、复制及二次处理接口。选中一段后可以继续润色/翻译，不重写选区逻辑。流式开关与模型空闲时间复用现有设置，OCR 温度固定 0。

截图取消不会创建空窗口，也不会读取之前的剪贴板图片。截图前暂时隐藏本插件结果窗，结束后恢复；只处理由 OCR 按钮发起的这一轮，不监听普通截图或截图目录。
GNOME 自己的截图保存和剪贴板行为不改变，插件不会删除系统保存的截图。
原图只保留在当前 OCR 窗口的内存中供重试，关闭窗口后释放；不写 OCR 图片历史，不记录图片内容到日志。
OCR 严格限定本机 HTTP 回环 Ollama，不沿用在线文本接口上传截图，不跟随重定向、不自动回退云服务。
OCR 菜单与其他功能一样只显示当前后端的实际列表，不按 PaddleOCR-VL 名称过滤。以后安装新模型后刷新即可选择；所选模型需要支持图片输入，提示词可按其要求调整。未选择、模型被删除时明确提示，不自动切换。

2.2.1 的 GNOME 51 原生截图到预览链路已获用户确认，本版保留该截图入口。
2.2.2 修正 OCR 响应解码：不依赖 TextDecoder 的 stream 选项，按完整字节行处理 NDJSON，
中文/emoji 跨网络分块不乱码；流式与非流式均覆盖。旧版会把这类插件异常误显示为连接问题。
预览改为异步解码到独立图像内容，保留原始宽高比，不再用固定方形图标；请求仍发完整原图。
识别失败区分 HTTP、连接、读数据、解码、协议和插件处理阶段，不再一律归咎于 Ollama。
用户已确认 2.2.2 的真实 OCR 识别成功。2.2.3 不改截图入口、OCR 请求/解码或缩略图模块，
仅修正中文字节索引与字形前后边界的命中换算；中西混排、自动换行、反向拖选均有回归测试。
用户已确认末字问题解决。2.2.4 进一步区分文字 Actor 的逻辑像素、渲染资源比例和 Pango 排版像素，
读取当前文字 Actor 的 resource scale 后再换算坐标；已有鼠标事件/绘帧更新保持，不把行数偏差当作轮询太慢。

详细实现边界、验收和诊断见 [docs/OCR.md](docs/OCR.md)。

列表为空显示“尚未安装模型”；连接失败显示“无法获取模型列表”，不会显示过期或示例模型。
成功确认保存的模型已不存在时清空该选择，需重新选择；不会自动改用其他模型。

模型退出显存时间在“图标自动关闭时间”之后：0 为回答结束/取消后请求立即卸载，正数为空闲秒数，默认 60 秒。旧 -1 迁移为 60 秒。图标自动关闭时间的 -1（不自动关闭）仍保留。
卸载只作用于支持且已识别协议的后端；共享模型的其他客户端可能受影响，不会删除模型文件。

所有文字发送至您配置的后端；如填写在线服务地址，相关文本将发送给该在线服务。扩展不会上传 API 密钥或回答到本 GitHub 仓库。自动模型探测不自动下载模型。

## Release 与开发

- 推送 main / 提交 PR：运行回归检查并生成 Actions 构建产物。
- 推送 `v2.3.0` 这类版本标签：检查成功后自动创建 GitHub Release，附免编译插件 ZIP、完整统一源码 ZIP、SHA256SUMS。
- 标签版本必须与 metadata.json 的 version-name 前缀一致；现有 Release/标签不会被脚本强行覆盖。
- 构建工具只用于开发者，用户下载安装包无需参与构建。

本地维护和发布说明见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。
详细功能、后端协议及交互限制见 [docs/FEATURES.md](docs/FEATURES.md)。

## 问题排查

```bash
gnome-shell --version
gnome-extensions info 'popup-llm-officeassistent@yanjing_chen@qq.com'
```

完整源码包内可运行 `bash diagnose-selection.sh`，查看版本、状态与相关日志。请勿在问题报告中粘贴 API 密钥、私密文本或不相关日志。当前自动测试使用 GI/网络替身和隔离安装目录，不等同于全部 GNOME/GPU 组合的实机验收。

OCR 诊断可执行包内 `bash diagnose-ocr.sh`，也可以直接运行安装目录中的同名脚本。
只读取版本、解码能力、原生接口声明及截图/识别/缩略图阶段日志，不截图、不读取接口密钥或提示词，不修改设置。

## English quick start

A GNOME Shell 45–51 Wayland-native selection assistant with translation, explanation,
polishing, email, Q&A and custom prompts. Version 2.3.0 adds paragraph-by-paragraph translation with explicit failure reporting,
edge/corner window resizing and a live 8–32 pt result font setting. It retains the 2.2.4 render-scale-aware
selection tracking while preserving the accepted Chinese line-end correction
and working native screenshot OCR from 2.2.2
for GNOME 49–51, using an existing local Ollama PaddleOCR-VL model. GNOME 51 desktop
acceptance is required; automated mocks are not native compositor testing.
OCR uses the official `OCR:` prompt, no language picker, and never uploads screenshots
to an online text backend. Connect your own model backend.

Download **popup-llm-officeassistent-precompiled.zip** from [Releases](https://github.com/yanjing-chen/popup-llm-officeassistent/releases/latest), extract it, and run `bash install.sh` as your normal desktop user. Alternatively, copy the complete UUID directory into `~/.local/share/gnome-shell/extensions/`.
The GSettings schema is already compiled. No Python, Node.js or compilation is required for installation or runtime. Save your work, log out and log back in, enable the extension and configure real available models in Preferences.
