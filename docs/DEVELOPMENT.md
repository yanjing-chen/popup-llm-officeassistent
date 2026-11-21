# 开发与发布

2.3.0：新增独立 translation.js / textClient.js，不修改 OCR 传输、解码或原有文字选区方法。
翻译原文分段前后逐字符校验，顺序发送；一次模型 lease 覆盖整次任务，取消和过期回调不继续发送后续段。
SSE 处理完整事件、UTF-8 跨读边界和结束状态；任何损坏、空回答、非正常结束都不可静默跳过。
逐段完成只证明结构性接收，不证明模型在单段内部没有语义遗漏，需用脱敏原文进行实机回归。
新 popupGeometry.js 集中验证八向缩放和 8–32 pt 字号；缩放只在手势期间运行 FrameLoop，布局每帧最多更新一次。
拖动、文字选取及截图核心模块保留；缩放时缓存可见正文，网络继续，结束后一次恢复。
字体更改只影响结果标签，关闭窗口断开设置监听；不改系统字体、显示缩放或其他软件。

2.2.4 补齐中文/多字节坐标命中的文字资源缩放：先将 Actor 逻辑坐标乘当前 resource scale，
再减渲染空间的 layout offset，最后换算为 Pango 单位；不能把 Actor 变换、资源缩放和 Pango.SCALE 混为一谈。
保留用户已确认的 2.2.3 行尾 trailing/自动换行修正，西文 ASCII 沿用原来的命中路径。
鼠标 motion 和帧时钟代码不改；已有回归模型只覆盖了 Actor 变换，现补独立资源缩放及真实缩放排版测试。
用户已确认 2.2.2 的 OCR 识别成功；原生截图、OCR 请求/解码、缩略图模块保持逐字节不变。
仅 _outputPositionAt 需要改变，其余选区方法、顶部复制动作、
textSelection.js 和 frameLoop.js 继续按稳定基线做 SHA-256 回归锁定。
新增真实 Pango → 生产 JavaScript 命中方法的可选测试；无显示器/无 GNOME Shell 也可执行，
但不能代替用户在 GNOME 51 的真实鼠标操作验收。
每窗口/比例变化仅记录一次数值型 resource-scale，不输出选中文本或逐帧日志，便于只读诊断。
新增源码、测试与界面要求见 [OCR.md](OCR.md)。这里没有 GNOME Shell/本机模型实机验收结果；
应在 GNOME 51 完成验收后再运行正式发布命令。
维护者本地发布脚本只面向 `yanjing-chen/popup-llm-officeassistent`，提交作者为
Yanjing Chen / yanjing_chen@qq.com，只写本次新克隆仓库的本地 Git 配置。

## 开发工具

Python 3.10+、Node.js 22+（CI 使用 24）、Git、GSettings 与 glib-compile-schemas。
Ubuntu 可按需安装 git、gh、python3、libglib2.0-bin；Node 仅用于开发测试。
这些都不是最终用户安装/运行插件的额外要求。

```bash
# 修改 XML 后重新生成随源码分发的 schema
glib-compile-schemas --strict 'popup-llm-officeassistent@yanjing_chen@qq.com/schemas'
# 源码有变动后更新清单，再测试和构建
python3 scripts/release_tools.py checksums
bash verify.sh
python3 scripts/release_tools.py build --tag v2.3.0
```

dist 中产生免编译插件 ZIP、完整源码 ZIP、SHA256SUMS 和 Release 说明。
打包时另在临时目录严格编译并验证 schema，不修改原始源码；复制安装包不包含 tests、Actions 或开发工具。
完整源码 ZIP 则包含全部运行代码、schema、文档、测试、脚本和隐藏的 .github/workflows。

## 从维护者自己的 6800H 发布

先确认 gh 已登录 yanjing-chen；必要时自行运行 `gh auth login --hostname github.com`。
在完整源码包目录执行：

```bash
bash scripts/publish_from_6800h.sh "$HOME/下载"
```

脚本会：核对账号/仓库写权限和可见性，在指定目录下创建新的临时工作树，克隆 main，
保留远端历史，复制完整源码，测试并构建，创建版本标签，然后普通原子推送 main 与标签。
不会接触其他已有本地项目目录，不会修改全局 Git 设置、仓库可见性或远端分支保护。
远端额外文件、已有同名标签、并发更新或保护/权限失败会导致停止，不会强推或删除远端文件。
若 main 本身不存在但仓库确实完全为空，可创建初始 main；有其他分支时则停止等待核对。

GitHub Actions 发布完成之前，不应把本地“推送成功”当成 Release 构建已成功。
可以自行在网页 Actions 查看，或使用：

```bash
gh run list --repo yanjing-chen/popup-llm-officeassistent --limit 5
gh release view v2.3.0 --repo yanjing-chen/popup-llm-officeassistent
```

如果认证缺少 workflow 权限或 main 受保护，请停下核对授权/仓库规则；不要用强推绕过限制。
若仓库目前为 Private，本脚本保持 Private；不会擅自改成 Public。

## 安装脚本

默认 `bash install.sh` 校验并使用已编译 schema，不调用 glib-compile-schemas。
只有开发者显式执行 `bash install.sh --recompile-schemas` 才会编译安装暂存目录中的 XML。
发布前仍需把源码目录内的编译 schema 与 XML 同步后再更新 CHECKSUMS.sha256。

本次未引入或更改许可证声明；请由项目维护者另行决定需要采用的许可证。
