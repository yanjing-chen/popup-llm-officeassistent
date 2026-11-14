# Popup LLM Office Assistent 2.1.4

六功能 GNOME Shell 助手：翻译、解释、润色、邮件、智能问答、自定义。

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

Download **popup-llm-officeassistent-precompiled.zip**, extract it, and run
`bash install.sh` as your normal desktop user. Alternatively, copy the complete
UUID directory into `~/.local/share/gnome-shell/extensions/`.
The GSettings schema is already compiled. Log out and log back in after installation.
See README for backend setup, settings and the complete source archive.

自动测试不等同于所有 GNOME/GPU 组合的实机验收；遇到问题请附 Shell 版本及相关日志。
