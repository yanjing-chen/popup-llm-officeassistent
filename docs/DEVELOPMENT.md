# 开发与发布

运行环境源码保持 2.1.4 的交互实现；本次整理只添加仓库文档、完整性检查、打包和发布流程。
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
python3 scripts/release_tools.py build --tag v2.1.4
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
gh release view v2.1.4 --repo yanjing-chen/popup-llm-officeassistent
```

如果认证缺少 workflow 权限或 main 受保护，请停下核对授权/仓库规则；不要用强推绕过限制。
若仓库目前为 Private，本脚本保持 Private；不会擅自改成 Public。

## 安装脚本

默认 `bash install.sh` 校验并使用已编译 schema，不调用 glib-compile-schemas。
只有开发者显式执行 `bash install.sh --recompile-schemas` 才会编译安装暂存目录中的 XML。
发布前仍需把源码目录内的编译 schema 与 XML 同步后再更新 CHECKSUMS.sha256。

本次未引入或更改许可证声明；请由项目维护者另行决定需要采用的许可证。
