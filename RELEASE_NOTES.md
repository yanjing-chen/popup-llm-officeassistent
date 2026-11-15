# Popup LLM Office Assistent 2.2.4 — 文字选区渲染缩放与跨行跟随

保留六项文字功能和第七项原生截图 OCR。
用户已确认 2.2.2 的 OCR 识别和 2.2.3 的中文末字复制成功。
本版本补齐中文字形命中的资源缩放，仍需 GNOME 51 实际拖选复测。

- 修正 2.2.3 直接将逻辑像素传入渲染空间排版的遗漏：2 倍资源比例时可导致鼠标第四行、选区第二行。
- 坐标乘文字 Actor 当前资源比例后再减排版偏移；与父 Actor 变换、Pango 单位分别处理，不能重复或漏算。
- 保留即时 motion 与现有绘帧跟踪，不新增定时器、不提高轮询频率，不修改系统缩放或字体。
- 资源比例逐次读取，窗口换屏/比例变化不使用旧缓存；每窗口/比例变化仅记录一次数值型诊断标记。
- 新增 1.25/1.5/1.75/2/3 倍资源比例、逐行即时命中、滚动偏移、Actor 变换、动态换屏比例的回归。
- 扩展真实 Pango 到生产命中方法的测试，覆盖 2 倍渲染布局的逐行内部点及行尾；保留全部末字回归。

- 修正中文末字必须向下拖才能选中的问题，翻译、OCR 等结果窗统一生效。
- 多字节文本按 Pango 的 UTF-8 字节索引与 trailing 字符数分别换算，不把字形后边界向前舍入。
- 同行拖至文字右侧空白仍采用有效的末尾插入位置；自动换行处受抑制的后边界使用原生字形移动恢复。
- 覆盖中文、混排、标点、组合字符、正反拖选、换行、缩放/偏移、复制和二次处理；不会为了全选而追加换行。
- 西文 ASCII 保留原命中路径；其余选区事件、高亮和复制方法不变。
- 2.2.2 的原生截图、OCR 传输/解码和等比例预览模块保持逐字节不变，首次空选区快捷键保持。
- OCR 设置与其他功能一样包含模型选择和提示词；只列真实模型，不再按 PaddleOCR-VL 名称过滤，不自动猜选。
- OCR 设置和浮动按钮仍位于自定义前；不增加顶栏入口。
- 点击按钮直接进入 GNOME 原生截图，截完且原生界面退出后才出现 OCR 窗。
- 顶部复制/关闭、上方缩略图、下方识别文字、底部识别按钮；无语言菜单、耗时或额外操作栏。
- 使用已有本机 Ollama 和真实 PaddleOCR-VL 模型，默认官方提示词 OCR:；不另装识别环境。
- 取消、截图忙、异步读图、锁屏、禁用、接口变化和请求关闭均有清理保护。
- 除有针对性的坐标命中方法外，原有选区方法、顶部复制动作和拖动帧循环保持逐字节不变。
- 随插件安装只读 diagnose-ocr.sh，增加独立 GJS 解码能力检查和识别/缩略图阶段日志。

- 功能按钮条位于本插件所有结果窗之上，保留流畅拖动、独立多窗口和结果内选区处理。
- 模型菜单只采用后端实际列表；无模型显示“尚未安装模型”，不内置示例模型。
- 模型退出显存时间为 0–86400 秒，默认 60 秒。
- 完整源码、回归测试、安装脚本及 GitHub Actions 均包含在源码包中。

## 安装 / Install

普通用户下载 **popup-llm-officeassistent-precompiled.zip**。
包内已包含 `schemas/gschemas.compiled`，无需编译、Node.js、Python 或开发工具。
解压后执行 `bash install.sh`，或将 UUID 文件夹完整复制到当前用户的
`~/.local/share/gnome-shell/extensions/`。安装完成后保存工作、注销并重新登录。
模型后端（例如 Ollama）及实际模型需由用户自行准备；本包不会自动下载安装模型。
新增截图 OCR 需要 GNOME 49–51 的原生截图时序，重点为 GNOME 51；45–48 保留旧六功能。
OCR 图片严格只发送到本机 Ollama，普通在线文字接口不会接收截图。

Download **popup-llm-officeassistent-precompiled.zip**, extract it, and run
`bash install.sh` as your normal desktop user. Alternatively, copy the complete
UUID directory into `~/.local/share/gnome-shell/extensions/`.
The GSettings schema is already compiled. Log out and log back in after installation.
See README for backend setup, settings and the complete source archive.

自动测试不等同于所有 GNOME/GPU 组合的实机验收；遇到问题请附 Shell 版本及相关日志。
