# Native Markdown 来源定位：EditorRange 适配

Native 0.14 测试在 Markdown 改名后报告 `markdown-excerpt-changed-during-open`，但截图中的原文已经被精确选中。解析与选择成功后，定位函数把单个 `EditorPosition` 传给 `editor.scrollIntoView`，异常被捕获后返回失败，导致上层误以为原文发生变化。

[Obsidian 官方 API](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts) 定义的参数是 `EditorRange`，包含 `from` 和 `to`，不是单个位置。最小修复只调整该调用的参数；不修改源文、绑定、selector、History 或任何 PDF/WAL 数据。

已有 Host mock 原先不检查参数。此次先将大摘录测试的 mock 收紧到真实 API 契约，保留原有成功、精确选择、异步源变化和禁止 cursor fallback 的断言，得到确定性 RED；修复后重新跑 Host/learning 回归。原先记录错误参数结构的两个断言同步改为官方 range 结构，覆盖精确选区及折叠光标。

Native 失败证据保留在 `codex/014-native-sol-low` 的 `evidence/native-sol-low/`。修复后的 Native 续跑仍需验收，不能以单元通过代替。
