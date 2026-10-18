# LingQ 构词展示：来源与限制

`viewer-adapter/vocabulary/word-morphology.js` 是 ObReader 原创的纯 JavaScript 实现，代码与手工整理的构词事实按本项目 Apache-2.0 许可发布。中文部件说明为本项目独立撰写，没有导入第三方词典释义、书籍分析串或词根数据库。

## 参考的算法思想

研究对象为 [RichardoZhao/WordDecoder](https://github.com/RichardoZhao/WordDecoder)。其 [decode.js](https://github.com/RichardoZhao/WordDecoder/blob/main/decode.js) 使用分层剥离词缀、还原词干并验证派生关系的算法；[代码许可为 MIT](https://github.com/RichardoZhao/WordDecoder/blob/main/LICENSE)。本实现仅参考该一般算法思想，未复制代码。

WordDecoder 的 [Sources & License](https://github.com/RichardoZhao/WordDecoder#sources--license) 另外说明：词根与分析来自李平武书籍，释义来自 Collins，底层数据商业再用需另行取得许可。因此本项目没有引入它的 `data/lexicon.js`、分析串、中文释义、词表或书籍内容，不能将其代码的 MIT 标识等同于数据授权。

## 保守范围

首版内置 53 个独立整理、明确列出的构词关系，另有独立撰写的有限词基集合和生产性构词规则。纯 JavaScript 引擎按后缀生成候选、进行 i/y、静音 e、双写辅音与 -ability/-able 等受限拼写还原，再验证词基及词类，最后尝试前缀。递归深度最多 4、总候选最多 64；无词基验证不输出。未在整词表硬编码的 readability、unreadable、helpfulness、reusability 可以据此解析；corner、business、department 不会只凭相似结尾被拆分。

这不是覆盖所有英语的词源字典。词基集合有限，词类约束和规则是学习辅助；未采用 ECDICT 动态全表扫描或网络查词扩充候选。未覆盖的词、专名、连字符和短语显示完整原词及“暂无可靠构词分析”，不把所有不可拆词声称为本族词。

这是构词学习提示，不是完整词源数据库，也不推导用户学习状态。切换全词／词根模式只改变词条卡显示；不会改变 PDF 文本、词形匹配、学习等级或持久词汇记录。整个原词始终可读。

## 验证

- `node --test tests/vocabulary-word-morphology.test.mjs tests/vocabulary-controller.test.mjs tests/vocabulary-bridge-open-state.test.mjs tests/vocabulary-presentation.test.mjs`：37 项通过，覆盖候选构词、保守拒绝、全局持久化失败回退、同宿主写入串行、多 Reader 广播、旧 renderer/open 拒绝及现有词汇语义。
- `node --test tests/vocabulary-word-morphology-browser.test.mjs`：桌面 1280px、触控 390px 与 220px 窄视口通过；模式等待宿主确认、卡片重开保留选择、模式与等级控件可达，未新增页面查询。
- 现有完整 `vocabulary-pill-layout-browser` 桌面/窄触控布局回归通过；另在同一真实 PDF.js 测试宿主捕获 subscription 构词展开的桌面/触控截图，人工检查了布局与暗色可读性。
- 构建继续验证 402 个冻结 vendor 文件；三文件离线 smoke 覆盖原有 5 种批注的保存重开及批量删除不复活。构词逻辑不修改源 PDF/批注存储；最终集成发布记录见 `LINGQ_WORD_ROOTS_0.11.7.md`。

iPad 证据为 Chromium 触控模拟，尚无本轮 iPadOS/WKWebView 实机验收；53 条人工关系和有限词基不能保证所有英语词均可拆分。
