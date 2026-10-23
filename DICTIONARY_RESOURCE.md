# 词典资源与本机查询缓存

Vault 的词典资源是可同步的依据。当前 resource-v3 按 key 范围分块，查词只读取命中的压缩块；Dexie 4 / IndexedDB 仍可提供已就绪的 resource-v2 兼容缓存。个人学习记录仍保存在 `00_Archive/21_VocabularyData/en.vocab.json`，不进入词典缓存。

## 最终目录

```text
00_Archive/21_VocabularyData/dictionaries/ECDICT/
├── LICENSE-MIT.txt
└── resource-v3/
    ├── manifest.json
    └── blocks/
        └── block.<SHA-256>.jsonl.gz
```

ECDICT 来源：[skywind3000/ECDICT](https://github.com/skywind3000/ECDICT)。分发时必须同时保留其 [MIT 许可证原文](https://github.com/skywind3000/ECDICT/blob/master/LICENSE)及版权声明；`LICENSE-MIT.txt` 保持在 ECDICT 上级目录，资源转换不会覆盖或移动它。Dexie 4.4.6 使用 Apache-2.0，许可证随三文件插件的内嵌资源一起打包。

## 构建与迁移

```sh
node scripts/build-dictionary-resource.mjs \
  --input /path/to/ecdict.csv.gz \
  --output /path/to/ECDICT/resource-v2
```

构建器直接解析 gzip CSV，保留原有规范化与重复词条取舍规则；不再生成或依赖旧分片。词条按规范化 key 排序并写为 UTF-8 JSONL：

```json
{"key":"example","translation":"释义","phonetic":"ɪɡˈzæmpəl"}
```

每条记录以换行结束，gzip 的时间与主机字段固定。压缩资源以自身 SHA-256 命名，资源完整写入后才原子发布 manifest。清单包含独立 schema、词典 ID、规范化版本、词条数、压缩及解压字节数和源文件摘要，不包含本机路径、时间戳或随机 ID。构建器拒绝覆盖不属于该格式的 manifest，也不会覆盖摘要不匹配的同名资源。

迁移前备份插件、个人词汇、词典与批注数据到 Vault 外。新旧格式逐条比较通过且新资源可查询后，才把 `index-v1/` 和原始 `ecdict.csv.gz` 移出 Vault，保留库外回滚副本。部署 resource-v3 前应先在测试 Vault 验证同步与查询；所有设备应升级到支持 resource-v3 的插件。回滚时恢复旧插件和相应的旧资源，不删除个人词汇。

### 从 resource-v2 转换为 resource-v3

当原始 CSV 已不在 Vault 时，可从已验证的 v2 资源生成 v3：

```sh
node scripts/build-dictionary-resource-v3.mjs \
  --input /path/to/ECDICT/resource-v2 \
  --output /path/to/ECDICT/resource-v3
```

转换器会先校验 v2 压缩字节数、SHA-256、解压字节数、全部 770,611 条记录、排序、规范化和 JSONL 规范字节，再写入 v3。它保留 v2 资源摘要及上游来源摘要作为 provenance。分块以约 256 KiB 压缩体积为目标，通常落在 128–512 KiB；过小的相邻范围会按固定顺序合并。每个块用自身 SHA-256 命名，manifest 保存有序首末 key、词条数、压缩／解压字节数与摘要。所有块完整落盘后才原子替换 manifest；孤立块不会被当作资源。

## 缓存生命周期

- resource-v3 不会在启动时导入 770,611 条记录，也不把整本词典放入内存。首次查词读取并校验 manifest，只从 DataAdapter 读取命中 key 范围的一块；Worker 负责该块的 SHA-256、解压和 JSONL 解析。Worker 不可用时，兼容路径会分批让出主线程；缺少 SHA-256 或 gzip 能力时失败关闭。
- 解码后的块保存在有数量和估算字节上限的 LRU 中，默认最多 16 块、8 MiB。并发查询命中同一范围时共用一次块读取和解码；代际变化会阻止旧任务返回旧词条。Dexie 不要求为 v3 建立整本查询索引。
- 如果 v3 尚未同步，只有先前已验证就绪的 v2 Dexie 缓存可作为兼容回退。冷 v2 资源会返回明确的 `DICTIONARY_CACHE_NOT_READY`，查词和启动流程都不会因此开始全量导入。

### resource-v2 本机缓存兼容

- v2 的显式缓存准备仍以 Worker 分批解压并事务写入 IndexedDB；Worker 不可用时使用主动让出主线程的兼容路径。
- 内容摘要及 schema 决定缓存代际。同一完整参考词典可在相同浏览器 origin 内复用，缓存不含 Vault 路径、学习状态或用户笔记。
- 单机多窗口通过事务租约与 fencing 协调建库；暂停的旧任务不能覆盖接管后的结果。中断任务可以从已确认的批次恢复。
- 所有记录和数量验证通过后，才发布 ready 与 active 指针；显式重建先写入替代缓存，验证成功后才切换。
- v3 已同步时不依赖 Dexie。资源升级期间的上一份完整 v2 cache 只作为 v3 manifest 缺失时的兼容读路径。

词典查询不会加入 LingQ 页面匹配、滚动或缩放流程。

## 验证

```sh
node --test --test-concurrency=1 tests/build-dictionary-resource.test.mjs tests/build-dictionary-resource-v3.test.mjs tests/dictionary-resource-v3.test.mjs tests/vocabulary-dictionary.test.mjs tests/dictionary-cache.test.mjs tests/dictionary-cache-browser.test.mjs tests/dictionary-host-state.test.mjs
```

resource-v2 的历史 Chromium 建库和查询数字不用于推断 v3 首次块读取性能。resource-v3 的五冷二十热对比、8／16／32 块 LRU 取舍，以及 Native Obsidian / WKWebView 体验仍需在获准的测试窗口中实测；当前文档不作性能承诺。

resource-v2 的 0.11.8 历史部署记录：在 Mac 正式库中，`on`、`mostly`、`subscription` 均返回释义，单词查询约 2.2–2.8 毫秒且压缩资源读取为 0 次。ECDICT 同步目录由 1,040 个文件／39,700,469 字节变为 3 个文件／16,736,295 字节；这不是 v3 性能数据。
