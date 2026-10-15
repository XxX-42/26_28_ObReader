# 0.8.0 Storage + Candidate integration — BLOCKED at cross-instance safety (2026-10-15)

Integration branch: `integration/0.8.0-sidecar-merge-20261015`, based on Storage 0.8.0 commit `8e930695829b734c23e5d3a4f295d71de98437f4`. This entry records the controlled semantic merge attempt; it does not replace the frozen 0.8.0 results or earlier failure history below.

### Verified before the stop

- Build passed: release directory contains the three required files; 406 embedded runtime assets and 402 frozen vendor files validate. The exact #22137 backport is recorded in `vendor/pdfjs-generic-legacy/PROVENANCE.md`; frozen `viewer.mjs` SHA-256 is `6b370bd3426196ae5bfa855ee24979cf9939720b9edc0771137a4e32f1fa74ac`.
- Gate A targeted Store/Host/Bridge/session-log tests passed **71/71**; sidecar `plugin-host.test.mjs` passed **60/60** after replacing stale PDF-binary-writeback assertions with the Candidate sidecar protocol oracle. Native selection probe, pointer-capture, PDF.js backport, hydration-race, FreeText geometry/hydration, and multiline Highlight tests passed **10/10** in their browser/unit harnesses.
- Selection differential U0/U1/U2 passed, including the collapsed-caret case and two live PDFViewer instances sharing a document/module. `ISSUE_22129_RELEVANCE = NOT_REPRODUCED`. Evidence: `tests/artifacts/selection-differential-1792038488722-37728.json`.
- Source-binding matrix passed **7/7**. Controlled-close/transition tests passed **11/11**; the complete sidecar host lifecycle suite passed **60/60**.
- Obsidian Native 0.8.0 created and saved real single-line, adjacent, and multiline Underlines with non-collapsed pre-consumer selections; the first run reached the final three-Underline reopen and recorded a visible composite screenshot. Subsequent runs were interrupted by Obsidian CLI `ENOBUFS`/`ETIMEDOUT` while exporting the trace/reopening, so the required complete native trace and safety counters were not captured. Each run's fixture PDF SHA-256 and XXH64 were unchanged. A comparison against the initial test-vault inventory found **0 changes among 261 pre-existing sidecar files**. This is partial evidence, not Native acceptance.

### Blocking cross-instance result

The two-store tests use distinct Store instances and adapter facades over one shared durable backing map. In `tests/artifacts/store-cross-instance-race-stale-replay-overwrite-2026-10-15T044413369Z-31268.json`, Store B wrote checkpoint revision 1 with `annotation-B-new` and acknowledged that checkpoint; the active B device state recorded `acknowledged: true`. Resuming Store A's stale revision-0 replay then replaced the primary checkpoint with the prior empty revision-0 hash. B's immutable batch remained present, so permanent loss was not demonstrated in this interleaving; however, the forbidden stale-primary regression was directly reproduced. Per the integration gate, this is a P0 failure and work stopped without attempting a protocol rewrite.

The combined cross-instance/checkpoint/GC/crash run reported **21 tests: 7 passed, 14 failed**. Several other red assertions expect Candidate's older backup/GC behavior (for example, a latest-copy backup rather than 0.8's previous-distinct-checkpoint rule or collection without satisfying 0.8's 30-day/ACK gate); they require a separate 0.8-aware oracle review. Crash recovery at those boundaries is therefore not accepted. Full `npm test`, `npm run test:offline`, and P1 scheduling/coalescing were **NOT RUN after this P0 stop**. P1 was not started.

### Candidate package and final gates

The 0.8.0 build was installed only in the designated test vault `D:\\Documents\\Obsidian\\测试插件`, after backing up its previous plugin directory to `.deploy-backups/2026-10-15T04-32-05-861Z/pdf-web-reader`; the runtime was verified as 0.8.0. No remote repository-1 plugin or PDF was touched. Built release SHA-256:

| File | SHA-256 |
|---|---|
| `main.js` | `4866b85d24309fad4c05b2b45a174fd887a3d23f866041df4ebae1172923102e` |
| `manifest.json` | `0d66c1af2050da9a0212a8ca072d2a888864577f97179b794da2feb37321f625` |
| `styles.css` | `9dd5d3a26025cb83a7f68d63293fde69aec3bfbc7e9a5367f377853e11463650` |

```text
FORMAT3_STORAGE_PRESERVED = TRUE
LIVE_EDITOR_CAPTURE_PRESERVED = TRUE
EXACT_DURABLE_ACK_PRESERVED = TRUE
CONTROLLED_CLOSE_ACCEPTED = TRUE
P0_UNDERLINE = FALSE
P0_FREETEXT = FALSE
P0_SOURCE_BINDING = TRUE
P0_CROSS_DEVICE_SAFETY = FALSE
P1_MATERIALIZATION_COALESCING = NOT_RUN
ROOT_INDEX_GLOBAL_BARRIER = KNOWN_LIMITATION
SIDECAR_ARCHITECTURE_ACCEPTED = FALSE
READY_FOR_DEPLOYMENT = FALSE
```

No Git push, Release, or deployment to `远程仓库1` was performed. No user PDF or any of the 261 sidecar files present before Native testing changed. The test-vault plugin remains at 0.8.0 for investigation; Readers were left closed.

---

# 0.1general 通用候选（插件 0.8.0）

## 当前：外置批注历史、检查点与安全回收（2026-10-15）

0.8.0 保持不可变设备操作批次为历史事实来源，检查点为可重建快照。存储格式独立于插件版本：格式 2 在迁移期继续读写；只有所有已知且未退役设备确认同一个有效检查点并报告格式 3 能力后，才切换到带 checkpoint/parent 引用的格式 3。迟到的格式 2 批次仍可导入，不会降级格式。

`.previous.json` 只保留上一份不同且校验通过的检查点；状态不变时不轮换。缺失检查点、父批次、部分到达的 JSON 或设备 ACK 时，重放停在最后已验证快照并保持只读。迟到的已退役设备写入会隔离、提示恢复，不静默应用。

批次回收必须同时满足：所有未退役设备确认当前检查点；至少经过所有这些确认后的 30 天；当前与上一检查点都有效且不同；待删除批次的摘要被两个检查点一致覆盖。回收只删除两份检查点均已覆盖的批次，因此 `.previous.json` 与其后的增量仍能恢复当前状态。旧恢复副本不改写。

实现细节见 [ANNOTATION_STORE.md](ANNOTATION_STORE.md)。Obsidian CLI 的 Sync 历史命令仅作人工查看／恢复，不参与插件逻辑或回收决策；须先在实际 Vault 验证 JSON 侧车确实进入 Sync 历史。Sync 附件历史为两周，不能替代本地检查点与操作保留。

### 本轮验证

- `tests/pdf-annotation-store.test.mjs`：**29/29 通过**；存储、宿主、桥接、打包定向集合 **55/55 通过**。另以宿主测试确认缺失检查点到达后自动重放，Reader 从只读恢复编辑。覆盖不同状态的 `.previous` 轮换、30 天窗口、设备 ACK 屏障、格式 2/3 迁移、并发分支、缺失检查点／父批次和部分同步只读暂停、迟到旧设备写入及损坏 `.previous` 阻止回收。
- 双设备内存迁移样本从格式 2 切换到格式 3：迁移前 **7 文件／2,773 字节**，迁移后 **9 文件／4,097 字节**，增加 **2 文件／1,324 字节**。这是一个批次的受控适配器样本，不是实际 Vault 的存储增长预测。
- 最终构建通过：发布目录恰含 `main.js`、`manifest.json`、`styles.css`；嵌入 **406** 个运行时资源并校验 **402** 个冻结 Viewer 文件。三文件候选为 [`0.8.0 ZIP`](dist/pdf-web-reader-0.1general-0.8.0-candidate.zip)，SHA-256：`46efd92308312f3ab9f461e7858e16553b6a404b4923e526e45bbd7cd7add62f`。`npm run test:offline` 通过，覆盖打开、1–5 工具、桥接验证、外置批注保存／重开；浏览器正常退出。
- 最终完整 `npm test` 为 **366/405 通过、39 项失败**。其中 28 项 `plugin-host.test.mjs` 仍断言旧 PDF 二进制保存／恢复接口；另外 11 项分布在浏览器交互、自动保存、工具栏、测试清理、打开生命周期、同步桥接和下划线几何用例，包含等待超时。原始日志保存在 [`tests/artifacts/0.8.0-full-suite-20261015-final.log`](tests/artifacts/0.8.0-full-suite-20261015-final.log)。这些失败不计为通过；本轮存储定向断言和最终三文件离线 smoke 单独通过。
- 目前只有自动化与 Vault 适配器证据，没有新的 Windows、macOS Obsidian 或 iPad 实机证据。本轮仅准备测试分支候选；不推送、不部署、不创建 Release。

---

# 历史记录：0.1general 通用候选（插件 0.7.1）

## 诊断体积上限与批注操作确认链路（2026-10-15）

0.7.1 limits a diagnostics export to **19,990,000 UTF-8 bytes**. High-volume
pointer and low-priority log records are sampled/omitted under that cap; JSON
reports raw, retained, filtered, and size-omitted record counts. It also captures
committed live PDF.js editors at save, recovery, and sync-checkpoint boundaries,
so a stale `AnnotationStorage` snapshot no longer drops the latest committed
Pencil/Ink edit. A dirty operation is cleared only after the host confirms the
exact operation count and durable batch ID. The payload completeness guard
remains active and rejects incomplete snapshots.

### 本轮验证

- 定向快照、ACK、诊断导出、宿主外置保存、移动诊断及打包测试 **53/53 通过**。压力测试把 22,000 条约 1 KB 的计时记录送入默认导出器，最终 JSON 为有效 UTF-8 JSON 且不超过 **19,990,000 字节**；省略数量写入 `runtimeLog`。
- `npm run test:offline` 通过：真实浏览器打开 PDF、创建五种批注、保存到外置操作记录、关闭并重开后恢复批注；测试结束时浏览器正常退出。首次离线运行的失败记录保留在 `tests/artifacts/mac-offline-reopen-timeout-1792024109668-10441-f1e67ce2-cec4-4698-8911-729fadd4f26e.json`；原因是测试夹具仍发送旧式 `saved` 回执，缺少 `external`、`operationCount` 与 `batchId`。夹具已按生产宿主协议修正，应用仍拒绝不完整 ACK。
- 更新后的完整 `npm test` 为 **345/395 通过、50 项失败**，原始输出保留在 `tests/artifacts/0.7.1-full-suite-20261015.log`。大量 `plugin-host.test.mjs` 仍调用 0.6.0 前的二进制写回接口；另有浏览器用例超时。`sync-bridge-regression` 失败时工具按钮仍禁用、宿主尚未完成来源身份确认，因此未到达编辑保存断言。此项不能算作已验证。设备端验收仍未完成。

离线 smoke 证明的范围仅为桌面 Chrome 的外置操作保存／重开；它不替代实体 iPad 和 Obsidian 内的实机验证。

---

# 历史记录：0.1general 通用候选（插件 0.6.0）

## 当前：只读 PDF 与外置批注操作日志（2026-10-15）

0.6.0 将日常自动保存、手动保存、关闭恢复和跨端合并从 PDF 二进制写回切换为 `00_Archive/20_PDFData` 下的不可变设备操作批次。JSON 快照由操作日志重放生成，只作缓存；批注采用 UUID、逻辑时钟、设备／操作 ID 的确定性 LWW，删除墓碑持续保留。正常保存不调用 PDF.js `saveDocument()`，也不调用 PDF 源文件写入 API。PDF.js 二进制序列化只保留在用户显式执行“导出为独立 PDF”时，结果作为新文件创建。

### 已完成验证

- 构建 **406** 个运行时资源，逐项核验 **402** 个冻结 Viewer 文件，发布目录仅含 `main.js`、`manifest.json`、`styles.css`；三端统一 0.6.0，`isDesktopOnly: false`。资源、构建产物和 vendor 哈希仍为 SHA-256；PDF 来源与恢复状态使用算法标记哈希并兼容旧 SHA-256 记录。
- 定向测试 **63/63 通过**：外置日志存储、跨设备 LWW、乱序／重复操作、删除墓碑、rename/copy 身份、源文件变化阻断、哈希兼容、移动无 Node 启动、移动 Blob fallback、关闭与保存不调用 PDF 序列化／源写 API。
- 离线真实浏览器 smoke 通过且 Chrome 正常退出：五种工具写入外置操作记录，重开后可见；二次编辑 Square、删除 Underline 并保存重开；源 PDF 未作为保存目标。
- 无 Node 浏览器保存回归两种加载模式均通过，并记录了测试 PDF 保存前后的 SHA-256 与 XXH64 完全一致，`sourcePdfWrites: 0`。报告：`tests/artifacts/mobile-browser-startup-1792003084048.json`、`tests/artifacts/mobile-browser-startup-1792003066482.json`。这些是浏览器／模拟验收，不是实体 iPad 或 Windows 实机验收。
- 只读独立审计未发现 P0/P1。审计报告指出的迁移与设备识别限制列在下方。

### 完整套件结果与限制

本轮完整 `npm test` 有失败项，原始输出保存在 `tests/artifacts/0.6.0-full-suite-20261015.log`；因此不宣称全套通过。新架构定向测试与离线 smoke 通过。遗留的 PDF 原位写回协议测试仍需按外置操作日志协议迁移；其他浏览器交互失败须结合各自失败证据逐项确认，不因定向通过而标为已解决。Chrome teardown 不作扩展调查。

完整运行统计为 **380 项、330 通过、50 失败**。其中 `plugin-host.test.mjs` 有 40 项仍依赖被替换的 `pdfSync`／二进制恢复接口；其余 10 项分布在自动保存、工具交互、窄工具栏、鼠标／手势、打开生命周期和同步桥接等旧浏览器 harness 中，包含等待超时。它们保留在原始日志和各自失败证据中，不能用定向通过覆盖。该完整运行发生在最终按钮文案调整之前；最终三文件上的离线 smoke 已重新通过。

当前尚未完成 120 页／16.85 MB 连续保存耗时、落盘字节与内存峰值基准；不宣称达到 10 ms 保存或 70% 内存下降目标。未完成实体 iPad、macOS Obsidian 和 Windows 实机验收，也未验证两个真实同步客户端的离线重连场景。

- 首次迁移只确认旧批注 UUID 与 PDF 对象引用；存活批注完整编辑器 payload 采用首次实际编辑时的精确引用懒迁移。无法验证旧身份的带标记 PDF 只读打开，不按坐标猜测。
- `documentId` 当前为 Vault 相对路径派生的 UUID 形 ID，并存入可同步索引；这样同一路径首次在两台离线设备同时打开时仍得到一致身份。它不是随机 UUID；rename 由路径索引事件保留身份，新路径副本得到新身份。
- 浏览器端到端水合目前覆盖矩形批注的可见重开、编辑和删除；离线 smoke 另覆盖五种批注类型，但不代表对所有外部 PDF 原生批注组合和 InkHighlight 画面外观的完整实机验收。第三方 PDF 批注保持在只读底本中。
- 浏览器无法提供稳定设备 localStorage 时，设备 ID 回退为会话 ID，跨重启稳定性需宿主持久设置验证。
- 保存前通过源文件对象、路径、大小／mtime 检查；Vault modify 事件执行全量内容哈希。若平台同时漏掉修改事件且同一文件对象的大小与 mtime 未变，写操作批次可能先被接受，但新打开时全量哈希不符会阻止批注水合。该同步通知边界仍需多端实测。
- 外置批注在系统预览、Acrobat 等外部阅读器中不会显示；显式导出会生成单独 PDF，不修改底本。旧二进制 `.recovery` 保留原样，0.6.0 不生成新的二进制 PDF 恢复包，也不清理或压缩历史日志。

最终包为 [0.6.0 三文件候选 ZIP](dist/pdf-web-reader-0.1general-0.6.0-candidate.zip)，SHA-256 `460aefee72a88f19c48c682de0a5d7e1e018e20534ef92fd7a25edebb9636c92`；清单在 `dist/pdf-web-reader-0.1general-0.6.0-checksums.sha256`。归档结构校验确认只含三个安装文件。完整源码差异：[0.6.0 source patch](dist/general-0.1general-0.6.0-source.patch)，其哈希见 [patch checksum](dist/general-0.1general-0.6.0-source.patch.sha256)。仅独立测试环境使用；不推送、不部署、不创建 Release，不操作主库 PDF。

---

# 0.1general 通用候选（插件 0.5.20）

## 当前：0.5.20 保存阶段计时

0.5.20 为每个保存事务增加宿主阶段耗时汇总：队列与重活锁等待、恢复副本、源文件修订检查、Worker 准备、磁盘读取与比较、增量写入或完整写入、写后读回与校验、检查点确认及恢复副本清理。字段位于 `PdfSyncHost.save` 性能记录的 `hostStagesMs`／`hostStageCounts`，并通过 `saveTransactionId` 与 Worker 阶段关联。本版本仅补充测量代码，不包含新的 iPad 实测，也不宣称保存变快。

---

## 历史记录：0.5.19 修复大账本解码溢出与 Ink 绘制状态

## 当前：0.5.19 修复大账本解码溢出与 Ink 绘制状态（2026-10-14）

最新的 0.5.18 iPad JSON 将栈溢出定位到 Reader 打开后的 `PdfMergeClient.inspect → inspectDocument → catalogLedger`。`catalogLedger` 对 PDF.js 写入的 UTF-16 merge ledger 调用 pdf-lib 的 `decodeText()`；pdf-lib 将所有字符一次性传给 `String.fromCodePoint.apply`，ledger 较大时超过 JavaScript 参数上限并抛出 `RangeError`。`initializeView` 捕获后禁用该文档的同步，后续保存在 `prepare()` 入口失败，没有发送 Worker 请求。

0.5.19 将 PDF 字符串解码改为有界 UTF-16／PDFDocEncoding 分块，避免大 ledger 的栈溢出，同时保留原编码语义。另修复 PDF.js `DrawingEditor` 的笔迹会话清理：废弃旧的绘制监听、校验当前 controller／draw 状态，并为收尾路径加空状态保护。该 Viewer 修正只改 `build/pdf.mjs`，并更新运行时 Bundle ID 与冻结文件哈希。新增大 ledger 回归，以及防止旧 Ink pointer listener 再访问空 draw 状态的源码回归。

0.5.18 JSON 中还记录到 4 次 `DrawingEditor.#currentDraw.isCancellable` 空值错误，与画笔问题吻合；同一会话的荧光笔交互没有出现同类错误。4 次失败保存均在 Worker 请求前中止，没有写回确认；诊断记录恢复副本流程完成，旧恢复副本保留。0.5.19 本地构建通过（406 项运行时资源），103 项保存／合并／恢复／关闭／绘制回归通过，离线浏览器验收也成功创建五类批注并完成保存重开。[三文件候选 ZIP](dist/pdf-web-reader-0.1general-0.5.19-candidate.zip) 仅含 `main.js`、`manifest.json`、`styles.css`，SHA-256：`691207690559913a9d39d7a4ac53c0fd8b9383d53f5a2751392e5e044da684bb`；`main.js` SHA-256：`ec00180c1f098394b1bb29813d9a1ee57d610e4385ba76c251a8b806c7845905`。仍需 iPad 实机复验画笔、多笔连续输入、荧光笔和保存重开；此版本尚未部署或推送。

0.5.18 的 Worker 原始异常名、代码、方法、阶段、堆栈及栈溢出上下文诊断仍然保留。

---

# 0.1general 通用候选（插件 0.5.17）

## 当前：0.5.17 普通保存移除全页指纹扫描（2026-10-14）

### 已确认调用链与根因

打开阶段：`PdfReaderView.sendPendingDocument → pdfSync.initializeView → PdfMergeClient.inspect → inspectDocument`。此前无账本旧 PDF 在 `inspectDocument` 中直接遍历全部页面调用 `getPageFingerprint`。现在旧文档快速打开只收集页数、快速页面身份和批注引用，生成 `session-` 临时批注身份；不生成页面内容指纹或迁移写入。

保存阶段：Viewer `saveDocument → PdfReaderView.onMessage("save") → saveFile → pdfSync.save → enqueueSave → prepare → PdfMergeClient.prepareLocal → checkpoint/patch merge`。此前 `prepareLocal` 会扫描 baseline；随后宿主为已确认 checkpoint 与新 draft 做三方整理时，`merge → inspectDocument` 又会全页扫描，这是原来未从普通保存热路径移除的第二处扫描。现在分别保留当前 PDF.js Viewer 的不可变 source baseline 和 Vault 最新已确认 checkpoint token；三方合并也可复用 source baseline 指纹，但必须验证 revision token、有序页面身份和 ledger。缓存只存 revision、页身份及指纹结果，不保留额外 PDF 字节副本。

### 新路径

- **普通打开：** 有效 ledger 可按页面身份复用指纹；无账本 PDF 不执行全页内容指纹。
- **普通保存：** 先用文件大小／mtime 对比及组合 revision token 分流，再由宿主保留的精确磁盘字节比较做最终写入授权。可信 baseline revision 与有序页面身份匹配时，baseline 指纹页数为 0；draft 只对被操作记录标记的 dirty pages 逐页校验，其余页面复用可信基线指纹。
- **普通三方整理：** baseline token、序列化页身份及内嵌 ledger 均匹配时，base、local、remote 分支复用同一份已验证页面指纹；有序身份或 ledger 不匹配时转入完整指纹回退。外部文件变化由精确字节比较触发回退，不能依靠 mtime 单独批准写入。
- **首次旧 PDF 写回：** 允许一次 baseline 全页指纹以维持旧 `documentId`、UUID 与批注历史兼容。仅按对象引用、页码、批注类型唯一映射 `session-` 身份；无法唯一确认则安全失败并留恢复副本。
- **完整回退：** 页数／有序身份变化、revision mismatch、dirty 状态缺失或不可信、缓存失效、同步／恢复和旧账本无法确认时，执行原有完整指纹与合并校验；不能覆盖外部变化。
- **缓存失效：** 同步应用更新基线；文件改名、外部 revision 不匹配、最后一个 Reader 关闭和未确认重启状态会丢弃内存缓存。PDF 内现有账本仅在其有序页面身份与当前解析结果匹配时复用。

每次逻辑保存有 `saveTransactionId`，JSON 只记录阶段耗时与计数，不含 PDF 内容。新增 `fingerprint.mode/reason`、baseline/draft 指纹页数、dirty 页面／批注数量、revision token、PDF 解析、批注索引／整理、增量输出、Worker 往返和保存总时长。

### 测试状态与性能限制

核心、宿主、Worker 和 bridge 定向回归 **99/99 通过**；离线启动及五工具保存重开 smoke test 通过。A–F 覆盖中：186 页旧 PDF 首次实际保存扫描 186 页、第二次 baseline 为 0 且单页 draft 为 1；186 页第 17 页单批注编辑只检查该 dirty 页；外部 revision mismatch 强制完整回退；同页数重排失败关闭；对象引用重写进入完整指纹回退；最后一个 Reader 释放 transient cache，重启不复用不可信内存状态。另有三方合并快路径回归，可信有序页面身份命中时 base/draft/remote 指纹页数均为 0；无缓存控制组仍走 FULL 回退。

指定独立库 `/Users/jiajia/Documents/ObReader-Apple-Test` 中，以 120 页、16.85 MB 的合成文本 PDF（含 16 MiB 不可压缩附件）各执行 10 次连续编辑、保存、关闭重开和批注可见性检查。桌面：`prepareLocal` 均值 **941 ms**、中位数 **855 ms**、P90 **1,132 ms**、最大 **1,487 ms**；整笔保存均值 **6,236 ms**、中位数 **6,205 ms**、P90 **7,136 ms**、最大 **7,172 ms**。移动模拟：`prepareLocal` 均值 **792 ms**、中位数 **727 ms**、P90 **942 ms**、最大 **1,110 ms**；整笔保存均值 **5,382 ms**、中位数 **5,305 ms**、P90 **5,931 ms**、最大 **6,580 ms**。两组第 1 次旧 PDF 兼容迁移扫描 120 页；第 2–10 次均为 baseline **0 页**、draft **1 页**，`prepareLocal` 的 P50/P90 通过 `<1.5s / <2.0s` 门槛。桌面 10 个批注和移动模拟 10 个批注均保存、重开后可见。

这不是实体 iPad 实测，合成附件也不代表扫描型 PDF 的渲染负载。渲染器峰值 JS heap：桌面 **82.1 MB**、移动模拟 **93.5 MB**；测得 JS 与 backing storage 峰值分别为 **645 MB**、**638 MB**，不包含原生、GPU、canvas 等全部内存。没有同一 fixture 的旧版内存基线，故不宣称内存已减少。整笔保存仍约 5–6 秒，指纹热路径移除后仍有写回、恢复验证和大文件 I/O 成本；本轮没有将目标扩大为完整保存链路优化。0.5.15 的 7.07 秒旧诊断是不同设备／文档与版本，只作历史背景，不作为严格前后对照。

一次完整默认并发套件 **339 项：336 通过、3 失败**，原始输出保存在 `tests/artifacts/0.5.17-final-default-test-20261014-1115.log`。iOS 自动保存测试的产品流程到达浏览器清理，但受管 Chrome 子进程退出码 2；自动保存设置断言在并发套件中读到 `auto` 而非预期 `manual`，单独运行 `tests/autosave-regression.test.mjs` 后 **1/1 通过**；iPad 指针策略测试在合成事件时间戳校验失败，单独运行仍因事件时间戳超出 harness 窗口而失败。相关证据均保留；不把后三项改写成全套通过，也不把指针测试失败归因于本次指纹改动。

这次完整默认运行后只调整了三方合并诊断字段，使 `fallbackTriggered` 仅代表确实计算了完整指纹。最终构建随后再次通过 99/99 定向回归、两次真实桌面保存验证和离线 smoke；339 项的默认套件结果仍如上记录，没有用后续定向测试覆盖它。

桌面数据和完整事务列表：`tests/artifacts/general-0.5.17-desktop-benchmark-mergefix-1791947208916-timing-analysis.json`；原始桌面基准：`tests/artifacts/general-0.5.17-desktop-benchmark-mergefix-1791947208916.json`。移动模拟完整报告：`tests/artifacts/general-0.5.17-mobile-benchmark-mergefast-1791947366245.json`。先前坐标越界失败报告及测试 PDF／恢复证据仍保留，未被后续成功运行覆盖。

最终诊断字段重建后另做桌面两次保存确认：首保存执行一次 120 页兼容迁移；第二次 baseline=0、draft=1，`fingerprint.mode=PARTIAL` 且 `fallbackTriggered=false`，保存重开验证通过。证据：`tests/artifacts/general-0.5.17-desktop-benchmark-final-check-1791947980208.json`。最终 bundle 再通过离线 viewer、五工具及保存重开 smoke test。

[0.5.17 三文件测试候选](dist/pdf-web-reader-0.1general-0.5.17-candidate.zip)；最终 ZIP 与测试库文件 SHA-256 在 `tests/artifacts/0.5.17-candidate-checksums-final.json`。只部署在指定独立测试库；没有推送、发布、主库部署或主库 PDF 操作。0.5.16 代码及此前 0.5.15 JSON 历史基线保留。

---

# 0.1general 通用候选（插件 0.5.16）

## 当前：0.5.16 页面结构快速校验（2026-10-14）

合并前先比较页数；基线、草稿或本地检查点页数不同即暂停自动合并。页数相同时比较有序页面身份（页面对象引用、内容流引用及页面几何）。首次遇到旧 PDF、身份缺失／不一致或结构无法快速确认时，回退到完整规范化页面指纹。成功写入的 PDF ledger 保存有序页面身份和已验证指纹；后续身份仍匹配时可复用指纹，批注变化不再重复遍历并哈希页面内容流。页面身份缓存仅跳过页面级内容哈希，批注身份、页码、类型、删除墓碑、冲突与写回校验仍照常执行。

分阶段 JSON 继续记录页数／身份预检、指纹耗时、缓存命中来源、批注索引与扫描、合并及 Worker 传输。该快速路径针对用户指定的页面增删／重排与批注编辑；未能由身份可靠确认的文件仍走完整指纹验证。

### 当前在用版本：0.5.15 保存链路分阶段计时

## 当前：0.5.15 保存链路分阶段计时（2026-10-14）

保存诊断 JSON 会为 `prepareLocal` 记录 PDF 解析、页面指纹、批注索引与身份检查的分项／累计耗时、批注操作整理、增量输出生成，以及 Worker 排队、执行和消息往返耗时。阶段计时只包含耗时和结果状态，不记录 PDF 字节、文本、路径或批注内容。当前按设备收集真实 PDF 数据；不把桌面计时当作 iPad 结论。

### 当前在用版本：0.5.14 删除批注草稿的合并校验顺序（2026-10-14）


## 当前：0.5.14 删除批注草稿的合并校验顺序（2026-10-14）

三端统一 0.5.14，Luna Max 开发与独立审计。新的 iPad 0.5.13 JSON 原件已复制并校验，失败证据目录 `tests/artifacts/missing-annotation-20261014T000305Z/`；本地保留原件，不将包含业务路径的用户 JSON 放入候选包／源码差异。导出保留 167,648 条、丢失 124,347 条、`complete:false`，不称完整无缺失。UUID `07423b70-89a4-436b-8050-e02887547825` 在三个 prepareLocal 调用中报缺失且无删除记录，之后保存继续被拒绝；日志没有记录草稿／基线字节或删除操作 payload，不能据此断言用户这条批注确实被合法删除。

真实合成 PDF 重现一个对应产品缺陷：PDF.js 删除 `/Annots` 中已有批注，但草稿仍继承旧 live ledger；prepareLocal 在读取精确删除操作之前严格 inspect 草稿，提前抛同一 missing-tombstone。修复只对当前草稿、已证明的同 UUID／已知对象引用／页／类型与有效删除时钟放行，随后正常持久写入删除记录；基线、检查点、公共 inspect 和无法解释的缺失继续严格拒绝。不删除或绕过安全检查，不从坐标／文字推测身份，不覆盖主库 PDF。

原生复验还确认已保存批注删除后撤销的追踪缺陷：恢复到未改动的原批注时，PDF.js `serialize()` 为 null、修改列表为空；桥接层仍留删除操作，下一次写回被“删除操作但 PDF 仍有批注”拒绝。修复限定已知保存身份及实际恢复编辑器，补记恢复 upsert，保持后续快照稳定；不猜测批注位置，不将所有未修改批注标为新编辑。

合并回归进一步修复“恢复到原始内容却带更新操作”的判定：chooseState 只有内容和完整操作时钟都与基线相同才视为未变化；同内容的新 upsert 正常参与 LWW，较新的恢复可战胜旧删除。原生失败实际 Worker 三组 PDF 字节重放由 deleted=true 改为同 UUID 的 live upsert；交换两分支方向也通过。

### 最终验证与交付

- Core 单项 **30/30**；最终保存／恢复组合 **147** 项、**146** 通过，浏览器桥接单项在绘制工具前置等待超时，不称该单次通过；同一最终冻结默认全套中的桥接用例通过（包含 null-serialize 撤销恢复、重复 checkpoint、保存确认后重做和再次恢复）。
- 指定独立库移动模拟通过真实菜单删除、顶部撤销／重做、三次保存及关闭重开；选中初始唯一批注使用 PDF.js 选择 API，未将早期真实鼠标选择失败称通过。三次磁盘同 UUID 状态为 deleted／live／deleted，重开 **0** 条，结束 desktop、Reader **0**。证据 `tests/artifacts/general-0.5.14-saved-delete-1791938138570.json`。原版 0.5.13 删除保存的实际 missing-tombstone、两次选择前置失败、中间 0.5.14 撤销失败及重开脚本返回非可序列化对象的前置错误全部保留；只有最后完整运行称通过。
- 最终默认并发 **329** 项、**324** 通过、**5** 失败、退出 **1**：三项完成产品断言后 Chrome 退出 code 2；指针第21次注入迟于 80ms 前置；鼠标工具栏用例 show 调用计数 2 对 1 不符，但最终浮层可见、焦点位于工具栏、文本正确。不称全套全绿，不追加 teardown 调查或重复门槛。中间构建默认轮次另存，不能代替最终冻结结果。
- 最终离线打开、五工具、快捷键、消息核验、保存重开通过，Chrome 正常退出 **0**。构建验证 **406** 资源、**402** 冻结 vendor 文件，仅三文件；依赖／冻结 Viewer 不变，`git diff --check` 通过。Luna Max 独立审计无剩余 P0/P1。实际 Mac 测试 Obsidian 1.12.7，实体 iPad／Windows 复验仍待用户，不将移动模拟等同实机。

[0.5.14 三文件候选](dist/pdf-web-reader-0.1general-0.5.14-candidate.zip)；源码差异、证据、哈希和安装说明在 `dist/general-0.1general-0.5.14-*`。保留 0.5.13 回滚。主库仅归档日志／恢复证据和另行授权的三文件替换，不操作原 PDF，不清理旧恢复副本、不公开 Release／推送。

Mac 端 `.recovery` 当前只有两份旧文件，已原样归档并校验；新的 iPad 恢复文件尚未同步可见。修复不清空旧候选、journal、缓存或设置。若现有磁盘 PDF 本身已有不一致 ledger，仍需用实际恢复字节和操作证据处理，本次不会自动猜测修复原 PDF。关闭后后台写回、串行保存、跨端合并及可恢复失败策略不变。

## 前一版：0.5.13 持久恢复后关闭、后台 PDF 写回（2026-10-14）

三端统一版本；Luna Max 开发及独立审计。关闭时先提交当前文字／笔迹操作，等待 PDF.js 序列化完成，将精确最新修订的恢复副本和后台意图写盘并读回校验；确认后关闭标签，不再等原 PDF 的合并、写入和读回。关闭后任务由插件持有，不引用已销毁的 Reader／iframe／窗口。通知和状态项显示实际阶段，不伪造百分比；自动保存关闭或冲突暂停时只保留恢复副本。

后台继续复用跨端合并、文档／修订身份、串行写入及调用前磁盘核对。磁盘再次变化会重新合并；同一会话后续修订有序处理，独立会话不互相丢弃。重新打开会等待对应任务及打开确认，防止读到旧版本。调用后结果不确定时停止自动重试并保留恢复。不可变 rawmeta 支持意图 JSON 中断恢复，已确认 saved 标记不会重新激活。后台完成且无已打开 Reader 时释放完整 PDF 基线及同步内存；磁盘恢复／journal 仍保留。

### 验证与边界

- 源码保存／恢复／关闭回归 **116/116**。真实 PDF 回归在第一次合并后再次更改磁盘，最终本地与两批远端批注全部保留，只调用一次源文件写入，原恢复段不变。
- 原生独立库六项通过：桌面与移动模拟各覆盖新编辑关闭、旧保存尚在写入时继续编辑并关闭、后台写入失败。真实关闭按钮在源写入门保持阻塞时移除标签，耗时 **56–82 ms**（小型合成 PDF，仅为该环境测量）；恢复副本验证 **1／2** 条批注，成功后重开一致，失败后原 PDF 未变、副本仍可恢复且显示暂停。关闭后 PDF 基线缓存已释放；结束恢复 desktop、Reader 为 **0**。证据 `tests/artifacts/general-0.5.13-background-close-1791928999799.json`。
- 原版 0.5.12 在相同写入门下关闭超过 20 秒仍被阻塞，原始失败保留。首轮 0.5.13 桌面新编辑关闭约 62 ms 通过；第二场景因脚本将宿主最后已知修订当成实时 Viewer 修订停止，修正为实际批注与 close-prepared 后六项通过。安装时一次 CDP enable 等待超时，但只读核对实例版本与产物一致后继续；不重标为产品成功或丢弃证据。

- 冻结默认并发 **323** 项，**319** 通过、**4** 失败、退出 **1**。移动自动保存完成功能断言，仅 Chrome 子进程退出 code 2；桌面自动保存 fixture 仍要求原写入 ACK 后关闭，默认路由 mock 缺 `adapter.exists` 导致新恢复扫描失败，两项按新协议／实际 Adapter 前置单独修正；桌面自动保存单项复验 **1/1** 完成全部功能断言并正常退出，默认路由单项 **4/4** 通过。指针用例在最后工具切换前未确认批注工具已启用；补齐前置后的单次复验在第 21 次手势时间戳前置失败，未到新增区块，不称该部分通过。原结果全部保留，不重复全套挑成功、不调查 teardown。
- 离线打开、五工具、快捷键、消息验证、保存重开通过，Chrome 正常退出 **0**。额外独立库移动模拟可信 pen 编辑三轮磁盘批注 **4／8／12**、修订 **11／22／33** 均确认；第四轮工具切换等待失败，没有进入保存，不称四轮全过。证据 `tests/artifacts/general-0.5.13-ink-native-1791929036249.json`，清理后恢复 desktop、Reader **0**。
- 构建验证 **402** 个冻结 vendor 文件、**406** 资源，仅三文件；依赖和 Viewer 不变，`git diff --check` 通过。安装包 SHA-256 `831d6f84cc6c52a051e745d7e4f2e7cdb3a3c9e905e0e3904c899f930532554a`。源码差异、证据、哈希和安装说明位于 `dist/general-0.1general-0.5.13-*`。

关闭前仍需 PDF.js 序列化与持久恢复，这部分对大 PDF 可能有耗时；不宣称关闭零等待。iPadOS 挂起／强退可以中断后台工作，持久意图在下次启用时恢复检查；源写入已调用而结果不明时保持暂停。磁盘比较至写入的非原子竞争窗口、强退末段未提交操作和旧日志丢失限制仍存在。Mac 原生实例实际 Obsidian **1.12.7**，非目标 1.14.4；实体 iPad／Windows 仍待用户复验，不以移动模拟替代。

0.5.12 回滚包保留。仅独立测试库进行 PDF 操作；用户另行授权的远程仓库1部署只备份／替换三文件，设置、资源缓存、恢复副本和同步检查点保留，不操作其中 PDF。不创建 Release。最新 [0.5.13 三文件候选](dist/pdf-web-reader-0.1general-0.5.13-candidate.zip)。

## 前一版：0.5.12 增量恢复证据兼容修复（2026-10-14）

最新实体 iPad 0.5.11 会话仍未正常保存。JSON 原件 27,632,796 bytes，SHA-256 `41175adbb85a527e97827e3f30a116fb7e48c126ac022f57f559342cdf4b19ef`；完整原件、规范化时序与摘要独立归档于 `tests/artifacts/ipad-0.5.11-review-20261013T185842Z/`。导出包含 76,250 条记录，其中最新 0.5.11 会话 34,545 条；标记 `complete:false`、累计 83,566 条丢失，不称完整无缺失。最新会话五次保存均被“上次同步检查点尚未确认写回”拒绝，没有成功 ACK；最后修订 52 持久恢复后关闭。

根因是 0.5.11 遗留检查点兼容证明只接受 schema 1 完整 PDF 恢复副本，而实际恢复 writer 会产生 schema 2、`storage:pdf-prefix-delta` 的记录。这类合法证据在读取字节前被过滤。使用冻结 0.5.11 源码、真实 PDF 和真实增量恢复 writer/reader 的回归复现同一错误；源码补丁只增加精确的 schema 2 格式识别，不删除 pending 清单或恢复分支。严格核对 candidate ID／文件名、唯一候选、文档／修订／请求／路径、确切调用前错误、时间顺序、磁盘父指纹以及重建输出长度／指纹；重新枚举时再次核对格式及证据。invoked、部分写入、损坏、证据不足仍保持暂停。

三端统一 0.5.12，依赖、冻结 Viewer、保存节奏、跨端合并、设置及恢复格式不变。Luna Max 开发与独立审计，无剩余 P0/P1。原日志另有 DrawingEditor 回调和外部 host 编辑器错误，尚无证据确认其适配层原因，本轮没有猜测性改动第三方 Viewer，也不宣称这些错误已修复。实机仍须复验；磁盘比较至写入的竞争窗口、强退末段及日志丢失限制继续存在。

### 本轮验证与交付

- 原版真实 schema 2 增量候选回归 **1/1 失败**，原始 stdout 保存为 `tests/artifacts/ipad-0.5.11-delta-baseline-repro-20261014.txt`；早期基线脚本 ENOENT 属于测试准备失败，另存不重标产品失败。
- 修复后保存／恢复／真实 PDF 分支 **48/48**。旧 Ink、新 Square 都保留，实际合并只写入一次，旧恢复段字节不变，检查点确认。
- 指定独立库移动模拟以实际 journal/recovery writer 植入带相同 requestId 的合法增量候选。先确认旧 Ink 自动合并并载入，再四轮可信 pen 编辑保存；磁盘批注 **5／9／13／17**，修订 **12／23／34／45** 全部 ACK。旧 UUID、原增量段和可重建恢复副本保留，真实关闭按钮关闭、重开 **17** 条，prepareLocal 共 **5** 次。恢复 desktop、Reader **0**、退出 **0**。证据 `tests/artifacts/general-0.5.12-ink-native-1791919416907.json`。初期三轮失败另存：第一轮夹具 ID 含点不符合生产格式；后续工具启用异常从独立日志定位到合成 Ink 缺少 `/C`，PDF.js 在反序列化时 Array.from(null)。修正测试候选 ID／请求 ID、补齐合成笔迹颜色并明确启动刷新前置条件后通过；未改冻结 Viewer、未将这些早期轮次称通过。
- 冻结默认并发 **306** 项：**304** 通过、**2** 失败、**0** 取消，退出 **1**。FreeText 用例完成功能断言后 Chrome 退出 code 2；iPad pointer 在第 **21** 次注入晚于 **80ms** 前置门槛处停止，未执行部分不称通过。证据 `tests/artifacts/general-0.5.12-default-concurrent-20261014.txt`，不重复全套挑成功、不扩展 teardown 调查。
- 冻结离线打开、五工具、快捷键、消息校验、保存重开通过，Chrome 正常退出，退出 **0**。无 Node 启动、缓存／预热、日志／打包及各保存组件纳入上述全套；构建核对 **402** 个冻结 vendor 文件、**406** 资源，仅三文件。`git diff --check` 通过。Luna Max 独立审计无剩余 P0/P1。

[0.5.12 三文件候选](dist/pdf-web-reader-0.1general-0.5.12-candidate.zip)，SHA-256 `d14336c113ea4e8bd1a60d4aee70e47c82d93d1d2a4f08ec976e0210d2b93aa5`。附源码差异、仅本轮 host 差异、验证证据、哈希与安装说明（`dist/general-0.1general-0.5.12-*`）。原始实体 iPad 日志只在本地失败证据目录保留，含业务路径，不放入源码或候选安装包。未推送、未创建 Release。

本轮仅对 `/Users/jiajia/Documents/ObReader-Apple-Test` 安装与验证，先完整备份该库插件目录。主库只读取用户指定的诊断 JSON；不替换主库插件、不修改主库 PDF、不执行恢复覆盖、不删除旧恢复副本。0.5.11 三文件包保留回滚，0.5.12 候选交付后由用户另行安排实体 iPad 复验。

## 前一版：0.5.11 待确认检查点与追加保存修复（2026-10-14）

三端统一 0.5.11。冻结 Viewer、依赖、批注 UUID、跨端合并规则、自动保存间隔及旧恢复副本均保留。诊断导出包含当前及历史运行日志，原始 `.log` 独立导出命令注释保留。

本轮 iPad JSON 原件为 14,989,847 bytes，41,438 条记录。SHA-256：`8098ed0427facd851dbfdc862bd53714d3439811f37fc25dab3dad43ca181f18`。原件、规范化时序和调查记录保存在 `tests/artifacts/ipad-save-failure-20261013T181337Z/`，不改写原证据、不将含业务路径的原始日志加入公开源码。该导出明确标记不完整：17,915 条缺失及两个未正常结束的历史会话，不能宣称所有操作都有记录。

首次保存修订 27 在追加调用前报“PDF 已被替换或移除”。随后重启的保存都报“上次同步检查点尚未确认写回”。代码证实，追加前已持久保存 pending 检查点，而文件对象检查失败没有撤销这个未调用写入的记录；下次启动将它一律当作不明写入，持续暂停保存。日志没有函数参数，不能据此断言是哪项同步或第三方功能改变了文件对象。

修复分三层：同一路径的文件对象刷新后，重新读取并验证精确字节；文件内容不符仍拒绝追加。追加前取消，只回滚当前尝试的确切清单，保留原始恢复候选、旧分卷和前一清单。追加一旦调用，禁止盲目重试，必须读回完整指纹后才能确认。

检查点包含落盘的 `writePhase` 和精确父版本指纹／长度；追加与完整写回都在调用 Vault API 前标记 invoked。启动时，磁盘与已验证输出一致可确认而不重写；确切 preflight 父版本则保留完整本地分支，纳入下一次合并。公共合并基线与最近的追加父版本分别核对。旧 0.5.10 的 schema-2 追加检查点无阶段记录，仅在唯一、完整且可校验的 before-save 恢复候选能对应文档／修订／路径、失败时间和确切写入前错误时允许继续合并；缺少证据、阶段 invoked、部分追加、损坏或不明磁盘版本继续暂停。旧失败证据使用 UTC 时间关联，设备时钟突变会使关联被拒绝，不能据此自动丢弃分支。

刷新后的 TFile 修改通知按规范路径路由到现有 Reader 的绑定会话，不替换保存请求的文档身份。写入阶段标记与清单核对不提供文件系统原子比较交换；比较至实际写入间仍有竞争窗口。强退前未持久记录的末段仍可能无法恢复。

日志另有 `_freeHighlight` 和 DrawingEditor 回调状态异常，尚未证明自有适配层原因，本轮没有猜测性修改冻结 Viewer；实体 iPad 的 Pencil 行为仍待确认。外部 host 编辑器／同步错误也不归为本插件已修复项。

### 本轮验证与交付

- 原始 host 在真实 PDF 回归中重现“上次同步检查点尚未确认写回”。修复后，两项真实 PDF 分支测试保留旧 Ink UUID、新 Square UUID 及旧恢复段；39 项 host 回归后，独立审计补发现回滚异常恢复可能覆盖并发新清单，新增复现修复后 host **40/40**。早期测试夹具的 fingerprintChunks 缺失及遗留注入错误均保留失败结果，未标为产品通过。
- 冻结核心 **77/77**，运行时／打包／资源预热／日志 **85/85**，`git diff --check` 通过。构建确认 **402** 冻结 vendor 文件未改动、**406** 内嵌资源、仅三文件产物、无 Node 启动约束不变。Luna Max 独立审计复核后无剩余 P0/P1。
- 独立库移动模拟通过四轮可信 pen 编辑：磁盘批注 **4／8／12／16**，修订 **11／22／33／44** 全部确认；仅 **4** 次 prepareLocal。真实关闭按钮关闭，重开 **16** 条仍在；恢复 desktop、Reader 为 **0**，进程退出 **0**。证据：`tests/artifacts/general-0.5.11-ink-native-1791917323517.json`。实体 iPad 未验证，不将模拟等同实机。
- 最终冻结默认并发 **305** 项：**301** 通过、**4** 失败、**0** 取消、退出 **1**。三项在完成功能断言后仅因 Chrome 退出 code 2 失败；iPad pointer 用例在第 24 次手势注入迟于其 **80ms** 前置门槛处停止。针对该用例的单次复验到第 28 次手势仍注入迟到，未跳过断言，未将未执行部分称通过。原始结果全部保留，不扩大 teardown 调查、不增加重复门槛。审计末次修复前的并发轮次 **304** 项、**300** 通过、**3** 失败、**1** 取消也独立保留，不能代替最终冻结结果。
- 最终离线五工具、快捷键、bridge 校验、保存重开通过，Chrome 正常退出，退出 **0**。证据：`tests/artifacts/general-0.5.11-offline-20261014.txt`。

同一组三文件候选：`dist/pdf-web-reader-0.1general-0.5.11-candidate.zip`，SHA-256：`e053ceaf9f6eef06b902cf6d4d64bc7c55788f5291089c0de59faa8c2a7d0f3b`。源码差异、哈希表及交付元数据位于同目录 `general-0.1general-0.5.11-*`。0.5.10 正式历史包及带 JSON 日志的回滚包均保留。

仅在 `/Users/jiajia/Documents/ObReader-Apple-Test` 验证并安装 0.5.11，先完整备份插件目录；不修改主库 PDF、不替换主库插件、不创建公开 Release。用户的旧恢复候选保持原状，可通过既有“恢复最近的 PDF 自动保存副本”命令生成独立恢复 PDF；本轮没有代用户执行恢复或覆盖原文档。

## 前一版：0.5.10 连续笔迹保存与关闭修复（2026-10-13）

三端统一 0.5.10，冻结 Viewer、依赖、自动保存间隔、跨端合并及恢复格式不变。只修复有实际用户影响的保存故障，不放宽 UUID／页／类型／写入顺序的精确绑定，不猜测坐标，不忽略遗漏笔迹。

### 根因与修复

实体 iPad 0.5.9 重启后截图仍报 Ink editor_11／第10页绑定失败。在独立测试库用 12 页合成 PDF、可信 Chromium pen 事件复现同类失败。保留的 `rpc-4` 基线和草稿均为最初 7,573 bytes，含 0 条第10页批注，而请求元数据包含 9 条 Ink；已保存检查点为 95,493 bytes。独立审计重放同一输入得到完全一致的 `PDF_MERGE_NEW_ANNOTATION_BINDING_FAILED`。这是数据遗漏，而非 UUID 冲突。原始驱动最终因工具状态前置条件失败，不称整轮通过。

宿主 ACK 清除未保存标记，却不会替换 PDF.js Worker 最初加载的字节。同步检查点在 0.5.9 已处理这一点，普通保存与恢复路径尚有遗漏。三条入口现在都在保留批注 Storage 时调用 `saveDocument()`，不能发送初始 `getData()` 字节与当前批注身份混搭。

第一轮局部修复原生复验保存了 12 条 Ink 与 4 条 InkHighlight，修订 11／22／33／44 均确认，但暴露了另一实际问题：保存期间抬笔会再次设置 pendingInkCommit，手动保存循环只在入口提交一次，之后不断重复同一修订，阻塞关闭。失败驱动重开返回旧 Viewer 的 0 条批注，未视为重开成功；超过 770 份 RPC 捕获原样保留。仅对已核对当前修订与磁盘 16 条批注的合成测试文档注入一次序列化故障，让旧运行时停止循环，再走正常恢复确认关闭；这份清理不属于正常通过。

每轮保存在安全输入边界提交新结束的 Ink 笔迹，再捕获修订；等待重任务许可后还要复核，防止等待期间完成的笔迹遗漏。恢复确认与可关闭状态不接受仍有待提交笔迹的修订。绑定准备失败或为空时，宿主保存未经修改的原始 PDF.js 序列化结果；数据与完成标记读回校验之后才确认恢复。原 PDF 不被失败结果覆盖。

### 验证与交付

刷新身份兼容回归另外发现：已准备 PDF 的身份数据可能带有旧 Writer 的 runtimeId，而新 PDF.js 文档可能将同一编号分配给另一批注。旧映射使新 Square 的确切 ref 被关联到旧 Highlight 的 UUID。重新加载时只接纳 PDF ref／UUID，并丢弃前一文档的 runtimeId；同一文档的保存 ACK 仍保留 runtimeId，以兼容输出对象编号变化。该回归使用真实 prepareLocal 产物，正常宿主 inspect／merge 通常不带 runtimeId；不把模拟协议中的失败误称实体 iPad 已发生。保留失败再针对性修复，不改变 PDF 内 UUID。

首次默认并发 **275** 项：**272** 通过、**3** 失败、**0** 取消，退出 **1**。一项刷新身份回归触发了上述修复；另两项分别是 browser cleanup 的合成期限断言和可信手指事件迟于测试 80ms 前置门槛，不涉及本轮生产代码。原始日志保留，不调查 Chrome／CDP teardown、不加大等待或隐藏失败。重新冻结后的默认并发 **275** 项：**267** 通过、**6** 失败、**2** 取消，退出 **1**。五项完成产品断言后仅因浏览器退出 code 2／强制清理失败；iPad pointer 停在 80ms 事件到达门槛，未执行部分不宣称通过；桌面自动保存受 90s 并发期限取消，单独受影响回归通过；刷新后新增 ACK 用例因假宿主沿用旧基线取消，最终针对性复验保留断言并通过。不重复整套挑成功、不增加门槛、不继续 teardown 调查。实体 iPad 不用这些结果代替。

冻结核心回归 **114/114**、资源与打包回归 **46/46** 已通过。前一冻结构建的离线五工具及保存重开退出 **0**；最终构建完成五工具与保存重开断言，脚本因 Chrome 必须强制清理退出 **1**，不称正常通过。独立库最终可信 pen 用例连续四轮分别写入 **4／8／12／16** 条批注，修订 **11／22／33／44** 与宿主确认一致；只有 **4** 次 prepareLocal，实际关闭按钮完成关闭，新 Reader 重开保留全部 **12 Ink＋4 InkHighlight**，退出 **0**。桌面／移动模拟各自未编辑、编辑后、故障写入恢复共六项真实关闭按钮测试通过，退出 **0**。两份完整成功驱动均恢复 desktop、Reader／view 为 0。先前的 SDK detach 异步清理前置断言、键盘请求早于笔迹提交完成的观察错误，以及所有产品失败均保留原证据，不重标成功。受影响自动保存浏览器回归 **1/1**（54.565s），持有 ACK／重任务许可时完成的新 Ink 正确进入下一修订并结束保存。刷新身份回归 **1/1**（4.980s），覆盖真实合并产物刷新、保存 ACK、另一已有批注再次编辑的 UUID／ref 保持；额外测试最初使用刷新前的假宿主基线和旧 openRequest，守卫正确拒绝，校正真实会话前置条件后复验通过，未移除断言。原生操作仅在 `/Users/jiajia/Documents/ObReader-Apple-Test`；实际 Mac 为 macOS27.2／arm64、Obsidian1.12.7；1.14.4 是目标最低版本。Mac 移动模拟和可信 pen 事件不是实体 Pencil／WKWebView 验收。Windows／实体 iPad 保存、关闭、同步继续需要设备复验。强退恢复、完整 PDF.js 输出内存、非原子比较到写入以及日志累计限制沿用 0.5.9，不宣称全数消除。


[0.5.10 三文件候选](dist/pdf-web-reader-0.1general-0.5.10-candidate.zip) SHA-256：`b1a23e399f16139c9da09d2b7290c693b1c8f501b8d53f7e21bfdfe402fac7b1`。附 [源码差异](dist/general-0.1general-0.5.10-source.diff)、[哈希清单](dist/general-0.1general-0.5.10-SHA256SUMS.txt) 与包含原始失败的 [证据包](dist/general-0.1general-0.5.10-evidence.zip)。正常推送 main，不创建 Release。0.5.9 回滚 ZIP 保留；早期未完成刷新身份修复的局部候选仅在本地标记 superseded，不发布。

已完整备份并替换授权“远程仓库1”三文件，备份 `.deploy-backups/general-0.5.10-target-1791901733357089000`；其余 **2038** 个文件哈希不变，未操作 PDF、未重载主实例。设置、缓存、旧恢复和检查点保持不变。同步后确认三文件均为本候选，有未保存编辑时先尝试恢复并确认副本，再重启加载 0.5.10；实体 iPad 连续 Ink／高亮保存、二次编辑及关闭仍由用户复验。

## 历史：0.5.9 轻量恢复与后台增量保存（2026-10-13）

三端统一 0.5.9，同一源码和三文件；依赖、冻结 Viewer、默认自动保存间隔保持不变。PDF.js 先生成完整保存结果，自有增量写入器只输出变化的间接对象、外观资源、页面批注数组、合并元数据和 xref/trailer。最终补丁绑定磁盘的完整指纹和长度，使用公开 `Vault.appendBinary`；追加只发起一次，失败或写后不一致保留恢复并暂停，不能盲目重试。无法安全生成增量或宿主没有追加能力时保留完整写入路径。比较与追加之间仍无原子 CAS，同步竞争窗口不能完全消除。

恢复使用已验证共享基线加本修订的原始 PDF 增量段，包含可重建的外观字节；不是只保存无法独立恢复的操作 ID。JSON 完成标记在数据校验后提交，当前修订确认前不关闭脏 Reader。同步检查点以不可变增量记录串联，确认前保留 pending，支持旧 schema 1 读取。被替代分支、旧恢复副本不删除；损坏最新候选不会阻止尝试较旧完整副本。无自动清理／压缩，历史基线和段文件会累计；后续维护必须先证明引用已不需要。

批注 UUID、UTC/逻辑时钟、删除记录和合并规则继续写入 PDF；物理对象编号不作为跨端身份。两端新增／编辑／删除的双向合并按语义收敛，保留非插件批注和 Popup 关系。减少缓冲区复制和 Worker 传输副本；流对象比较直接分段哈希，不复制大图像／附件流。后台同步合并同样采用磁盘基线补丁，真正有变化时才重载 Viewer。

PDF.js 仍分配完整 `saveDocument()` 输出，磁盘核验仍完整读取；恢复确认在序列化后发生，不宣称每一笔已经立即落盘。Mac 的 JS 堆／缓冲区测量不等同于实体 iPad 总内存或崩溃验收。

### 0.5.9 验证与性能

冻结核心回归 **114/114**、存储与运行时检查 **61/61**，离线五工具／保存重开退出 **0**。默认并发 **273** 项：**269** 通过、**3** 失败、**1** 取消，退出 **1**，不称全套通过。annotation-interaction 与 desktop-toolbar 产品检查完成但 Chrome 退出 2；iPad pointer 用例停在模拟事件到达 80ms 前置条件，后续断言未执行；移动自动保存用例在并发下 60s 超时取消。受影响自动保存单独复验 **1/1**、退出 0，未改等待门槛、生产代码或隐藏重试。原始失败、取消和历史故障都保留，不继续 teardown 调查。

原生真实关闭按钮六场景（桌面／移动模拟的未编辑、编辑后保存、模拟写入失败恢复）全部通过，退出 0。大 PDF 同一 Reader 连续四次编辑、保存、重开四条 Square 均通过，两组均恢复 desktop、Reader 0。过程中定位并修复了清洁检查点误用 PDF.js 初始 getData 的产品问题：已确认写回的 ref:null 编辑器仍须 saveDocument 生成其对象，不能只发送身份而遗漏对象。核心继续拒绝不匹配身份，不靠猜测绑定。

同一冻结 0.5.9、120 页文本＋16MiB 随机附件合成 PDF 的单次成对对照：完整写入组仅在独立测试内临时禁用 append 能力，其他代码一致；不是旧版 0.5.8 的成功连续基线。旧版连续第二次保存失败的证据不重标成功。

| 指标 | 增量路径 | 同版本完整回退 |
|---|---:|---:|
| 四次平均确认耗时 | 4.30s | 4.77s |
| 原 PDF 写入总量 | 154,468 bytes | 67,558,143 bytes |
| 观测 JS＋缓冲区峰值 | 611,915,570 bytes | 612,448,364 bytes |

耗时约减少 **9.86%**，原 PDF 写入约减少 **99.77%**；观测内存峰值差 **0.087%**，不能视为明显下降。附件型合成 PDF、单次对照、Mac CDP 的渲染器与可发现 Worker 堆／backing storage 不能代表实体 iPad 总内存、GPU／原生画布或扫描书籍，也不能宣称崩溃已解决。冻结 PDF.js 的完整输出和全文件核验仍是剩余开销。实际 Mac 为 macOS27.2/arm64、Obsidian1.12.7；1.14.4 是目标最低版本，实体 iPad 待用户确认。

独立审计无新 P0，源码哈希匹配冻结产物。[0.5.9 三文件包](dist/pdf-web-reader-0.1general-0.5.9-candidate.zip) SHA-256：`645b83263a3074efb9a4c4050e9d4859c874f185ba51da77510dc01c8a49187f`。附 [源码差异](dist/general-0.1general-0.5.9-source.diff)、[证据包](dist/general-0.1general-0.5.9-evidence.zip)、[哈希清单](dist/general-0.1general-0.5.9-SHA256SUMS.txt)。

按明确授权备份并替换“远程仓库1”三文件，备份 `.deploy-backups/0.5.9-target-1791894786082031000`；其余 **2038** 文件哈希不变，未操作 PDF 或重载主实例。旧恢复记录、设置、缓存、同步检查点与 0.5.8 回滚包保留。同步后先保存当前编辑或确认恢复副本，再重启加载 0.5.9。正常推送 main，不创建 Release。


## 历史：0.5.8 编辑后关闭协调（2026-10-13）

关闭标签页先登记关闭意图，阻止该 Reader 启动新的同步刷新；已有 checkpoint 安全完成，已准备／进行中的 apply 使用现有取消协议确认结束，再向 Viewer 请求关闭保存或当前修订的持久恢复副本。预期的关闭取消不伪装成成功刷新，也不将文件永久暂停。撤销／失败关闭会恢复同步调度。关闭确认计时在协调完成后启动，不向 Viewer 发送已失效的关闭请求。

不强制丢弃编辑，不将失败取消当成功，不提前释放重任务槽。大 PDF 的序列化、已接受写回或失败恢复仍可能需要等待；只有确认当前修订安全后才关闭。Windows、macOS、iPadOS 共用源码与三文件，版本 0.5.8。依赖、冻结 Viewer、自动保存间隔和恢复格式保持不变；0.5.7 回滚包保留。实机 iPad 仍待用户复验。

### 0.5.8 验证与交付

关闭协调回归 **79/79**、打包与无 Node 启动 **14/14**、离线五工具及保存重开退出 **0**。指定独立测试库中，桌面／移动模拟各自的未编辑、编辑后保存关闭、写入失败保留恢复副本，共六项真实关闭按钮功能断言通过。两次完整原生驱动均在恢复模拟状态时因残留测试 Reader 退出 **1**；第一份原始 JSON 错记 passed，不作为整次通过。后续独立清理与恢复记录确认 desktop、Reader 为 0。不修改失败原始证据，不以模拟耗时代替 iPad 实机表现。

未重跑默认全套，不重标历史失败；本轮只验证关闭影响范围。独立审计无阻断项。此前关闭计时／checkpoint 竞争的推测经顺序复核已撤回，不作为已证实根因。已有同步 apply 未结束而阻塞关闭的顺序问题已通过关闭意图与终态取消握手修复；PDF 序列化及已接受写入仍安全等待。

[0.5.8 三文件候选](dist/pdf-web-reader-0.1general-0.5.8-candidate.zip) SHA-256：`8065df558694b41121facbf636d0e908432bae727062b4d2a126b9ab98bb1f19`。附 [源码差异](dist/general-0.1general-0.5.8-source.diff)、[证据包](dist/general-0.1general-0.5.8-evidence.zip)、[哈希清单](dist/general-0.1general-0.5.8-SHA256SUMS.txt)。独立审计、原生失败和恢复记录均归档。

按明确授权先备份再替换“远程仓库1”三文件，备份 `.deploy-backups/0.5.8-target-1791851792089482000`；其他 **2038** 个文件哈希不变，保留设置、缓存、恢复和同步检查点，未操作 PDF 或重载主实例。0.5.7 回滚包保持原哈希。旧版本标签页已卡住时，先尝试手动保存或确认恢复副本，再重启加载 0.5.8；不要强退来证明安全关闭。Windows／实体 iPad 待用户复验。正常推送 main，不创建 Release。

## 历史：0.5.7 iPad 工具启用时手指仅导航（2026-10-13）

启用批注工具时，手指在 PDF 页面只用于滑动翻页，不触发文字选择、选择手柄或长按选词。按真实指针类型保护页面，Pencil 的文字高亮、绘制与鼠标操作仍保留；工具栏、参数、页码和可编辑输入区保持可操作。补齐 Pencil 文字选区的释放端点，验证同页连续跨行高亮及保存重开。不改变保存、同步、惯性参数、依赖或冻结 Viewer。三端统一版本 0.5.7；0.5.6 三文件包保留回滚。iPad 实机由用户同步后确认。

手指禁选使用 scoped `user-select`、Safari 的 `-webkit-user-select`／`-webkit-touch-callout` 及事件拦截；[Safari 官方说明](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariCSSRef/Articles/StandardCSSProperties.html)解释 callout 的长按控制。Chromium 不支持的 Safari 属性只核对 CSS 声明，不能据模拟宣称 iPad 系统菜单已验收。

### 0.5.7 验证与交付

打包、无 Node 启动和惯性数值回归 **27/27**。可信 Chromium touch 验证启用高亮时的 CSS 禁选、selectstart/contextmenu 拦截与正常抬指后的 sticky 保护；这些事件兜底的 scripted 检查不等于 iPad 实机菜单验收。Pencil 跨同页两行、经过行间空白，并只在 pointerup 给出第二行最终坐标：真实 PDF.js `#onSelectEnd` 原生调用收到含换行的完整 Range，生成 1 条 Highlight；保存并重新解析输出 PDF 后仍是 1 条批注、44 个 quad，审计确认两条几何行带。主测试不屏蔽原生调用，不凭 fallback mock 宣称通过；异步 selectionchange 的旧 trace 不作为最终选区。

原始 focused 完整用例退出 **1**，本轮两项功能断言完成后，旧惯性输入 helper 因可信 pointerdown 迟到 **85.8 ms** 超过测试 **80 ms** 门槛失败。未修改门槛或重跑挑成功结果，日志 `general-0.5.7-focused-20261013-075104.log` 与 `ipad-pointer-policy-1791849064922-92699.json` 保留；不能称整项测试通过。此前 Blink 不支持 Safari-only computed 属性、数值 VM 缺少新 helper，以及原生驱动旧版本安全前缀的失败亦保留，修正只涉及测试能力判断／依赖／版本前缀。

独立测试库 `general-0.5.7-scroll-native-1791849207700.json` 通过，安装产物逐字节匹配后用真实 touch 检查工具启用时惯性滑动与再次接触停止、不生成批注，结束恢复 desktop、Reader/view 均为 0。离线验证退出 **0**，五工具及保存重开通过。本轮仅做受影响验证，不重跑默认完整套件或继续 teardown 调查；0.5.6 默认 **223/229** 的历史失败仍保留，不重标通过。

[0.5.7 三文件候选](dist/pdf-web-reader-0.1general-0.5.7-candidate.zip) ZIP SHA-256：`6ec59c3862f3accbf81179529746948091908e48bd61bbc8d738f8d6d461889e`。附 [源码差异](dist/general-0.1general-0.5.7-source.diff)、[证据包](dist/general-0.1general-0.5.7-evidence.zip) 和 [哈希清单](dist/general-0.1general-0.5.7-SHA256SUMS.txt)。三端使用相同三文件，Windows／iPad 实机仍待用户确认。

按既有明确授权备份并替换“远程仓库1”插件三文件，备份 `.deploy-backups/0.5.7-target-1791849230176807000`；其他 **2038** 个文件逐字节哈希一致，保留设置、缓存、恢复和同步检查点，未操作 PDF、未重载主库。同步后先保存关闭旧 Reader，再重启 iPad Obsidian；验证工具启用时手指长按／拖动只翻页，Pencil 连续跨两行保存重开。0.5.6 回滚包原哈希保留；正常推送 main，不创建 Release。强退恢复、设备时钟及磁盘比较到写入的同步竞争窗口限制不变。

## 历史：0.5.6 惯性滚动与跨页链接保存修复（2026-10-13）

Windows、macOS、iPadOS 共用源码和同一组三文件，版本统一 **0.5.6**。自定义手指滚动保留，不放开 WebKit 原生滚动或改变手指／Pencil 分工。

| 参数 | 数值 |
|---|---:|
| 采样窗口／权重 | 80 ms／`exp(-age / 40ms)` |
| 启动最低合速度 | 90 px/s |
| 最大初始合速度 | 4,000 px/s，保持方向 |
| 衰减时间常数 | 350 ms |
| 停止合速度 | 10 px/s |
| 最大样本数／最低时间跨度 | 128／8 ms |

最近位置使用加权线性回归估算 X/Y 速度，同时间样本合并。保留窗口外最多一个前驱，仅在其与首个窗内样本间隔不超过 80 ms 时插值窗口起点，避免样本刚越过边界令速度突降；超过 80 ms 不桥接，恰在边界的原样本不重复计权；优先采用匹配 performance 时间基准的事件时间戳，异常或倒退时回退并保持非递减，微小未来时间不将惯性起点推到未来。抬指前计入终点，静止终点参与回归但不刷新最后实际移动时间；停住超过 80 ms、样本不足、多指、取消或被 Pencil 绘制阻断时不启动惯性。

保留 rAF 和指数解析积分，移除 32 ms 截断，按真实时间推进，跨停止速度时精确积分到停止时刻；无边界最大初速的理论惯性距离为 1,396.5 px，持续约 2.10 秒。边界按轴停止，新触碰、工具／文档切换和减少动态效果继续受控。隐藏页面取消当前惯性，并阻断隐藏前触摸在恢复后抬指重新启动。该算法保持时间一致性，不能消除主线程阻塞本身造成的丢帧，也不宣称等同原生 UIScrollView。

截图保存错误已定位到普通 `Link /Dest[0]` 的页引用：通用 guard 对每个批注键遍历，将标准跨页链接误判为外观复制页树。只读用户 PDF 结构确认 126 条引用来自 Link 目标，AP 外观中没有页面引用；没有修改或公开书籍内容。合并在页指纹、页顺序、几何与文档身份验证通过后，将已登记的源叶页面引用按页序映射到远端既有页引用，不复制源页面。保留 `/Pages` 根、未知页和批注关系的拒绝；不新增协议或修改恢复格式。回归覆盖标准 Dest、GoTo 动作、AP 资源跨页引用、源／目标对象编号不同、真实页指纹及无孤立页面对象。

0.5.5 的自动保存冷却、复制／内存释放、同步合并与恢复行为保持不变；没有新增设置、消息协议、依赖或冻结 Viewer 修改。0.5.5 最新滚动修复包继续作为回滚：`pdf-web-reader-0.1general-0.5.5-scroll-fix-candidate.zip`，SHA-256 `2e3dfc5d360d6dbbff0b8450d8330215d1e2b893ea731bee8cf41bbdb2f66a0f`。另存三文件备份 `.deploy-backups/0.5.5-before-0.5.6-20261012T193220Z`。

最终候选、验证与部署证据在本节后续交付记录中列出。原生验证只使用 `/Users/jiajia/Documents/ObReader-Apple-Test`；用户明确授权发布后备份替换“远程仓库1”插件三文件，保留设置、缓存、恢复和同步检查点，不操作其中 PDF。实体 iPad 的滚动手感、WKWebView 帧率与 Pencil 行为仍由设备确认。


### 0.5.6 冻结验证与交付

惯性数值与合并核心回归 **33/33**。修正后的可信触摸聚焦测试 `ipad-pointer-policy-1791837537773-68111.json` 通过；保留旧的并发慢拖和 Chrome 合并事件前置条件失败，生成器只修正 CDP 输入，未放宽产品断言。独立库原生 `general-0.5.6-scroll-native-1791836646308.json` 验证惯性、新接触停止、手指不生成批注。`general-0.5.6-save-memory-native-1791836494423.json` 验证五条 Square 自动／手动／关闭保存、Pencil 自由高亮、旧版本同步合并、保存重开，以及跨页 Link 指向目标现有页面。结束恢复桌面模式并清理测试 Reader。

最终默认并发 `general-0.5.6-release-validation-1791837577620548000` **223/229 通过、6 失败、0 取消，退出码 1**；源码和产物哈希前后相同。四项仅在产品断言完成后因 Chrome 子进程退出码 2 失败。另两项分别是既有失焦取消保存的 5 秒等待超时，以及滚动“相等时间区间”衰减断言失败；保留为未确认的并发功能断言问题，不能统称清理异常或标记已通过。现存证据没有记录实际区间长度，不能判断区间是否相等。定向／原生验证通过，目前未证明新的真实用户 P0；按用户约定不新增重复门槛、不继续 teardown 调查，交付候选并公开局限。离线退出 **0**。先前失败轮次原样保留在证据包。

[0.5.6 三文件候选](dist/pdf-web-reader-0.1general-0.5.6-candidate.zip) 含且仅含三文件，ZIP SHA-256 `16d8895d93ea92dd8c36f032df6e5a210af34b6de1bc8559b6384f3610ea807f`，main.js `aef5de283dda9a4a756df8d545dbdc2973ab49631030b58f416e0e2a3e928e2e`。附 [源码差异](dist/general-0.1general-0.5.6-source.diff)、[原始证据](dist/general-0.1general-0.5.6-evidence.zip)、[哈希清单](dist/general-0.1general-0.5.6-SHA256SUMS.txt)。用户 PDF 和截图内容不进入公开证据。

已按授权备份并替换“远程仓库1”插件三文件，备份 `.deploy-backups/0.5.6-target-1791837708037886000`；其他 **2036** 个插件文件逐字节哈希不变，设置、缓存、恢复副本及同步检查点保留，未操作 PDF、未连接主库原生实例或强制重载。同步后先保存并关闭旧 Reader，再重启 iPad Obsidian 验证。若旧编辑留在恢复副本，可使用原有“恢复最近的 PDF 自动保存副本”命令；不自动覆盖用户 PDF。0.5.5 回滚包保持原哈希。Windows／iPad 实机、强退恢复和磁盘比较到写入的竞争窗口仍保留原限制。正常推送 main，不创建 Release。

## 0.5.5 手指滚动追加修复（2026-10-13）

三端版本仍为 0.5.5。惯性启动门槛保留 0.12 px/ms，停止门槛改为 0.015 px/ms，避免尾段仍在明显移动时突然截断；抬指时接收最后触点位移再计算惯性，取消事件不应用终点。暂停、多指、Pencil 绘制、边界、再次触碰及 reduced-motion 的处理保留，冻结 Viewer 和依赖没有修改。

新增惯性回归 3/3；真实浏览器指针策略与移动自动保存聚焦验证 2/2。冻结默认并发原始结果为 **216/217**、退出码 1：所有产品功能断言完成，唯一失败为移动自动保存测试清理时 Chrome 子进程退出码 2。保留原日志，不将此项重标通过，按既有约定单列基础设施问题，不调查 teardown 或增加重复门槛。离线验证正常退出 0。独立 Luna Max 只读审计无阻断项；实体 iPad 手感仍待用户确认。

最新 [三文件包](dist/pdf-web-reader-0.1general-0.5.5-scroll-fix-candidate.zip) 和 [追加证据](dist/general-0.1general-0.5.5-scroll-evidence.zip) 对应该小修，最初 0.5.5 候选及 0.5.4 回滚包继续保留。已按本次明确授权替换 `/Users/jiajia/Documents/Documents/Obsidian/远程仓库1/.obsidian/plugins/pdf-web-reader`，旧三文件备份在 `.deploy-backups/0.5.5-scroll-target-1791832837830032000`；其余 1,629 个文件哈希一致，设置、缓存、恢复副本和同步检查点保留，未操作 PDF 或重载库实例。同步后先保存并关闭 Reader，再重新加载插件。


## 历史：0.5.5 iPad 保存与内存候选（2026-10-13）

Windows、macOS、iPadOS 使用同一套源码与同一组三文件，统一版本 **0.5.5**。iPad/iOS 输入入口默认停笔／编辑结束 3 秒后自动保存，自动保存起始间隔至少 10 秒，按上一轮完整保存耗时适应，冷却上限 30 秒；保存期间的新修订保持 dirty，回到下一轮空闲调度，不在 auto flight 中立即循环追写。桌面空闲等待保持 1 秒。手动保存、快捷键和可控关闭绕过自动冷却，仍等待输入边界、串行执行与精确修订确认。focused FreeText 文档切换也等待安全提交及旧文档最新修订，不丢未确认编辑。

移动端共享重任务槽覆盖序列化、检查点／合并和写回；先取得槽再进入保存队列。Worker 入场与 RPC 全局串行，只有独占的一次性副本转移，不 detach PDF.js 或宿主保留的基线。宿主复用不可变已确认快照，去掉哈希、转换和 Worker 返回值的冗余复制；同内容 base/checkpoint 只解析一份只读模型，draft 保持独立可写。自身修改通知先比较实际磁盘内容再分配大检查点，不用时间窗口忽略事件。复用与输出同源的验证元数据，保留 UUID 精确映射、页面血缘、磁盘比较及写后验证。

最后一个 Reader 关闭并完成相关任务后，释放该文件的内存基线／检查点；下次打开从保留的磁盘检查点重新核验。多视图、同一 Reader 快速切回和旧任务结束均有回归保护。不会删除旧恢复文件、同步检查点或删除记录。完整冻结 Viewer、增量缓存／后台预热、离线三文件发布和锁定依赖保持不变，未降低画布清晰度。

慢同步刷新达到原有超时后先请求取消，只有 Viewer 中止打开、销毁 PDF.js 任务并清理引用后才释放槽；迟到成功确认仍正确更新宿主基线。无法确认停止时保留 pending／槽和恢复副本，不能把取消失败当成功。用户显式关闭 Reader 时先销毁失败 renderer，再结束旧请求。清理 fallback 保留原始异常，暂停自动保存并提供恢复／重开提示；不自动重载丢弃编辑。

### 冻结验证与原生证据

- 默认并发全套 `general-0.5.5-validation-default-2026-10-12T17-40-03-735843+00-00`：**214/214 通过**，0 失败／取消／跳过，自然退出 0，源码前后哈希完全一致。离线 `general-0.5.5-validation-offline-2026-10-12T17-40-03-726070+00-00` 自然退出 0，五工具与保存重开通过，正常浏览器退出。
- Mac 移动模拟 `general-0.5.5-save-memory-native-1791826692846.json`：两次连续鼠标编辑合并成 1 次自动写回；冷却内继续编辑未重复自动保存，工具栏手动保存即时写回，第五条编辑在关闭时保存，重开后五个 Square 均存在。重开重新读取 1 次检查点元数据，验证已释放内存状态但保留磁盘检查点。结束恢复 desktop 模拟状态，Reader 为 0。
- Mac 桌面 `general-0.5.5-native-1791826734409.json`：干净同步刷新、实际鼠标脏编辑与远端批注合并、已确认本地检查点保护、同内容重复通知、旋转／页宽阅读位置与第二 Reader 缓存复用通过。插件加载时自动预热 254 ms，406 次 stat、0 次缓存二进制核验读取、0 次解压；同实例再次准备 0 ms／0 次检查。该数据只属于 Mac 样本。
- 独立 Luna Max 审计复核共用核心、各平台入口、所有权、锁顺序、修订确认、取消及释放顺序，最终产物与证据另由交付清单核验。

早期 focused autosave 两次失败保留原始日志与 JSON：分别是 FreeText 提交边界在 flight 中失去计时器，以及旧文档切换错误比较新文档身份；两者已修复，最终 focused 2/2 及默认全套均通过。取消 fallback 测试的首次断言形状失败、source VM harness 未登记新 browser-only 模块、测试安装缓存旧 manifest／后台不可渲染导致的失败也原样保留，未重标为通过。未调查或扩展 Chrome／Puppeteer／Crashpad／CDP teardown。

### 安装、回滚与已知限制

[0.5.5 三文件候选](dist/pdf-web-reader-0.1general-0.5.5-candidate.zip)仅包含 `main.js`、`manifest.json`、`styles.css`，ZIP SHA-256：`6d1277ee0ac018380d97afda2eef4c98defa66403929702290ee7ddd34173cb6`；main.js：`5642446708a3eb88e40935ab061d912f910659cf0f11e035861291a6957e718c`。交付 [证据包](dist/general-0.1general-0.5.5-evidence.zip)、[证据清单](dist/general-0.1general-0.5.5-evidence.manifest.json)、[源码差异](dist/general-0.1general-0.5.5-source.diff) 和 [SHA-256 清单](dist/general-0.1general-0.5.5-SHA256SUMS.txt)。

本轮仅更新 `/Users/jiajia/Documents/ObReader-Apple-Test`。`general-0.5.5-test-deployment-1791826658906.json` 记录完整旧插件备份 `.deploy-backups/general-0.5.5-test-deployment-1791826658906/pdf-web-reader`，替换仅三文件，原设置逐字节保留，既有恢复／检查点未写入。测试只修改每轮独占的合成 PDF。`远程仓库1` 与主库没有更新、重载或 PDF 操作；其先前 0.5.4 部署记录为历史状态。

安装前保存并关闭 Reader，完整备份插件目录，只替换三文件，保留 `data.json`、缓存、恢复和 `.sync-checkpoints`。恢复 [0.5.4 回滚包](dist/pdf-web-reader-0.1general-0.5.4-candidate.zip)时也按此步骤操作；历史三文件 ZIP 原哈希仍是 `6e2922fe99404506e670e346507c1184b9f4d923ebce98f6fa63cc336d18b8c6`。本地另保留 `.deploy-backups/0.5.4-before-0.5.5-20261012T165407Z` 三文件和 ZIP 备份。

实体 iPad Pro 2018 的实际内存峰值和崩溃是否消失仍待设备复验；Windows 实机也未重新验收。Mac 移动模拟不能替代 WKWebView／Jetsam 证据。较长自动保存间隔扩大了突发强退前未持久化的编辑窗口；系统强退／恢复副本写入失败仍不能承诺无损恢复。磁盘比较与写入之间的同步竞争窗口继续存在。按授权验证后正常推送 main，不创建 GitHub Release，不部署主库。

## 历史：0.5.4 交付与验证

## 当前：0.5.4 工具栏、惯性滚动、参数浮层与 Pencil 高亮

修复用户 iPad 截图中的两项界面问题：撤销／重做沿用现有 PDF.js 的 16px SVG + CSS mask 机制，使用相同主题颜色、悬停和禁用表现；工具栏根据实际可用宽度与可见控件宽度决定单行或双行，取消固定 880px 强制双行。布局随阅读区尺寸及控件内容变化更新，菜单与 PDF 顶部位置跟随实际工具栏高度。

手指快速滑动后抬起，页面继续平滑滑动并逐渐减速；再次触碰、Pencil／鼠标操作、滚轮、工具变化或文档生命周期结束时取消惯性。暂停后抬手、取消事件及绘制期间的额外手指不启动惯性；惯性不产生批注修订或阻塞保存。

颜色／参数浮层支持鼠标、手指和 Pencil 点按外部收起，保持当前工具选中。修复高亮保存绑定：文字高亮保存为 `/Highlight`，自由涂抹高亮保存为 `/Ink /IT /InkHighlight`；按逐页 writer 顺序、类型、数量和准确对象引用绑定，普通 Ink 不会被当成高亮。兼容旧 schema-1 的 InkHighlight 身份，不更改 UUID 或恢复格式。

原生移动模拟确认笔尖命中文字时浏览器能返回文字 caret，但拖动后的选区仍折叠。适配层只为可信、主按钮、模式 9、实际文字 span 上的 pen 手势，从原文字层 caret 建立实际 Range，交给冻结的原生 `highlightSelection` 生成 QuadPoints。取消、失焦、模式／文档变化清理仍由本手势拥有的选区；其他操作改变选区后停止接管。手指仍导航，空白区域保持自由高亮。实际设备若没有文字层，不能凭图片内容生成文字高亮。

三端统一 0.5.4，仍共用三文件产物和核心。保留 0.5.3 手指导航／Pencil 按当前工具分工、默认自动保存、同步刷新和增量缓存；冻结 Viewer、依赖、设置与消息协议不变。Luna Max 子代理开发和独立审计；iPad 实机复验仍由用户完成。

### 0.5.4 冻结验证

最终默认并发记录 `general-0.5.4-validation-default-2026-10-12T02-22-14-083Z` 为 **194/194 通过**，0 失败、取消、跳过，Node 自然退出 0；最终离线记录 `general-0.5.4-validation-offline-2026-10-12T02-22-15-366Z` 自然退出 0。源码和产物前后保持一致，没有追加重复运行门槛。早期 SVG data URL 被误判为外部请求及 Chrome 子进程退出失败的原始日志保留，不重标为通过；测试只放行自有 CSS 中两个完整匹配的内嵌 SVG URL，未知 data URL 和外部请求仍受原断言约束。

原生高亮记录 `general-0.5.4-highlight-native-1791771682796.json`：在指定库的 Obsidian 移动 SDK 模拟中，可信 pen 坐标拖动在不可见 OCR 式文字层上生成 8 个 QuadPoints，第二页空白区自由高亮没有 QuadPoints。手动保存确认修订 4/4，两条批注分别准确保存为 `/Highlight` 和 `/Ink /IT /InkHighlight`，UUID／引用按页绑定，重开各保留一条；自动保存设置恢复开启，回到桌面，Reader/view/gate 为 0。该用例不包含实际 OCR 引擎或 iPad/Pencil 硬件结论。此前选区折叠的真实失败、修复前候选及非可见第二页测试坐标失败均保留。

最终聚焦输入记录 `ipad-pointer-policy-1791771564132-45174.json` 通过：真实坐标的可信 pen 输入使用 caret 端点形成选区，原生回调被限定抑制后仍由适配层调用原生编辑器生成 176 QuadPoints／一条存储批注；没有给测试预置 Range。覆盖惯性取消、绘制期间手指阻断、参数浮层外部收起及工具保持选中。核心聚焦回归 18/18，最终完整套件也覆盖保存绑定、旧身份兼容和二次编辑。

[0.5.4 三文件候选](dist/pdf-web-reader-0.1general-0.5.4-candidate.zip) 含且仅含 `main.js`、`manifest.json`、`styles.css`，SHA-256 为 `6e2922fe99404506e670e346507c1184b9f4d923ebce98f6fa63cc336d18b8c6`；main.js 为 `932a2e86471b259afa18eee2757efd20f9bf45dad0c6f21948969fc7ce7455f9`。保留旧版回滚包和被替代的本地修复前候选。

原生 UI 记录 `general-0.5.4-ui-native-1791771921182.json` 在桌面与移动 SDK 路径通过：780/640 px 阅读区使用 32 px 单行，432/320 px 使用 64 px 双行；SVG 历史图标与原生工具同尺寸／颜色，禁用状态、缩放、页码、五工具、中键轮盘、删除撤销重做、手动保存重开和真实双击二次编辑均通过。可信 CDP 手指输入抬起时滚动 110 px，120 ms 后到 302 px，再次点按工具栏停止惯性且不创建批注。该驱动明确使用跟随已核验测试窗口尺寸的 CSS viewport 自动化；之前残留 800×600 viewport 导致的两次准备失败分别保留，没有把准备失败包装成功或调查 teardown。

暖启动／同步记录 `general-0.5.4-native-1791772000099.json`：任何 Reader 打开前插件加载自动预热 166 ms，406 次 stat、0 验证读取、0 解压／写入；同实例资源准备 0 ms／0 检查。首 Reader 工具可用约 175.7 ms，第二 Reader 约 96.3 ms；实际鼠标本地修改与远端三身份合并、旧检查点保留、重复通知不重开、同 iframe 保持 90° 旋转和页宽通过。此为 Mac 样本，不构成 iPad 耗时承诺。最终 handoff 确认桌面启用、自动保存开启、Reader/view/gate 为 0，测试窗口还原。

最终 Luna Max 独立审计未发现 P0。已知非阻断限制：短暂的笔文字手势中，兼容 MouseEvent 不带原 pointer ID，无法区分同时操作的另一只鼠标；不宣称此混合设备同时操作验收。实际 iPad/Pencil 投递、系统手势和性能仍由设备确认。强退恢复限制和比较至写入竞争窗口继续保留。

已按授权备份并替换 `/Users/jiajia/Documents/Documents/Obsidian/远程仓库1/.obsidian/plugins/pdf-web-reader` 的三文件；`general-0.5.4-target-replacement-1791772082646.json` 确认与候选逐字节一致。旧 0.5.3 三文件在 `.deploy-backups/2026-10-12T02-28-02-602Z/remote-vault-1-three-files`，data.json 字节一致，缓存、恢复副本、同步检查点和 PDF 未改动，也未重载目标库运行实例。保存、关闭 Reader 后重新加载插件；iPad 同步后确认 **0.5.4**。已有失败编辑可以通过原有 **恢复最近的 PDF 自动保存副本** 命令取回，不清理旧恢复文件。

[0.5.4 验证与调查证据](dist/general-0.1general-0.5.4-evidence.zip)、[证据清单](dist/general-0.1general-0.5.4-evidence.manifest.json)与 [SHA-256 清单](dist/general-0.1general-0.5.4-SHA256SUMS.txt)包含各次原始失败、驱动快照、原生截图、聚焦回归和源码差异。推送使用正常 `main` 更新，以 Git 历史确认；不创建 Release。Windows／iPad 实机待用户复验。

## 历史：0.5.3 工具栏收敛与 iPad 输入分工

0.5.3 延续 Windows、macOS 与 iPadOS 使用同一组三文件、编辑／保存／同步核心及平台入口。0.5.2 的 **显示阅读器状态栏** 设置继续保留：默认关闭，旧设置缺少该字段时也按关闭处理；开关即时作用于已打开的 Reader 和 popout，不重载 Viewer。状态及恢复动作仍保存在 Reader 内部，现有 Notice 与 **恢复最近的 PDF 自动保存副本** 命令不依赖状态栏显示。

工具栏将 **编辑** 菜单位置改为 **↶**/**↷** 撤销／重做按钮，尺寸为 32 px。删除动作移到 **更多**；复用 PDF.js 现有原生保存按钮，不增加重复保存按钮。主、次工具栏中的插入图像和打印按钮隐藏，冻结 Viewer 中对应代码与 DOM 节点保留。其余五个原生批注工具及桌面中键轮盘保留。缩放组宽 64 px；页码输入宽 36 px，超过四位后每位增加 8 px。原有四个缩放 glyph、百分比和自定义缩放值保留；`↕` 的说明为 **适合整页**，沿用现有整页适配值，不描述为适合页面高度。既有缓存预热／增量索引不变；不修改冻结 PDF.js Viewer 或升级依赖。

iPad 输入按用户确认的当前工具自动分工：批注工具处于活动状态时，Apple Pencil 兼容的实际 `pen` 指针输入负责绘制、编辑或擦除；`NONE` 模式下笔输入平移 PDF。手指触碰 PDF 页面只用于导航平移，不触发页面链接、文字选择或批注交互；Reader 工具栏和侧栏控件仍可操作，原生 `input`／`contenteditable` 输入例外继续保留。实体 iPad／Pencil 事件投递仍待硬件验收；原生 CDP 触摸与 Pencil 模拟只覆盖自动化路径。当前不宣称压力感应、悬停、掌拒／掌形 AI 或 Scribble 支持。

加入 Pencil 输入路由前的 0.5.3 UI 基线另作为历史记录保留；另有一轮已加入 Pencil 但修复前的默认／离线失败记录，也保留为历史且不改写为通过。Mac 原生验证限 `/Users/jiajia/Documents/ObReader-Apple-Test`，开始前核验实际 Vault 与插件身份；CDP loopback 端口按运行时实际归属识别，不固定为某个端口。Mac 暖启动、三文件替换和当前实例状态见下文；替换后的目标库运行实例没有被重载。用户同步到 iPad 后应确认版本 0.5.3，并保存、关闭 Reader 后重新加载插件。主分支推送由主代理另行完成并以 Git 历史为准，不创建 GitHub Release。Windows 与 iPad/Pencil 实机验收仍待各自设备确认。

### 0.5.3 冻结验证与候选产物

冻结默认并发记录 `general-0.5.3-validation-default-2026-10-12T01-09-11-432Z` 为 **193/193 通过**，0 失败、取消或跳过，Node 自然退出码 0，源码保持不变。最终离线记录 `general-0.5.3-validation-offline-2026-10-12T01-09-11-430Z` 自然退出码 0。

最终独立审计未发现 P0 阻断。完整运行记录及文件哈希由主代理汇总到当前证据包和清单。

指定独立库的原生 UI 记录 `general-0.5.3-ui-native-1791767589751.json` 通过桌面和移动 SDK 路径，移动输入策略只在移动入口启用。记录核验缩放组 64 px、页码输入 36 px、工具控件 32×28 px；插入图像／打印按钮隐藏后仍保留 DOM，但布局矩形为 0 且不可聚焦；缩放预设和页码行为正常。实际鼠标完成删除、撤销、撤销新建、重做、从“更多”手动保存；重开后双击移动批注，再次保存并重开，矩形位置有对应变化。真实 CDP 触摸在 Ink 工具（模式 15）活动时平移 110 px，未创建脏修订或批注存储变更，随后仍可触发工具栏；这是触摸自动化结果，不是 iPad 硬件验收。

`ipad-pointer-policy-1791767312635-32422.json` 的 Pencil 输入自动化进程自然退出码 0：覆盖 NONE 模式中 PDF 文本区域平移且不选择文本、兼容鼠标行为、轻触点击、工具激活后的 pen 绘制，以及 pen 与手指同时输入。该记录采用 Pencil／pen 模拟，不证明实际 Apple Pencil 事件投递；实体 iPad/Pencil 验收仍待用户完成。当前策略不声明压力感应、悬停、掌拒／掌形 AI 或 Scribble 支持。

加入 Pencil 输入路由前的早期 UI 基线为 191 项中 189 通过、2 失败，记录继续作为历史保留。加入 Pencil 路由后的首次修复前默认套件为 192/193，失败是清理／浏览器退出异常；对应离线原始 Node 退出码为 1，Chrome 子进程退出码为 2。上述原始失败状态没有重标为通过，也不替代当前最终候选结果。

[0.5.3 三文件候选](dist/pdf-web-reader-0.1general-0.5.3-candidate.zip) 含 `main.js`、`manifest.json`、`styles.css` 三个文件，SHA-256：`7e1b80709418a9ab3b1d3bae6d74120c113b3a2f422be44675baebd8d112f5cc`。其中 `main.js` SHA-256 为 `365755bccfe8d8887dcbd5c75aeccf84a64058846a6b69cf9e75e0e568611a4f`。

Mac 记录 `general-0.5.3-native-1791767610375.json` 显示：插件加载时在任何 Reader 打开前自动预热 **167 ms**，406 次 stat 检查、0 次缓存二进制验证读取、0 次解压；同一实例第二次 ensure 为 0 ms／0 次检查，首个 Reader 资源等待为 0 ms，工具可用约 125.1 ms；第二个 Reader 为 0 次资源检查、工具可用约 93.6 ms。外部修改刷新、实际鼠标脏批注与远端三身份合并、旧检查点保护、重复事件不重开，以及保留 90° 旋转和页宽的同 iframe 刷新均通过。此为 Mac 样本，不构成 iPad 性能承诺。最终 handoff 记录确认桌面启用、自动保存开启，Reader/view/gate 均为 0。

按授权，已将最终三文件安装到 `/Users/jiajia/Documents/Documents/Obsidian/远程仓库1/.obsidian/plugins/pdf-web-reader`。`general-0.5.3-target-replacement-1791767654581.json` 记录新文件与候选逐字节一致，旧 0.5.2 三文件备份在 `.deploy-backups/2026-10-12T01-14-14-542Z/remote-vault-1-three-files`；用户数据文件一致，未改动缓存、恢复文件、同步检查点或 PDF，也没有重载该库当前运行实例。保存并关闭 Reader 后重新加载插件；iPad 同步后确认版本 0.5.3。主分支推送由主代理另行完成并以 Git 历史为准；不创建 GitHub Release。

[0.5.3 验证与调查证据](dist/general-0.1general-0.5.3-evidence.zip)、[证据清单](dist/general-0.1general-0.5.3-evidence.manifest.json)与 [SHA-256 清单](dist/general-0.1general-0.5.3-SHA256SUMS.txt)随候选交付。证据包保留各次原始失败状态、驱动快照、源码差异及加入 Pencil 前的工具栏基线包。

## 历史：0.5.2 状态栏与工具栏调整（2026-10-12）

0.5.2 继续使用 Windows、macOS 与 iPadOS 共用的同一组三文件、编辑／保存／同步核心及各平台入口。此版本增加 **显示阅读器状态栏** 设置：默认关闭，旧设置没有该字段时也保持关闭。开关会立即应用于当前插件实例中的所有 Reader，包括弹出窗口，不重载 iframe；关闭时不创建状态栏 DOM 或占用布局空间。状态消息及可恢复同步错误的恢复按钮状态保留在 Reader 内部，重新显示状态栏时恢复。现有错误 Notice 和 **恢复最近的 PDF 自动保存副本** 命令继续可用；状态文本和 PDF 路径不进入诊断导出。

桌面／移动工具布局继续保留五个原生批注工具、鼠标中键工具轮盘和 **编辑** 的撤销、重做、删除、保存动作。单独的可点击 **工具** 轮盘按钮已移除。缩放控件使用 80 px 宽度，提供 `auto`、`1:1`、`↕` 适合页面高度和 `↔` 适合页面宽度预设。

0.5.1 的插件启用即预热和按大小／修改时间／创建时间索引跳过未变缓存资源保持不变；首次索引建立、旧／损坏索引或无法取得可信 stat 时仍完整 SHA-256 核验。0.5.2 不修改冻结 PDF.js Viewer 或升级既有依赖。最终冻结验证与候选哈希见下文。

Mac 原生验证仅使用 `/Users/jiajia/Documents/ObReader-Apple-Test` 的独立库和 loopback CDP endpoint `9230`。唯一获准的已安装文件替换目标是 `/Users/jiajia/Documents/Documents/Obsidian/远程仓库1/.obsidian/plugins/pdf-web-reader`，且只替换匹配的 `main.js`、`manifest.json`、`styles.css` 三文件；更新前备份旧三文件，保留设置、缓存、恢复文件及同步检查点。不得借此操作其他 Vault 或 PDF。Windows 与 iPad 实机确认仍以独立设备结果为准；iPad 硬件验收和最终安装由用户完成。

0.5.1、0.5.0 与 0.4.0 包及既有记录作为历史回滚参考保留。回滚前关闭 Reader 并备份完整插件目录；保留恢复副本和同步检查点，不将旧版本兼容性推断为已验证。

### 0.5.2 冻结验证与安装记录

Luna Max 子代理完成开发与独立审计，主代理负责整合、原生验证、打包和安装替换。最终冻结默认并发记录 `general-0.5.2-validation-default-2026-10-11T23-53-01-585Z` 共 **191 项：188 通过、3 失败、0 取消、0 跳过**，Node 自然退出码 1，源码和产物前后不变。两项失败是 `browser-test-cleanup.test.mjs` 中测试自身的关闭期限和子进程退出事件时序断言；第三项是工具栏功能断言完成后的 Chrome 子进程退出码 2。原始整套状态仍是 failed；所有产品功能断言已完成并通过，三项基础设施失败单独记录，不升级依赖、修复 teardown 或增加重复运行门槛。离线记录 `general-0.5.2-validation-offline-2026-10-11T23-53-01-587Z` 退出码 0。独立工具栏／本地化和真实鼠标回归各 1/1 通过；无 Node 启动、资源故障、缓存增量检查和预热包含在冻结默认验证中。

指定独立测试库的 `general-0.5.2-ui-native-1791763313988.json` 通过：实际设置界面开关即时更新两个 Reader，iframe 和打开请求不变；真实 popout 也同步显示／移除；隐藏时保留可恢复状态，重新显示后恢复按钮可调用恢复入口；重载后设置保留。Mac 移动模拟下确认移动入口、无桌面弹窗门禁、四个精简缩放预设和 125% 百分比、实际 80px 宽度、真实鼠标选择五工具、中键轮盘、绘制矩形及“编辑”菜单手动保存（宿主修订 2/2，磁盘包含批注）。恢复按钮调用采用隔离替身，避免读取／恢复测试库已有用户恢复副本；实际失败通知、恢复命令、状态消息不进入诊断的断言由宿主／无 Node 回归覆盖。窄窗口与 en-US、zh-CN 本地化稳定性由浏览器回归覆盖。结束恢复桌面、自动保存开启、状态栏关闭，Reader 为 0。

本轮早期原生 UI 驱动的失败 JSON 全部保留：移动模拟导致页面重载和执行上下文销毁、遗留测试布局、popout 执行时 Promise 被回收、隔离恢复替身计数未重置、错误期待无修改文档发出“已保存”状态，以及错误期待宿主在保存协议之前收到编辑修订。后两项改为验证真实鼠标绘制后的脏批注、磁盘写入和宿主确认；没有删除产品断言，也没有改动产品来配合测试。最终 UI 驱动与失败记录随证据包提供；这些早期驱动整套不记为通过。

`general-0.5.2-native-1791762827148.json` 与 `general-0.5.2-native-1791763337891.json` 均完成自动预热、第二个 Reader 复用、外部修改刷新、本地鼠标批注合并、已保存检查点抵抗旧版本覆盖、重复事件不重开和阅读状态保留。新适配层改变了资源版本，首次升级会准备新缓存一次；暖启动仍使用 0.5.1 增量索引。最终重载样本在打开任何 Reader 前，后台预热 **131ms**，406 次元数据检查、**0 次缓存内容核验读取、0 次解压**；同一实例再次准备 0ms，首个 Reader 资源等待 0ms，工具实际可用约 161.3ms。以上是 Mac 样本，不代表 iPad 实机性能承诺。`general-0.5.2-final-native-handoff.json` 确认最终三文件一致、桌面启用、自动保存开启及 Reader／view／gate 为 0。

已按明确授权只替换 `/Users/jiajia/Documents/Documents/Obsidian/远程仓库1/.obsidian/plugins/pdf-web-reader` 的三文件，旧三文件完整保留在 `.deploy-backups/2026-10-12T00-02-54-202Z/remote-vault-1-three-files`。记录 `general-0.5.2-target-replacement-1791763374259.json` 证明新文件与候选逐字节匹配、设置未变；没有写入该库的 PDF、缓存、恢复副本或同步检查点，没有请求重载其运行中的实例。使用中的实例需保存并关闭 Reader 后重新加载插件；iPad 同步／安装后应确认版本 **0.5.2**。Windows、macOS、iPadOS 使用同一个包，实际 Windows／iPad 验收仍待设备结果。

[0.5.2 三文件候选](dist/pdf-web-reader-0.1general-0.5.2-candidate.zip) SHA-256：`efd19502a5a7eaa9c16dd003c3ecbb10d4fcb88cb78d59b21187b006b77acdbb`。

| 文件 | SHA-256 |
| --- | --- |
| main.js | `177f1beb02c197113c881321b0d1835fae8abd7b3d82a90d681d2d14f0d393ad` |
| manifest.json | `c17a13380762b8780d82866457b5e78e5eb120e8eeb9381d03c3c68782253b88` |
| styles.css | `9dd5d3a26025cb83a7f68d63293fde69aec3bfbc7e9a5367f377853e11463650` |

[0.5.2 证据包](dist/general-0.1general-0.5.2-evidence.zip)、[证据清单](dist/general-0.1general-0.5.2-evidence.manifest.json) 与 [哈希清单](dist/general-0.1general-0.5.2-SHA256SUMS.txt) 保留原始成功／失败输出、审计、测试库备份与指定目录三文件替换记录。回滚使用备份的旧三文件，并保留既有设置、缓存、恢复副本和同步检查点。强退前未持久化编辑、设备时钟偏差和磁盘比较至写入之间的竞争窗口仍按既有说明保留；不创建 GitHub Release。

## 历史：0.5.1 iPad 重启缓存与预热修复（2026-10-12）

针对用户实测的 iPad 重启后等待 10–15 秒、等待一分钟也未改善的问题，后台资源预热改为插件启用后立即安排，独立于布局就绪回调和任何 Reader 的打开。布局就绪和回到前台仅作补触发；初始化任务共享，有界自动重试，并在既有诊断中记录预热状态、失败代号与资源计数。移动入口复用已经核验的模块字节，去掉同一模块的重复 SHA 计算。

`.complete.json` 增加绑定当前资源版本、路径、预期大小与 SHA-256 的文件元数据索引。缓存未变化时，每个文件只查一次大小、修改时间和创建时间，不读取并哈希全部 406 个资源；发生变化时，只对变化项读取内容、核验并按需解压修复。首次安装、旧版索引迁移、索引损坏或无法获取可信 stat 时，安全回退到完整核验。**首次升级建立索引会检查一次，之后重启才复用该索引。** 若修改字节时同时保留全部文件元数据，该快捷判断无法发现变化；实际用于启动的 HTML/CSS/模块字节仍按插件实例校验，显式 `forceVerify` 可完整核验。Viewer、同步合并核心、依赖版本及三端入口保持原样。

Luna Max 开发与独立审计完成。本轮针对缓存与预热的回归通过；最终冻结默认记录 `general-0.5.1-validation-default-2026-10-11T23-22-02-377Z` 为 188 项中 187 通过、1 失败、0 取消/跳过，源码不变。唯一失败是工具栏断言完成后的 Chrome 子进程退出码 2；原始整体状态仍为失败，按既有功能口径单独记录，不继续 teardown 调查。离线记录 `general-0.5.1-validation-offline-2026-10-11T23-21-36-567Z` 退出码 0；最终产物无 Node 移动启动、PDF/保存/重开与 Blob 回退均在完整默认验证中通过。

指定独立 Mac 测试库中，`general-0.5.1-native-1791760726809.json` 和 `general-0.5.1-native-1791760788761.json` 均通过，直接观察插件自动预热，在调用准备接口或打开首个 PDF 前 Reader 为 0。旧标记迁移核验 406 次；重载后缓存准备 182 ms、406 次元数据检查、0 次缓存内容核验读取、0 次解压，完整预热 444 ms。首个 Reader 的资源等待为 0 ms，实际工具可用约 129.9 ms（从 Viewer 打开请求起计）。这是 Mac 样本，不能替代 iPad 性能验收。新增移动预热单测明确覆盖布局回调尚未触发、没有打开 Reader、同时打开共用任务、失败自动重试、前台补试与卸载取消。

额外原生移动控件脚本 `native-mobile-controls-20261011232027296-3e0da847.json` 在打开后的首张 `Page.captureScreenshot` 超时，后续控件断言未执行，不能记为本轮原生移动控件验收通过；保留失败记录，不扩展 CDP 排查。清理已关闭自有 Reader、移除自有公开测试文件并恢复桌面与自动保存状态。iPad 实际重启加载由用户复验。

最新三文件已按用户明确授权替换到 `/Users/jiajia/Documents/Documents/Obsidian/远程仓库1/.obsidian/plugins/pdf-web-reader`，旧三文件备份为 `.deploy-backups/2026-10-11T23-24-34-904Z/remote-vault-1-three-files`。只替换三文件，不操作该库的 PDF、设置、缓存或恢复副本，也未主动重载该库的 Obsidian 实例。iPad 同步/安装后确认版本 0.5.1；首次建立索引完成后，再重启复验立即打开及等待一分钟后打开两种情况。

[0.5.1 三文件候选](dist/pdf-web-reader-0.1general-0.5.1-candidate.zip) SHA-256：`2a9ed0490f32b3dc1f4fa720f5842bd47ac75b74035062ca42688a9f1131a2d7`；`main.js`：`599debcf0751b4f5e082973d59b02b9b4bbfe209c9211f475ef0ea4749122c0b`。[0.5.1 启动修复证据](dist/general-0.1general-0.5.1-evidence.zip) 保留默认/离线原始输出、原生自动预热、移动脚本失败与替换备份记录；[证据清单](dist/general-0.1general-0.5.1-evidence.manifest.json) 与 [哈希清单](dist/general-0.1general-0.5.1-SHA256SUMS.txt) 随包交付。旧 0.5.0、0.4.0 包保持可回滚；不创建 Release。

## 历史：0.5.0 交付

基于 `ad05bb1`，Windows、macOS、iPadOS 使用同一组三文件和共用编辑、保存、合并核心。桌面使用资源 URL 与弹窗协调；移动使用经校验的模块／Worker 入口。冻结 Viewer 的 402 个文件未改动；运行时共 406 项，新增浏览器合并 Worker 与完整依赖许可证。仅新增锁定 `pdf-lib 1.17.1`，没有升级既有依赖。

## 0.5.0 行为与边界

插件在布局就绪后后台准备资源，不强制加载隐藏的 DeferredView。文件处理最多四项并行；已有缓存先校验，只有缺失或损坏项才解压修复。成功结果与校验后的文本、模块字节在本次插件实例中共享，多个 Reader 不再重复全量解压、验证。重新加载插件仍重新验证磁盘缓存。大小、SHA-256、写后校验、完成标记保留。

当前打开的 PDF 通过公开 `vault.modify`、前台与 Reader 激活补查发现同步。无本地操作且无本地检查点时直接刷新远端版本；存在本地操作或已确认的本地检查点时自动合并。整条批注按有效编辑完成的 UTC 时间、逻辑序号、设备与操作 ID 排序；删除记录保留，重复通知不会反复写回。UUID 与合并记录在 PDF 内，标准 `/NM` 保持原值。新编辑器按冻结 writer 的实际逐页序列、类型、数量与输出对象差集精确绑定，避免用坐标或文本猜测。

同一个 Viewer 内刷新，保留页码、缩放、旋转、阅读位置和工具；旧文档撤销栈不跨刷新复用。绘制、拖动、擦除及组合输入先到安全边界；新修订会拒绝旧合并结果。串行写入前保存恢复副本、复核磁盘，写后读回验证。页面内容或顺序改变、身份无法证明、加密或损坏时暂停自动合并并提供恢复入口。设备时钟偏差会影响最新判断；磁盘比较与写入之间的竞争窗口、强退前未持久化编辑及恢复目录写入失败仍有限制。

## 0.5.0 验证、安装与回滚

本轮只执行受影响回归和一次冻结后的完整默认并发验证；产品断言必须实际完成并通过。单纯 Chrome/Puppeteer 退出异常保留原始状态，单独记录为测试基础设施问题，不恢复已撤回的重复运行门槛或继续 teardown 调查。Mac 原生操作仅允许 `/Users/jiajia/Documents/ObReader-Apple-Test`；Mac 移动模拟不替代实际 iPad 启动耗时、WKWebView、鼠标按键或跨设备同步证据。Windows 和 iPad 实机仍待用户验收。

安装前保存并关闭 Reader，禁用插件并备份完整 `.obsidian/plugins/pdf-web-reader/`。仅替换候选包的 `main.js`、`manifest.json`、`styles.css`，保留设置、旧恢复副本和同步检查点。测试库内首次启用后后台预热；用户主库和公开 Release 不在本轮范围。回滚时恢复完整插件备份或下方保留的 0.4.0 三文件包，继续保留 0.5.0 的恢复副本。旧版不解析新合并记录，不使用旧版向正在跨端协作的文件继续写入。

最终冻结默认验证 `general-0.5-validation-default-2026-10-11T22-24-08-617Z` 共 168 项：167 通过、1 失败、0 取消、0 跳过，源码及产物哈希前后不变，Node 自然退出码为 1。唯一失败发生在工具栏功能断言全部完成后的 `attachCleanupErrors`：已正常调用页面和浏览器关闭，但 Chrome 子进程以退出码 2 结束，无强制终止信号。原始报告仍为 `failed`；这项纯退出异常按已选口径单独记录，不改写为整套正常通过，也不继续 teardown 调查。全部产品功能断言完成并通过，本候选达到当前功能验收口径。

最终离线验证 `general-0.5-validation-offline-2026-10-11T22-23-40-242Z` 退出码 0、源码不变，完成五工具、保存重开及离线资源检查。完整默认验证也通过无 Node 的最终产物移动入口、资源 URL 与 Blob 回退、资源故障、共用合并核心、宿主同步队列和 Viewer 生命周期回归。

先前默认记录 `general-0.5-validation-default-2026-10-11T22-09-12-032Z` 的 5 项保存确认超时与先前离线失败没有完成产品断言，仍原样保留。这些旧端 harness 不回传新代次字段的 ACK 被严格过滤；修复仅允许旧的保存／恢复终端 ACK 省略该字段，显式错误代次依旧拒绝，并把代次加入请求 ID，保持精确文档、请求、修订关联。新的 `sync-*` 协议仍严格校验代次。最终相关回归通过；未把旧超时归为 Chrome 退出问题。

Luna Max 开发与独立审计检查了共用核心、UUID 与 writer 精确绑定、检查点、平台边界和最终包；未发现剩余的已审计产品 P0。审计还修复了真实 SDK 的 `EditableFileView.syncState` 方法被字段遮蔽、间接流 `/Length` 重写导致无损检查点误判，以及自写入通知先于保存 ACK 时错误暂停同步的问题。失败诊断、公开测试 PDF 检查点及最终哈希一并归档。没有恢复重复运行门槛，没有升级既有依赖。

### Mac 实测与同步证据

最终产物 `main.js` SHA-256 为 `e81b82a978aa4936acf1f2424fa87956f7853c784033c61add6fef51933f7d3d`。指定测试库使用相同的公开两页测试 PDF；下列值来自最终包的原生 Obsidian，不能外推为 iPad 性能承诺。

| 条件 | 资源准备 | 解压 / 校验文件 | 模块启动 | PDF 解析 | 实际工具可用 |
| --- | --- | --- | --- | --- | --- |
| 更新后冷缓存后台预热 | 7,364 ms | 406 / 406 | — | — | — |
| 插件重载后已有磁盘缓存 | 584 ms | 0 / 406 | — | — | — |
| 同一插件实例再次准备 | 0.1 ms | 0 / 0 | — | — | — |
| 预热后首个 Reader | 0 ms | 0 / 0 | 51 ms | 101.8 ms | 133.4 ms |
| 第二个 Reader | 0 ms | 0 / 0 | 54 ms | 91.3 ms | 127.0 ms |

冷缓存记录为 `general-0.5-native-1791757358605.json`，磁盘缓存及预热后记录为 `general-0.5-native-1791757407191.json`。工具耗时从 Viewer 收到当前打开请求起计，以当前 PDF、实际连接的批注层及全部五工具启用为条件；资源、模块、解析和工具指标起点不同，不能相加成总耗时。首次升级会准备新资源版本，仍可能等待数秒；之后的 Reader 不再重复整套处理。

两份原生记录均完成无本地编辑的自动刷新、真实鼠标创建本地 Square 后与两条远端批注合并、已保存本地检查点抵抗旧端版本覆盖、重复通知不重开，以及页码、旋转、缩放与同一 iframe 代次检查。最终 Mac 移动模拟 `native-mobile-controls-20261011222302760-e448ba4f.json` 完成工具轮盘点击、真实鼠标绘制、撤销重做、手动保存、重开后可见和磁盘字节一致，Node 退出码 0；结束恢复桌面模式、自动保存开启、Reader 为 0。失败的后台窗口渲染记录仍归档；最终复验使用既有原生测试的 CDP 焦点模拟，不代替真实设备事件投递。

### 候选文件与实机检查

| 文件 | SHA-256 |
| --- | --- |
| [0.1general 0.5.0 三文件候选](dist/pdf-web-reader-0.1general-0.5.0-candidate.zip) | `32354f8dcb5f4dd271b7214781caffcb00d2a85dd9b2d9df0ebbf1178a3ef804` |
| ZIP 内 `main.js` | `e81b82a978aa4936acf1f2424fa87956f7853c784033c61add6fef51933f7d3d` |
| 保留的 [0.4.0 回滚包](dist/pdf-web-reader-0.1general-0.4.0-candidate.zip) | `4e50caece1b50bee70caf493b298f980f8da8ff8449cc2c5102939eb56264e98` |

[源码差异](dist/general-0.1general-0.5.0-source.diff)、[本轮证据包](dist/general-0.1general-0.5.0-evidence.zip)、[逐文件证据清单](dist/general-0.1general-0.5.0-evidence.manifest.json)、[交付哈希](dist/general-0.1general-0.5.0-SHA256SUMS.txt) 随候选保留。证据包含失败轮次、最终结果、原生耗时、移动模拟、审计与部署记录；不包含用户 PDF、旧恢复副本内容或个人库快照。

Windows、macOS、iPadOS 实机均使用同一 0.5.0 三文件包，在各自独立测试库操作；Windows 和 iPad 最终实机确认由用户执行。除 [既有鼠标与五工具清单](IPAD_ACCEPTANCE.md#three-platform-actual-device-checklist) 外，使用同一测试 PDF 检查：

1. 记录首次安装、重载、后台预热后和第二个 Reader 的实际工具可用时间。
2. 两端分别新增不同批注，等待实际文件同步，确认已打开的两端自动出现完整批注；再测试双方先保存、离线编辑后同步和重复通知。
3. 两端编辑同一条已同步批注，确认整条批注按编辑完成时间排序；测试删除与编辑两种先后关系。记录设备时钟偏差，不以同步到达顺序判断胜者。
4. 同步时继续输入、绘制或拖动，确认当前操作结束后刷新，阅读位置和工具保留；刷新后重新验证双击编辑、撤销重做及保存重开。
5. 外部修改页面内容、写入失败或无法确认身份时，确认自动覆盖暂停并可进入恢复副本；不要删除恢复目录来绕过异常。

测试库更新前关闭 Reader 并完整备份。原 0.4.0 插件目录备份为 `.deploy-backups/2026-10-11T21-58-48-580Z/pdf-web-reader`；最终更新继续保存完整备份，并按字节保留原有 50 个恢复文件、设置及当前同步检查点。用户主库未操作，不创建 GitHub Release。

## 历史：0.4.0 交付记录

目标是 Windows、macOS 和 iPadOS 共用同一源码、核心功能和三文件插件，通过各自平台入口运行。起点为 `40b1f09`，已包含 Windows `c52e522` 和 macOS `1034e0e`。本文件按用户最新决定记录 0.1general／插件 0.4.0 候选的验收范围。

## 核心与平台入口

资源校验、五工具、Pointer Event 鼠标行为、文档身份、修订确认、串行保存、冲突暂停及恢复副本共用。Windows/macOS 使用桌面资源入口与弹窗协调；iPad 使用移动模块和 Worker 入口，不安装桌面弹窗协调。平台入口在插件加载时固定；改变 Mac 的移动模拟状态后必须重新加载插件。

运行时只使用 Obsidian、标准浏览器 API 与内嵌 SHA-256；Node/npm 仅用于构建和测试。完整冻结 Viewer、离线三文件分发、`isDesktopOnly: false`、插件 ID、设置及既有恢复记录保持兼容。鼠标行为由实际 pointerType、按键和浏览器能力决定，工具、编辑、保存及诊断均有可点击入口。

## 当前验收口径

用户已撤回原“十次默认并发、连续三次旧版全套”及基于浏览器自然退出状态的门槛。当前口径要求一次源码冻结后的完整默认全套中，所有产品功能断言实际执行并通过，并在 `/Users/jiajia/Documents/ObReader-Apple-Test` 指定 Mac 测试库完成独立功能核验。测试进程的 watchdog、强制关闭或纯清理／退出状态异常单独归入测试基础设施记录，在功能断言完整通过时本身不阻断候选评估。不得把未执行、跳过或因异常中断的产品功能断言记为通过；真实用户可见 P0 功能阻断才是当前阻断项。

当前状态：冻结默认全套和指定 Mac 测试库的产品功能核验均已通过修订后的功能验收口径。Windows 与 iPad 实机验收仍待设备检查；iPad 最终安装由用户执行。本候选通过本地功能口径，按用户授权正常推送 `main`；不创建 Release，不部署用户主库。实际提交以 Git 历史为准；指定 Mac 测试库之外不做原生操作。移动模拟、可信 CDP 鼠标事件和无 Node 浏览器检查不替代 WKWebView 或实际操作系统按键投递证据，清单见 [三平台实机验收清单](IPAD_ACCEPTANCE.md#three-platform-actual-device-checklist)。

## 冻结默认全套与候选文件

`tests/artifacts/general-validation-default-2026-10-11T20-32-33-875Z` 是源码稳定时的完整默认全套记录：133 项中 131 通过、2 项因测试进程清理异常失败，Node 退出码 1、信号为空。`desktop-toolbar` 在外部信号后被强制清理，FreeText 子进程以退出码 2 结束。所有产品功能断言均已完成并通过；这两项测试基础设施退出状态不推翻功能结果。

本地冻结候选与校验值：

| 文件 | SHA-256 |
| --- | --- |
| [0.1general 插件 0.4.0 候选 ZIP](dist/pdf-web-reader-0.1general-0.4.0-candidate.zip) | `4e50caece1b50bee70caf493b298f980f8da8ff8449cc2c5102939eb56264e98` |
| [修订版 0.3.0 iPad 候选 ZIP](dist/pdf-web-reader-0.3.0-ipad-mouse-revised-candidate.zip) | `358e4286e7e06fb3e57d1279d4d3db167a931bc829c796b2ecbf81532f1c1d83` |
| 两个 ZIP 内的 `main.js` | `201ceee6cb7b713df3d2277e6d9934565b04661779e541e715c8a093163fb2cb` |

指定 Mac 测试库的功能验收已完成；当前记录不代表 Windows 或 iPad 实机通过。候选按用户授权正常推送 `main`，不创建 Release，也不部署用户主库；实际提交以 Git 历史为准。

## 指定 Mac 测试库功能证据

`/Users/jiajia/Documents/ObReader-Apple-Test` 的 `native-macos-lifecycle-20261011203625445.json` 报告记录 19/19 场景完成，Node 自然退出码 0。移动入口的 `native-mobile-controls-20261011203945627-a7862f73.json` 已完成全部产品功能操作和断言：可信鼠标创建 Square、撤销／重做、手动保存、重开后可见以及 PDF 字节一致。该报告的整体状态是 `incomplete`，Node 退出码 1：功能操作之后，在 `finally` 恢复 `emulateMobile(false)` 时收到 `Protocol error (Runtime.callFunctionOn): Promise was collected`。因此保留清理异常，不能称这份脚本报告整体正常通过；按修订口径，这项功能后清理异常不推翻已经完成并通过的功能断言。

`general-final-native-handoff.json` 于 `2026-10-11T20:41:12.893Z` 在唯一指定 Vault 中记录状态 `passed`：版本 0.4.0、桌面模式、插件启用、自动保存开启、Reader／View／gate 均为 0；未触碰主实例，物理 iPad 未验证。测试自有 popout leaf 已清理，插件保持 desktop false/mobile false；32 个旧恢复文件经字节核对保持不变。

归档证据：[0.1general 证据包](dist/general-0.1-evidence.zip)、[证据清单](dist/general-0.1-evidence.manifest.json)、[源码差异](dist/general-0.1-source.diff)。证据包共 63,415,082 字节、847 个文件，SHA-256：`98f9867d5ce798809c863ad8331a8284d1f5e322c14d4d77a8076f680c24ef49`；清单 SHA-256：`d1ef015dd459e2da9fbfdec35fa7e5a3e659222150c10b85572b92283181bc30`。

## 历史验证记录

此前 17 轮默认并发及其 Chrome/Puppeteer/Crashpad/CDP 诊断均为历史证据；不再扩展浏览器根因调查或升级依赖。历史 0.3.0 默认并发 92/95 的失败日志和截图继续保留。第 18 轮的当前记录与候选校验值见上节。

第十四轮 `general-validation-default-2026-10-11T20-01-03-234Z` 使用同版本 Chrome for Testing 和 TEMPDB 单变量诊断，129 项中 127 通过、2 失败、0 取消、0 跳过；桌面工具栏和 FreeText 两项遇到 Chrome teardown watchdog，浏览器退出码 2，清理随后向已验证进程组发送 SIGTERM。Crashpad 数据库目录变化没有证明修复。

第十五轮 `general-validation-default-2026-10-11T20-09-58-366Z` 为显式 Worker 关闭诊断，133 项中 129 通过、4 失败；FreeText 当前 Worker 完整销毁后仍自然退出 2，另有工具栏、鼠标退出和清理单测调度假设问题。

第十六轮 `general-validation-default-2026-10-11T20-15-22-264Z` 为提前 500 毫秒采样的显式诊断，133 项中 132 通过、1 失败；FreeText 正常退出但采样文件缺失，鼠标测试仍自然退出 2。

第十七轮 `general-validation-default-2026-10-11T20-27-18-240Z` 在源码稳定时运行了 133 项，128 通过、5 失败，Node 自然退出 1、无信号。产品功能断言通过；失败记录为 annotation、toolbar、openLifecycle 的 Chrome teardown watchdog（自然退出 2）、FreeText 的强制进程组清理，以及独立的 Process fixture 单测。500 毫秒采样没有阻塞关闭；栈采样均超过 8 秒、未启动或没有可用栈，不能据此声称取得了有效线程栈。上述进程和清理问题保留作基础设施历史证据，不标记为产品功能失败。

`browser-test-launch` 的六项假启动测试覆盖测试启动、Crashpad 目录及所有权／清理记录，只验证测试基础设施，不代替产品功能或指定测试库核验。

## 安装、实机验收与回滚

本地冻结的 0.4.0 候选 ZIP 已生成，校验值见上表；默认全套和指定 Mac 测试库功能核验已按当前口径完成。以下步骤仅适用于独立测试库，不适用于用户主库；历史 0.3.0 ZIP 不是当前候选。

1. 在独立测试库保存并关闭所有 Reader，禁用插件，备份完整 `.obsidian/plugins/pdf-web-reader/`，包括设置、缓存和恢复副本。
2. 在指定测试库使用冻结候选 ZIP 时，仅替换 `main.js`、`manifest.json`、`styles.css`。完全退出并重新打开 Obsidian，确认插件版本 0.4.0 后启用；无需安装额外运行依赖。此候选包不是公开发行版。
3. 在独立 Windows 测试库核对默认 PDF 路由、五工具、Ctrl+S、自动保存、保存重开后双击二次编辑、多视图、改名、右键菜单不误创建批注／拖动擦除、中键轮盘、滚轮及弹出窗口。Windows `c52e522` 只是修复右键菜单延迟选中文字时误生成批注；普通右键仍是菜单交互，没有新增右键创建批注功能。故障时核对冲突暂停、恢复副本和关闭行为。
4. macOS 仅使用上述独立测试实例执行桌面清单，将快捷键改为 Cmd+S，并检查窗口迁移与关闭。指定测试库的当前功能结果和清理状态见上文；移动控件脚本的 `finally` 清理异常不改写其完整通过的功能断言，也不记为整个脚本正常退出。
5. iPad 最终安装由用户在独立测试库执行；按 [三平台实机验收清单](IPAD_ACCEPTANCE.md#three-platform-actual-device-checklist) 检查真实 WKWebView、离线启动及外接鼠标。历史 iPad 专项矩阵保留在同一文档。
6. 记录实际设备、系统、Obsidian 版本及鼠标配置；系统没有投递到 WebView 的中键或右键事件不能标为通过。出现问题先导出诊断，再禁用插件并恢复完整备份。保留旧恢复副本，不通过删除它们绕过错误。

本轮不扩展 Pencil 压感、手写识别或触控专项手势。强退前未持久化的编辑、恢复目录自身写入失败以及磁盘比较与写入之间的竞争窗口仍有局限。本候选按用户授权正常推送 `main`；不创建 Release，不部署用户主库。实际提交以 Git 历史为准。
