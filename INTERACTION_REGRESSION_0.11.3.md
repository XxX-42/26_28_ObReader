# 0.11.3：交互失败修复记录

基线：`d2ce228b6de9f7a5030c3c5534ba2e1b5a33d6b1`。
工作分支：`codex/vocab-state-empty-result`。
开发检出：`/private/tmp/obreader-vocab-state-semantics`；原始工作区的未提交工作未带入或覆盖。

## 产品修复

Viewer 桥接 CSS 修复：

- NONE 模式下让已有的 Ink/Square 和非空 FreeText 接收点击；整页编辑层仍然透传空白区域。
- 已选中的 FreeText 在创建优先层中继续接收后续双击；其他对象和空白区域仍保留工具创建优先级。

另修复 `applyLegacyAnnotationIdentities()`：将经过来源确认的 UUID/ref/page/kind 同时写入已有运行时身份缓存，供 unchanged native editor 的 Undo 捕获使用。缓存冲突仍 fail closed，重复确认幂等。否则旧批注删除后撤销虽恢复了编辑器，却可能再次保存成 tombstone。

没有修改 PDF.js vendor、Pencil/Finger 输入算法、WebKit 原生滚动、批注 UUID 生成、保存保护或 WAL/Sidecar/Format 3 存储模块。插件版本延续为 0.11.3。

## 六项测试的根因与处理

| 测试 | 根因与处理 |
|---|---|
| annotation-interaction | 已有外置 Square 在 NONE 模式被整层命中禁用；修复子编辑器命中，保留创建优先级断言。 |
| mouse-input | 同一命中缺陷，随后暴露出测试重绘观察竞态，以及 Puppeteer 25 `click()` 忽略 `clickCount` 参数；原子捕获已完成渲染状态，使用真正的第二次双击 down/up。保留编辑同 UUID、无重复对象及缩放后编辑断言。 |
| sidecar-freetext-geometry | macOS 测试错误使用 Ctrl+Enter；按 PDF.js 平台规则使用 Cmd+Enter，其他平台仍使用 Ctrl+Enter。原几何和重开断言保留。 |
| free-text-undo-appearance | 旧宿主没有完成来源确认，仍按普通保存接收 PDF bytes；改为精确操作批次 ACK，显式导出一次建立不可变 AP 测试底本，并提供经 inspect 验证的原对象引用身份。同时修复已确认 legacy identity 未进入 Undo 捕获缓存的真实缺陷。保留像素级 AP 擦除、撤销、重做和保存重开验证。 |
| ipad-pointer-policy | 旧后台断言要求插件停止浏览器原生惯性；改为验证插件没有自定义惯性、残留手势或后台 JS 滚动写入。保留可信 flick 正在滚动的前置条件。第二 Reader 的 PDF.js 历史位置恢复使固定 page-1 坐标落在视口外；显式定位测试页，等待工具层实际可见，并核验 Pencil/finger 的坐标命中。 |
| sync-bridge | 旧测试要求日常保存/检查点返回 PDF bytes 并允许二进制覆盖，与不可变 PDF 架构相反；迁移为操作快照、精确持久 ACK、同 UUID 编辑/删除/撤销重做、墓碑重开、旧会话拒绝、远端水合和关闭恢复。二进制验证仅走显式 export-copy，保留跨页 Square/Ink 输出及底本 SHA-256 不变验证。原生测试批注补齐可见描边 /C，避免把无颜色的不可见注释用作编辑器绘制样本。 |

这些是测试协议和真实输入前提的修正，不恢复已经废除的二进制日常保存，也不放宽保存完整性校验。旧二进制同步的宿主取消/超时边界仍有 `pdf-sync-host.test.mjs` 覆盖。没有增加超时、跳过失败用例或改成无条件成功。

## 验证记录

首轮诊断全量：774 项，771 通过、3 失败、0 跳过；保留为失败记录，不计作最终验收。

最终冻结源码的默认并发全量执行两次：

- 第一轮：774 项，772 通过、2 失败；为触摸模拟事件迟到超过原 80ms 窗口，以及原生滚动中断时序断言。保持源码不变隔离执行这两项，2/2 通过。
- 第二轮：774 项，771 通过、3 失败、0 取消、0 跳过。原六项交互回归全部通过。剩余项为 `browser cleanup accepts a verified natural exit within the existing process-exit grace`、`targeted async process queries allow child exit events and accept an empty exited group`、以及下划线功能断言完成后 `browser.close` 超过既有 5000ms 清理期限。原始全量结果仍为失败；没有修改清理代码或门槛，没有继续发散调查 Chrome teardown。
- 原六项另有独立通过证据；选择差异回归通过，身份缓存/外置桥接单元回归 18/18 通过。
- `npm run build` 成功：严格三文件、406 个嵌入运行资产、402 个冻结 vendor 文件 SHA-256 校验通过。
- `npm run test:offline` 通过：五工具、外置操作保存重开、批量删除不复活、普通浏览器退出。
- 已检查批注交互和 FreeText 最终截图；FreeText canvas ROI 在撤销与最终重开后与底本基线一致（fingerprint `39f6d937`，`differentPixels=0`），最新持久操作为同 UUID/ref 的 `deleted:false`。显式 AP 导出建立测试底本后，后续源字节 SHA-256 保持一致。

原始日志：`/tmp/obreader-six-full.log`、`/tmp/obreader-six-final-full.log`、`/tmp/obreader-six-final-full-2.log`、`/tmp/obreader-six-final-timing-recheck.log`、`/tmp/obreader-six-final-build.log`、`/tmp/obreader-six-final-offline.log`。发布时将日志与关键 JSON/截图复制至库外备份目录；不将证据 ZIP 重新放入 Git。

安装只替换备份后的 `main.js`、`manifest.json`、`styles.css`，不改源 PDF、个人词汇或外置批注数据；安装报告记录实际加载版本和三文件校验和。

真实 iPadOS/WKWebView 未在本轮接入；Chromium 的可信触摸/模拟 pen 证据不等同于实机验收。
