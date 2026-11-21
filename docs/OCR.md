# 原生截图 OCR — 2.3.0

2.3.0 为 OCR 结果窗增加边缘/四角缩放和字号控制；原截图、识别传输/解码及缩略图核心模块不变。
缩放仅改变已解码缩略图的显示尺寸，不重新截图、不裁切、不重新识别。

## 范围与界面

- 2.2.3 针对用户报告的中文行尾命中修正；不重写选择事件、高亮、复制、二次弹窗或拖动。
- OCR 不再是未验证的识别链路：用户已确认 2.2.2 的识别成功，2.2.3 的截图、OCR 请求/解码、预览模块逐字节保留。
- 选区修正统一作用于翻译、OCR 等结果窗的多字节文本，而非 OCR 专用；ASCII 命中路径不变。
- 用户已确认 2.2.3 解决末字复制；2.2.4 只补齐文字资源缩放，修正拖选跨行偏差，不改更新节奏。
- 设置、浮动工具条顺序：翻译、解释、润色、邮件、问答、OCR、自定义。
- OCR 功能与其他功能一致：开关、模型下拉菜单、系统提示词；连接/发现/显存时间复用已有设置。
- 模型菜单只采用当前后端实际列表，不按名称过滤，不自动猜选或替换。
  以后新模型加入后刷新即可选择；模型本身须支持图片输入。不在结果窗加模型操作栏。
- 顶栏菜单不增加 OCR 入口。自定义快捷键在冷启动、空 PRIMARY 或没有回调时也立即显示工具条，
  相机无需选中文字；其余文字功能无文本时暂不可点。自动滑词模式在空选区仍保持安静。
- 点击 OCR 直接进入系统截图；成功截完并退出原生界面才创建插件窗口。
- 结果窗从上到下：原有标题/复制/关闭、缩略图、可滚动文字、底部识别按钮。
  不增加耗时、语言选择、额外状态栏或其他操作栏。

## 组件和安全边界

| 文件 | 职责 |
| --- | --- |
| nativeScreenshot.js | 一次原生截图任务、按钮事件后直接打开、截图/关闭信号、异步有界读图、恢复与清理 |
| ocrUtils.js | 实际已选择模型校验、回环地址、PNG/大小校验、NDJSON 解码 |
| ocrClient.js | 本机 Ollama /api/generate，原始 PNG、提示词、流式和取消；不加载推理框架 |
| ocrPreview.js | 异步等比例缩略图、原始 PNG 内存流、小纹理与窗口关闭取消 |
| resultWindow.js 的 OCR 分支 | 现有标题/复制、缩略图、底部识别；结果接入原有选区接口 |

- 原生入口直接使用 Main.screenshotUI.open() 的默认截图模式，不模拟 Print、
  不调用 Shell.Eval、不替换原生函数、不申请自己的鼠标/桌面输入抓取。
- 隐藏插件结果窗后，等按钮事件返回，从一次 idle 调用原生 open()。
  不再要求模块导出 UIMode，也不等待 Stage::after-paint。
  原生 open() 自行取得当前场景截图。仅“打开”阶段有 10 秒超时；
  界面正常打开后立即移除超时，用户可以慢慢选择截图区域。
- 用户已确认 2.2.1 的原生截图和预览窗口可打开；2.2.2 不改该截图入口。
- 2.2.1 的响应解析使用 TextDecoder.decode(bytes, {stream: true})，在不支持该选项的 GJS 中
  即使 Ollama 返回成功也会抛错，旧窗口又把它误报为“连接中断或返回异常”。
  新版先保留字节，按完整 NDJSON 行解码，不传 stream 参数；非流式在完整 JSON 收齐后解码。
  严格拒绝非法 UTF-8、未完成响应、无效结构和超限数据，中文/emoji 在任意字节边界分块均保留。
  已用会拒绝 stream 选项的解码器复现旧失败并覆盖成功路径；实际机器是否正是此异常仍以诊断为准。
- 成功信号提供本次 Gio.File；读取是异步且有界的。必须等本次读图完成以及
  原生界面退出，才创建 OCR 窗。closed 不是截图文件读取完成的同义词。
- 支持 GNOME 49–51 的原生截图时序；49+ 已含“等待保存后再关闭”的上游修正。
  不对 45–48 的早期关闭/保存时序使用猜测性延时，旧六功能继续可用。
- 截图忙、录屏、打开失败、取消、锁屏、概览、屏幕变化、切换接口、关闭 OCR、
  禁用扩展均有清理路径。晚到的图像不能创建新弹窗。
- 不读剪贴板、不看截图文件夹，不会把用户之前的图片当作本次截图。
  不删除 GNOME 保存的截图，系统保存和复制照常。
- 图像上限 32 MiB / 4000 万像素，回应上限 2 MiB；缩略图只显示，
  请求使用原始 PNG，不把预览大小当作 OCR 分辨率。
- 预览不再使用 St.Icon。Gio.MemoryInputStream + GdkPixbuf 异步缩小并保留宽高比，
  St.ImageContent 显示实际长宽；最大 480×220 逻辑像素，小图不放大，并按显示缩放提供纹理。
  使用 GNOME 48+ 的显式 Cogl.Context 参数。关闭窗口时取消解码，晚到纹理不能写入已关窗口。
- 只接受 HTTP localhost、127.0.0.1 或 [::1] 的前部 Chat Completions 地址，
  从同一地址推导 Ollama /api/generate；拒绝在线地址和重定向，不使用代理。
- 每次识别重新读取实际 /api/tags，不能靠 Shell 缓存继续使用已删除模型。
  不启动、下载、升级或删除模型。支持选择任意实际模型 ID，不要求 PaddleOCR-VL 标识。
- 官方文本任务提示词默认 OCR:，温度固定 0。不追加语言、翻译、聊天历史或思维链指令。
- 每窗口独立 HTTP 会话和请求，关闭时取消本窗口，不中断其他结果窗。
  使用已有模型忙碌计数和空闲时间；同一 Ollama 模型仍是跨程序共享资源，
  与 SnapMark 共用时，卸载可能使另一程序下次使用时重新加载。
- 不改 SnapMark 配置或代码；两个程序同时运行时应一并检查系统截图相关行为。

## GNOME 51 手工验收清单

1. 关闭旧设置窗口、安装、保存工作并注销登录。确认 Loaded build=2.3.0-translation-resize-font，
   不能只以磁盘 metadata 判断当前会话已载入新 JS。
2. 现有接口不变，刷新真实列表。检查 OCR 位于自定义前，展开有模型与系统提示词，
   默认 OCR:，无语言菜单。选择已安装的 PaddleOCR-VL；未来模型也不按名称排除。
3. 重新登录后不要先划词，直接按配置快捷键：空桌面也应出现工具条，相机可点；
   文字工具无输入时暂不可点。随后选词再按快捷键，文字工具应恢复。自动模式空选区不弹条。
   点击 OCR：应直接出现系统截图，不能先出现空 OCR 窗，
   插件原有窗口不应进入截图；截图选区、鼠标和 Esc 应完全由原生界面处理。
4. 取消：不出现新窗口，旧窗口恢复，桌面输入和拖动正常。
5. 成功截图：原生界面完全退出后才出现预览；分别截图横长条、竖长条、小图、正方形，
   上方原图比例不变，不被拉伸成方块、不裁边；下方文字区，
   复制在顶部、识别在最底部，没有模型操作栏和耗时。
6. 点击识别：使用现有本机 PaddleOCR-VL 返回实际文字。分别开关流式输出，测试多语言混合；
   不用选择语言，不应把内容自动翻译。
7. 检查顶部复制选区/全文、Ctrl+C、二次翻译/润色和旧窗口的原有操作。
   重点测试中文：鼠标同一行向右拖过末字，最后一个字应直接选中，不用向下拖。
   翻译和 OCR 都测；再测中西混排、标点、反向拖选、自动换行及普通英文对照，不能多选下一行。
   保持自己原有的显示缩放，逐行向下/向上拖动，选区应跟随当前行；有多屏时检查跨屏移动后重选。
8. 连续截图至少三次：窗口与原图独立；关闭一个不会关闭其他窗口。
9. 识别中拖动、选择、关闭窗口；重试可用，没有残影、输入卡住或晚到回答写错窗口。
10. 检查无模型、模型被删除、多个模型、服务未开和连接错误；不得自动上传到在线后端。
11. 截图中锁屏/切到概览/禁用扩展后，应无遗留输入抓取或回调；重新启用正常。

## 诊断（不包含图片和密钥）

先点击一次相机按钮、截图并点击“识别”，再运行安装目录中的只读脚本：

```bash
bash "${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/popup-llm-officeassistent@yanjing_chen@qq.com/diagnose-ocr.sh"
```

它读取当前版本、OCR 开关/模型选择、独立 GJS 解码能力、可用系统截图资源接口声明与阶段日志；
不执行 Shell.Eval、不截图、不改变任何配置，不读取 API 密钥或提示词。
phase=queued 表示已排队，phase=open 表示已实际调用原生入口，phase=opened 表示界面已打开。
失败包含 NO_NATIVE_UI、NO_NATIVE_OPEN、CONNECT_FAILED、OPEN_FAILED、OPEN_TIMEOUT 等明确代码。
识别日志以 recognize 区分：phase=connect、read、complete。失败代码区分 HTTP_数字、
CONNECT_FAILED、READ_FAILED、DECODE_FAILED、INVALID_JSON、INVALID_RESPONSE、
INCOMPLETE_RESPONSE、BACKEND_REJECTED；发现/模型列表/内部处理也各有阶段。
预览错误为 PREVIEW_LOAD_FAILED，不会错误地阻止原图识别。

```bash
gnome-shell --version
gnome-extensions info 'popup-llm-officeassistent@yanjing_chen@qq.com'
```

查看本功能阶段日志：

```bash
journalctl --user -b --no-pager -o cat | rg '\[PopupLLM( OCR)?\]' | tail -n 60
```

若系统不把 Shell 日志放在 user journal，可用下式（不加 sudo）：

```bash
journalctl -b --no-pager -o cat _COMM=gnome-shell | rg '\[PopupLLM( OCR)?\]' | tail -n 60
```

日志只有版本、阶段、状态码和字节数，不记录图片、提示词、接口密钥、URL 或后端正文。
文字命中另有 selection resource-scale 数值标记，每窗口/比例变化才记录一次，不记录文字或鼠标轨迹。
反馈时请不要附 API 密钥或私密 OCR 内容。
自动测试使用 GI、绘制/网络替身和隔离目录，不能代替此清单的真实 GNOME/GPU/模型测试。

## 依据

- GNOME 46 新增 ScreenshotUI 的 screenshot-taken、closed 与 SCREENSHOT_ONLY：
  https://gjs.guide/extensions/upgrading/gnome-shell-46.html
- 原生 open() 调用示例（扩展作者提交的源码）：
  https://extensions.gnome.org/review/70556/
- PaddleOCR-VL 官方 OCR:：
  https://huggingface.co/PaddlePaddle/PaddleOCR-VL
- Ollama 图片、流式和 keep_alive：
  https://docs.ollama.com/api/generate
- GJS TextDecoder 初始实现的 stream 选项限制：
  https://lists.gnome.org/archives/commits-list/2021-July/msg00774.html
- GdkPixbuf 异步等比例解码：
  https://docs.gtk.org/gdk-pixbuf/type_func.Pixbuf.new_from_stream_at_scale_async.html
- GNOME 48+ St.ImageContent/Cogl.Context 参数：
  https://gjs.guide/extensions/upgrading/gnome-shell-48.html
- Clutter Actor 资源缩放说明：
  https://gnome.pages.gitlab.gnome.org/mutter/clutter/method.Actor.get_resource_scale.html
