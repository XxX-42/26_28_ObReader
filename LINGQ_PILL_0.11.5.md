# 0.11.5：LingQ 词条卡首行链接与陌生词标签

## 变更

- 将“复制此处链接”改成紧凑的 `🔗 Link` 按钮，固定在词条卡标题首行；点击后仍调用现有 occurrence-link bridge，成功后保留按钮位置并提供成功状态提示。
- 没有个人学习记录的词在卡片状态胶囊中显示“陌生词”。词汇 presentation、个人状态和持久化格式不变；有个人记录但未设置等级时仍显示“学习状态未设置”。
- 窄视口压缩标题行；释义滚动时链接按钮继续固定可见，触控目标保持至少 40px。

## 验证

- `tests/vocabulary-pill-layout-browser.test.mjs`、`tests/vocabulary-controller.test.mjs`、`tests/vocabulary-presentation.test.mjs`：30 项通过。
- 浏览器检查桌面、触控竖屏、横屏、220px 窄视口、正文滚动、链接和等级按钮点击；测试截图保存在 `tests/artifacts/lingq-pill-run-*.png`。
- 深色和浅色主题的卡片均正常，首行控件未重叠并留在可见视口内。
- 构建与三文件打包校验另见发布记录。

没有修改 PDF、批注、WAL/Sidecar、词典或词汇数据。
