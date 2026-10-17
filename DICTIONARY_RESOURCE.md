# 词典资源与本机查询缓存

Vault 的词典资源是可同步的依据；Dexie 4 / IndexedDB 只保存本机可删除、可重建的查询缓存。个人学习记录仍保存在 `00_Archive/21_VocabularyData/en.vocab.json`，不进入词典缓存。

## 最终目录

```text
00_Archive/21_VocabularyData/dictionaries/ECDICT/
├── LICENSE-MIT.txt
└── resource-v2/
    ├── manifest.json
    └── entries.<SHA-256>.jsonl.gz
```

ECDICT 来源：[skywind3000/ECDICT](https://github.com/skywind3000/ECDICT)。分发时必须同时保留其 [MIT 许可证原文](https://github.com/skywind3000/ECDICT/blob/master/LICENSE)及版权声明；构建器只生成资源和清单，部署时将许可证放在上级目录。Dexie 4.4.6 使用 Apache-2.0，许可证随三文件插件的内嵌资源一起打包。

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

迁移前备份插件、个人词汇、词典与批注数据到 Vault 外。新旧格式逐条比较通过且新缓存可查询后，才把 `index-v1/` 和原始 `ecdict.csv.gz` 移出 Vault，保留库外回滚副本。所有设备应升级到支持 resource-v2 的插件；旧版插件不能查询新资源。回滚时恢复旧插件和相应的旧资源，不删除个人词汇。

## 缓存生命周期

- 首次开启 LingQ 时在后台验证压缩资源的 SHA-256；以 Worker 逐行解压、分批事务写入 IndexedDB，Worker 不可用时采用主动让出主线程的兼容路径。
- 内容摘要及 schema 决定缓存代际。同一完整参考词典可在相同浏览器 origin 内复用，缓存不含 Vault 路径、学习状态或用户笔记。
- 单机多窗口通过事务租约与 fencing 协调建库；暂停的旧任务不能覆盖接管后的结果。中断任务可以从已确认的批次恢复。
- 所有记录和数量验证通过后，才发布 ready 与 active 指针。建库进度与个人学习状态分开显示，未完成的缓存不能将缺失记录报告为“未收录”。
- 显式重建先写入本机替代缓存，验证成功后才切换，失败不会清空正在使用的完整缓存。
- 资源升级时继续使用上一份完整缓存；部分同步、摘要错误、配额不足或 IndexedDB 不可用会保留资源并显示可重试状态。
- 热查询只按 key 访问 IndexedDB；缺失记录通过本机小型 key 索引校验，不读 gzip、不扫描全词典。关闭 LingQ 不删除词典或个人记录；设置中的“重建缓存”只重建本机参考数据。
- 词典查询不会加入 LingQ 页面匹配、滚动或缩放流程。

## 验证

```sh
node --test --test-concurrency=1 tests/build-dictionary-resource.test.mjs tests/dictionary-cache.test.mjs tests/dictionary-cache-browser.test.mjs tests/dictionary-host-state.test.mjs
node tests/dictionary-resource-benchmark.mjs /path/to/ECDICT/resource-v2
```

首次建库与之后的查词是不同指标。770,611 条词典在本轮 Chromium 测试中首次建库约 89 秒，重载后首次查询约 21 毫秒，热查询中位数约 0.6 毫秒；这是测试环境实测，不是 iPad 性能承诺。移动端视口测试不等于真实 WKWebView 验收。
