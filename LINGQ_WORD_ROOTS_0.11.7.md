# 0.11.7：LingQ 全局全词／词根模式

## 集成基线

主线基于 `c27fcdc38f96df59b9bf61e88863cda0abc7e1e8`（0.11.6），保留 PDF.js 页根节点链接捕获修复。并行支线提交 `2cd4d56212a1f84724c39bbf4f7100f51c5c1567` 以 `94c325a` 整合。没有改动原工作区未提交内容。

## 行为与边界

点击 LingQ 卡片中的英语标题可展开全词／词根模式和构词提示。模式是全局 `vocabularyWordDisplayMode` 设置；宿主确认 `saveData` 成功后广播到所有 Reader，失败恢复先前值。启动资源和文档 open 消息携带同一设置。切换不影响学习等级、词形家族、PDF 文本、匹配或几何缓存。

原创纯 JS 引擎采用受限候选剥离、拼写还原、词基与词类验证。首版有 53 条人工构词关系和有限词基，递归最多 4 层、总候选最多 64。支持 `subscription → sub- + script + -ion` 并解释词干变化，也能解析未在整词表硬编码的 `readability`、`unreadable`、`helpfulness`、`reusability`。未覆盖或不可靠的分析保留全词；这是有限覆盖的构词学习提示。代码只在展开词根卡片时分析，当前卡缓存结果，不进入页面匹配或缩放路径。

WordDecoder 仅作为算法思想参考，未复制其代码、李平武书籍分析数据或 Collins 释义。当前规则、说明和数据为本项目独立整理，使用 Apache-2.0；详见 `WORD_MORPHOLOGY_SOURCES.md`。

## 验证

- 167 项相关测试全部通过：全部 vocabulary 测试、Reader Anchor Store、外置 bridge、TextSelectionController、圆盘 LingQ、桌面鼠标、Selection differential 及打包回归。日志 `/tmp/obreader-morphology-regression.log`。这不是默认全仓并发套件结果。
- 构建严格三文件，406 项嵌入资源及 402 个冻结 vendor 校验通过：`/tmp/obreader-morphology-build.log`。
- 离线 smoke 通过：5 种工具、操作保存重开、批量删除不复活、正常退出：`/tmp/obreader-morphology-offline.log`。
- 1280px 桌面、390px 触控与 220px 窄屏构词卡截图已视觉检查；纯卡片样本与 PDF.js 布局样本用于 UI 验证，未冒充 PDF 原文。iPadOS/WKWebView 仍待实机复验。
- 0.11.6 正式库真实 `subscription` 链接已完成 Host→Viewer 捕获→Anchor 落盘→剪贴板→增强 resolver→临时 Selection Highlight 链路；page 3 / `ref:98R`、quote `subscription`，原 PDF SHA-256 前后相同。证据保存在 0.11.6 库外备份的 `native-occurrence.json`。

发布时先推送功能分支，再备份正式库插件、外置批注和个人词汇，仅替换三文件并重载，部署记录留在库外。PDF、WAL/Sidecar、Annotation UUID、Pencil/Finger 路径和冻结 vendor 未修改。
