# 个人词库 schema v1 → v2 迁移

候选在启用插件时检查 `00_Archive/21_VocabularyData/en.vocab.json`。没有文件时不创建空词库。已验证的 v1 可以读取，但写入等待显式迁移完成；v2 正常读取；未知或更高版本拒绝写入。

迁移保留每条记录的 key、surface、type、translation、note、phonetic、创建/更新时间和 source，不合并用户文本字段。唯一新增的持久学习身份是 `familyKey`：版本化的确定性 family 描述，复用现有英语匹配器。walk/walking/walked 可以保留不同记录，但共享等级、复习身份及语境分组；lay/lie 的歧义规则不由迁移器猜测。迁移把同 family 的有效等级统一为已有最高等级，保留 Known 保护。storageKey 的确定性代表选择可能变化，familyKey 不随代表变化。

替换使用验证后的临时写入和原文件保护；成功读回并验证后才报告完成。失败保留原始数据与证据，不返回成功确认。重复启动、重复 migrate 不增加记录或重复提升修订号。测试同时运行真实旧版 v1 Reader 源码，验证旧 Reader 对 v2 报 unsupported schema，且零覆盖写入。

Context 正文、Review 状态、评分日志及 History 不进入主快照：

```text
00_Archive/21_VocabularyData/
  en.vocab.json
  contexts/manifest.json + <hash-prefix>.json
  review/states/manifest.json + <hash-prefix>.json
  transactions/<local-device>/<session>/...
  history/<device>/<batch-hash>.json
```

Context 与 Review 仅在实际使用时建立非空分片。词典数据仍是只读数据源及可重建查询缓存，不参与迁移学习身份或评分。

升级前保留旧版本和匹配的数据备份。旧客户端不得继续编辑 schema v2；回滚插件时不能假定旧客户端能读取新格式。候选不会自动删除旧用户数据或执行 History GC。

当前不支持跨设备并发自动合并 Vocabulary。提交前发现外部 canonical 文件变更会拒绝覆盖，要求重载并处理冲突；本地事务与 History 不是跨设备同步协议。
