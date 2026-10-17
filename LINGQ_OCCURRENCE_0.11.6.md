# 0.11.6：修复词汇位置与普通选区链接捕获

基线为 `8da68a2f48cdb6ebc9de94314c16005b14631c07`（0.11.5）。实际 PDF.js 页根节点 `id=""`，页码在 `data-page-number`；旧 capture 逻辑把空 id 转成 0，因而无法匹配已确认页面身份。

现在从页码属性读取，并以 `pdfViewer.getPageView(pageIndex).div === pageRoot` 验证页面属于当前 Viewer；旧 `pageN` id 仅在对应当前 Viewer 页面且不与属性冲突时兼容。冲突、畸形页码、外来/旧页面根节点、词面不一致仍 fail closed。普通选区和 LingQ occurrence 共用此校验。没有修改 authenticated bridge、源哈希校验、Anchor 格式或批注/词汇存储。

原布局测试直接模拟 occurrence 成功回复，遗漏真实回捕链路。本次改为让 Host 请求真实 `reader-anchor-capture`，收到合法 capture 才 ACK；旧代码在该测试中重现截图错误，修复后通过。覆盖桌面、190% 缩放、触控、正文滚动后点击，以及错误页码/旧 DOM/错误词面拒绝。相关 61 项测试通过；三文件与 vendor 打包校验 4 项通过；离线保存重开和批量删除 smoke 通过。

复现及测试日志保存在库外：`/tmp/obreader-occurrence-baseline.log`、`/tmp/obreader-occurrence-regression.log`、`/tmp/obreader-occurrence-build.log`、`/tmp/obreader-occurrence-packaging.log`、`/tmp/obreader-occurrence-offline.log`。真实 iPad/WKWebView 尚待设备验收。
