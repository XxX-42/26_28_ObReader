# WAL-Sidecar v3.1 本地实施报告

## 基线与边界

- BASE_BRANCH: origin/integration/0.8.0-sidecar-merge-20261015
- BASE_SHA: 19d20f3e1721f34c4c69b70f427e457ebaa62cca
- 原工作区未提交改动保留；本实现使用独立、初始干净的检出。
- 分支：codex/wal-sidecar-v3-1。未推送、未部署、未清理旧数据、未操作用户库 PDF。
- 存储架构 v3.1，磁盘 schemaVersion 1；manifest 暂保留基线 0.8.0，仅作为本地开发候选，不能混称已发布升级包。

## 分阶段提交

1. 48a3a7d：确定性版本、身份、规范序列化与 Join。
2. 459f387：每设备 WAL、串行协调器、稀疏 Anchor 与压实。
3. fe5da16：Format 3 当前有效状态只读导入。
4. 5f34fb3：Reader 默认接入新持久化路径。
5. 5c93a76：路由缓存验证、身份冲突与序号碰撞保护。

## 模块与调用关系

`plugin/storage/version.cjs` 提供唯一比较器；`merge-engine.cjs` 和 `effective-state.cjs` 合并 Sidecar、所有有效 Anchor/Tail。`canonical.cjs` 与 `io.cjs` 验证规范字节、算法前缀完整性及 pending 写入恢复。

`document-identity.cjs` 使用初始规范路径和完整源哈希派生身份；`registry-cache.cjs` 仅缓存路由。`sidecar-store.cjs`、`wal-store.cjs` 验证文档、owner、版本、序号及完整性。`wal-writer-coordinator.cjs` 按 Adapter/device/doc 串行写入。`compactor.cjs` 根据完整 EffectiveState 保存本设备赢家，只在有 Durable Witness 时淘汰被支配贡献；watermark 不授权删除恢复贡献。

`format3-importer.cjs` 和旧 store 的最小只读导出接口负责一次性导入当前批注、墓碑、路由和精确嵌入引用，不携带旧历史/ACK/GC。旧文件不改写。已有新状态发生语义差异时不覆盖。切换前要求所有设备同步和升级；不支持旧版继续写入，也不自动将切换后迟到的分歧旧状态覆盖到新状态。

```text
Editor 操作 → AnnotationHost → WAL facade → 每设备每文档串行队列
→ 本设备 WAL → 验证读回 → 确认 revision

打开/同步 → 有效 Sidecar + 有效 WAL Anchor/Tail → Join → Reader 水合

空闲且无输入/保存/恢复 → 全量有效输入 → 稀疏 Anchor 维护 + Sidecar 物化
```

`plugin/pdf-annotation-host.cjs` 接入新 facade、同步失效和维护空闲握手；`plugin/main.js` 注册恢复身份命令；bridge 仅增加权威状态适配与维护探针，不改变指针交互。源 PDF 不写入；PDF.js vendor、依赖版本未修改。

路由更改作为 ROUTE_SET，不改文件名。路由缓存必须先验证；不同完整身份复用 docKey、同路径多个有效路由、复制歧义、来源不匹配均阻止不安全水合/写入。WAL owner、重复序号、同版本异内容以及进程内已观察序号回退受检查。失败/部分同步保留原数据，不生成空状态覆盖。

## 验证结果

- 精确基线：459 项，433 通过、26 失败。
- 最终完整默认并发：528 项，503 通过、25 失败；25 个失败名称全部已存在于精确基线，无新增失败名称。
- 最终定向：190/190；包含 67 项新 WAL 模型、持久化、迁移、主机、来源绑定、边界、集成和混沌测试。
- 旧基线失败包括 14 项旧 Format 3/检查点/GC/崩溃测试和 11 项浏览器断言或超时。11 项浏览器测试隔离运行仍失败，不能笼统称为并发或 Chrome 退出问题；未改断言掩盖，未继续扩展 teardown 调查。
- 构建通过；离线 smoke 日志单独保存。所有原始失败与对照记录在 evidence/wal-v3-1。
- 属性/故障覆盖：交换性、幂等、乱序/重复、多窗口、owner、部分 JSON、完整性损坏、Sidecar 回滚、路由丢失/重建、同路径复制、删除不复活、迁移重跑、稀疏 Anchor 淘汰。

完整套件尚非全绿，因此本候选不能称为完成全部产品验收。

## 性能证据的适用范围

`adapter-benchmark-reviewed.json` 使用 1,016,315 字节真实 fixture、100 KiB Ink 负载、10 次编辑/保存/读取及一次压实。120 是逻辑页面身份数量，不是实际 120 页 PDF。Windows/macOS/iPadOS 仅为同一个 Node 内存 Adapter 的变体标签，不是设备实测。该轮同时存在浏览器测试负载，保存均值分别约 58.5/121.1/101.1 ms，不应解释为平台速度比较。

三个标签的语义结果一致，源 PDF 前后 SHA-256 相同；压实前 WAL 约 1,034,103 字节，后约 108,980 字节，Sidecar 约 108,850 字节，tail 归零。不能用此结果宣称真实大 PDF/iPad 的性能或内存目标达成。

## 交付与剩余项

本地三文件 ZIP：dist/pdf-web-reader-wal-sidecar-v3.1-dev.zip。SHA-256 记录见 evidence/wal-v3-1/build-sha256.json；源码与报告保留在本地功能分支。

Windows、macOS、iPadOS 实机迁移、原生保存重开、WKWebView 和大文件内存/耗时仍待验收。这里的自动化平台标签不等于实机证据。旧数据继续保留，未提供自动清理承诺。独立审查修正了身份、源绑定、序号及 Anchor 保护问题；仍保留上述基线失败，不以审查替代实际验收。

## 后续：当前会话诊断优先级与原生补测

诊断导出原来按会话从旧到新遍历，导致历史内容耗尽 64 MB 预算后当前会话计数为零。`session-log.cjs` 现在先处理当前会话（最新分片优先），再处理最近的历史会话；单个分片内部仍保持原记录顺序，保留 cutoff、来源偏移和省略计数。不是保证所有当前记录无限容纳；当前会话自身超限时仍受容量约束且明确标记不完整。19 项日志测试及构建、离线 smoke 通过。

获用户后续明确授权后，在“远程仓库1”先完整备份外置数据，再对“原则”新增测试矩形。新批注确认保存并重开可见：146→147；正常擦除测试矩形后 147→146，原有 146 条批注及原有删除状态逐项不变，保留测试删除墓碑。三次关闭均返回新标签页，原 PDF SHA-256 不变。新增/删除两次 host 保存分别 1186.6/1204.4 ms；这是 Mac 上既有移动模拟环境，不是 iPad 实机数据。

诊断修复三文件已备份替换并在 Reader 全部关闭后重载。实际导出 62,957,239 字节，当前会话来源 offset=0、recordCount=5；历史仍因预算省略，complete=false 如实保留。用户书籍/日志详情只保留在本地部署备份目录，不加入仓库。

## 0.8.1 版本元数据

用户后续要求将 f161b84 推送功能分支并更新 main。远程 main 版本核对为 0.8.0，因此统一递增为 0.8.1；仅更新当前版本元数据、兼容表、打包断言和文档。历史测试数据仍对应其原版本，不改称 0.8.1 实测。重新构建及包装/诊断定向回归 23/23 通过。先前 25 项基线失败及实机验收限制仍保留。
