# Obsidian 测试库快照

`测试插件/` 是 2026 年 10 月 8 日从 Windows 测试库复制的快照，用于在另一台机器接续测试。原测试库没有被修改。复制范围为 60 个文件、44,931,378 字节，不包含可由内嵌插件资源重新生成的 `.asset-cache`。

## 包含内容

- `测试插件/.obsidian/`：原测试库配置、工作区状态和第三方插件列表。
- `测试插件/.obsidian/plugins/pdf-web-reader/`：0.1.4 的 `main.js`、`manifest.json` 和 `styles.css`，与项目 `dist/pdf-web-reader/` 完全一致。
- `测试插件/PDF迁移测试/`：38 份 PDF、4 份路由测试笔记和 4 张测试图片，保留原文件名和已经保存到文件的批注。
- `测试插件/测试插件/`：历史上已经存在的内层欢迎库，原样保留，不是本项目主要测试库。

38 份 PDF 的前 65,536 字节均与项目 `tests/fixtures/tracemonkey.pdf` 一致，确认来自已有测试 fixture；这个检查不是对所有后续批注内容的完整 PDF 审计。复制后逐文件核对了源文件与快照的 SHA-256。

`SNAPSHOT.json` 列出快照内每个文件的路径、大小和 SHA-256。Git 对实际快照子目录关闭文本换行转换，确保 Windows 和 macOS 克隆后的字节与清单一致。

## 在 Mac 接续测试

1. 克隆或更新仓库的最新 `main`，先阅读根目录 `MACOS_HANDOFF.md`。
2. 将整个 `test-vault/测试插件` 文件夹复制到用户指定的独立测试位置，包括隐藏的 `.obsidian`。建议使用仓库外的副本，避免正常 Obsidian 使用不断修改已跟踪的 workspace/config/PDF。
3. 在 Obsidian 中以“打开文件夹作为仓库”打开这份副本。目标是含 `.obsidian` 和 `PDF迁移测试` 的外层 `测试插件`，不要误开其中同名的内层文件夹。
4. 按用户自己的安全设置启用 `PDF Web Reader`。工作区或插件启用列表不能代替首次加载确认；当前 0.1.4 仍是 desktop-only，尚未在 macOS 原生验收，也不支持 iOS/iPadOS。
5. 点击 `PDF迁移测试/五工具测试.pdf` 或一份 native 测试副本，验证打开、工具 `1–5`、二次批注和保存重开。不要对快照以外的用户 PDF 原件做写入验收。

首次打开 PDF 会从插件内嵌载荷生成版本化 `.asset-cache`。不需要 Windows EXE、本地端口服务或外部浏览器。省略原机器缓存不等于省略 Viewer 资源。

## 快照的限制

- 仅包含磁盘上已经保存的内容，不包含窗口中的未保存批注、应用账号状态、全局 Vault ID 或内存会话。
- `workspace.json` 原样保留用于识别原测试场景；另一台机器是否恢复相同标签页，需要由实际 Obsidian 启动验证。
- `tests/native-*.mjs` 的 Windows CLI、Vault 路径和 ID 尚未参数化；本快照存在不表示原生脚本可以直接在 Mac 运行。
- `.asset-cache`、运行时 `.trash`、macOS `.DS_Store` 和新生成的移动工作区文件不应加入版本历史。它们已在项目忽略规则中排除。
- 后续插件更新需要先保存并安全关闭测试视图，再按交接说明替换副本内的三个发布文件。本快照不是插件自动更新机制。
