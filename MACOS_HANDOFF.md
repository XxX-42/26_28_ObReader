# PDF Web Reader 苹果平台开发交接上下文

本项目将带自定义批注功能的 Mozilla PDF.js Viewer 集成到 Obsidian 插件。当前可用基线是 Windows 桌面版插件 0.1.4；下一阶段目标是 macOS 桌面和 iOS/iPadOS，继续保留离线运行、三个发布文件、正常打开 PDF，以及下划线、矩形框、荧光笔、自由画笔、文字框五种功能。

接续开发者应先理解现有实现和验证边界，再进行 Apple 平台移植。不能仅修改 manifest 后宣称移动端适配完成，也不能用 Safari 普通网页或 Chromium 的移动模拟替代原生 Obsidian 验收。

## 接续任务与交付边界

- 用户决定将 Apple 适配开发接续到 macOS；Windows 留作回归环境。
- 最新产品代码基线：`85da5549df4912300fe80191ed26a7f14a860aa4`，插件版本 `0.1.4`。
- GitHub 仓库：<https://github.com/XxX-42/26_28_ObReader>；当前产品分支是 `main`。
- 此交接文件在产品提交之后单独提交；克隆最新 `main`，不要停在旧版本提交。
- Apple 适配尚未实施。当前 `isDesktopOnly: true` 和 Windows 已通过的功能必须保持真实、可追溯。
- 用户此前明确指定 Luna Max 子代理进行具体开发和审计；已有 Apple 审计由三个 `gpt-6-luna`、`max` 推理子代理完成。需要新子代理时遵循接续会话的工具能力、用户授权及指令，不假设某个模型别名必然存在。
- 适配交付应包含明确的支持版本、同一组三文件产物、平台验证证据及未解决项。不得把“能显示首屏”当成“五工具完整可用”。

## 项目来源与历史决策

项目最初是本地 PDF.js Web 阅读器，使用 `http://localhost:8888/web/viewer.html`。Windows 曾有 `PdfJsLocalViewer.exe` 跳转启动器，接收 PDF 路径，启动本地服务并用默认浏览器打开 Viewer；系统 PDF 文件关联也曾调整过。

随后用户要求迁移为独立 Obsidian 插件。插件路线已经摆脱上述启动器、本地服务和外部浏览器。Apple 移植应该继续这个架构，不需要复刻 Windows EXE 或设置 macOS 系统级 PDF 默认应用。

用户最初要求新增下划线和矩形框，并把快捷键调整为 `1–5`。原 PDF.js fork 已包含这些编辑器及标准 PDF 保存支持；Obsidian 仓库冻结了完整的 `generic-legacy` 构建资源，再增加宿主适配和两个交互修复。

发布方式曾从包含整个 `viewer/` 文件夹改为三个文件。用户明确要求完整资源内嵌 `main.js`，运行时在本地按版本释放。**三个文件限制是发布资产限制，不是插件运行后磁盘只能存在三个文件。**

## 仓库与旧机器路径

以下 Windows 路径仅用于识别历史环境，不是 macOS 运行时路径，不应复制进新平台代码。

| 用途               | 原位置                                                                | 接续要求                                                                                        |
| ------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 当前插件开发仓库   | `D:\Documents\Codes\2026_7_PdfWebReader\2026_7.1_Mozilla_fork-ob`     | 在 Mac 用户指定目录克隆同一仓库，所有新开发在该克隆内完成                                       |
| 原 PDF.js 源码仓库 | `D:\Documents\Codes\2026_7_PdfWebReader\2026_7.1_Mozilla_fork\pdf.js` | Windows 分支 `windows`，基线 `c80e5a95250f4e5548173be813bd1f71fe3c040c`；不自动修改或重新构建它 |
| Windows 测试库     | `D:\Documents\Obsidian\测试插件`                                      | 是测试环境，不是默认 Mac 目标库                                                                 |
| Windows 已安装插件 | `<上述测试库>\.obsidian\plugins\pdf-web-reader`                       | Mac 的测试库路径需要由用户指定                                                                  |
| Windows CLI        | `D:\Applications\Obsidian\Obsidian.com`                               | 不适用于 Mac；CLI 是可选测试工具，不是插件依赖                                                  |

原源码仓库在交接前检查为干净。Mac 完成插件适配不要求拥有这个 Windows 路径：所需冻结 Viewer、测试 PDF 和桥接源码均在当前插件 Git 仓库中。

## Git 基线

| 提交或标签                                 | 内容                                     |
| ------------------------------------------ | ---------------------------------------- |
| `44ad5dc` / `full-viewer-0.1.1`            | 保存包含完整 Viewer 文件夹的迁移基线     |
| `0d8900a` / `0.1.2`                        | 三文件离线发布，完整资源内嵌及版本化释放 |
| `25afe28c564ccfdf086a22c582cf2f9a5c1757a5` | 修复文字选区生成平行双下划线，版本 0.1.3 |
| `85da5549df4912300fe80191ed26a7f14a860aa4` | 修复旧批注拦截二次标注，版本 0.1.4       |

0.1.4 已推送 `origin/main`。本次交接不以创建 GitHub Release 或新标签为前提；不要把 Git 推送、插件版本号、Git 标签和 GitHub Release 混为一谈。

2026 年 10 月 8 日补充了 `test-vault/测试插件/` 测试库快照。60 个文件包括原配置、已安装 0.1.4、38 份测试 PDF、笔记、图片及历史内层欢迎库；原 `.asset-cache` 未复制，内嵌资源会在首次打开时重建。阅读 `test-vault/README.md` 和 `test-vault/SNAPSHOT.json`，将外层测试库复制到 Mac 用户指定的独立位置使用，不要误开内层同名文件夹。快照不包含未保存编辑或应用账号状态，也不表示 Apple 原生验收已完成。

## 当前功能合同

插件 ID 是 `pdf-web-reader`，自定义 View 类型是 `pdf-web-reader-view`。当前 manifest 的最低 Obsidian 版本为 `1.14.4`，`isDesktopOnly` 为 `true`；这是已使用的桌面基线，不是已确定的 Apple 最低系统版本。

| 按键 | 工具     | 编辑器类型值 | PDF 批注类型 |
| ---- | -------- | ------------ | ------------ |
| `1`  | 下划线   | `10`         | `Underline`  |
| `2`  | 矩形框   | `5`          | `Square`     |
| `3`  | 荧光笔   | `9`          | `Highlight`  |
| `4`  | 自由画笔 | `15`         | `Ink`        |
| `5`  | 文字框   | `3`          | `FreeText`   |

- 顶部工具栏保留上述五种工具及原有其他工具。下划线依赖真实 PDF 文字层；无文字扫描件不会凭空产生文字选区。
- 主键盘和数字小键盘都映射 `1–5`。再按当前工具退出，反引号也退出；输入框和可编辑文本中数字不切换工具。快捷键切换不应自动展开参数面板。
- 下划线和矩形采用独立参数，不能与 Ink 默认颜色、线宽互相污染。需保留标准 PDF 批注语义，保存重开后再次编辑不得产生重复对象。
- 启用插件后，Obsidian 中普通 PDF 文件打开走本插件。已存在的核心 PDF 标签页不会被强制替换；关闭重开即可。
- Markdown 内嵌 PDF 仍由 Obsidian 核心显示。插件不改变 Windows/macOS/iOS 系统级 PDF 文件关联。
- 保存目前是手动操作：Viewer 的保存入口或收到 `Ctrl+S` / `Cmd+S`。保存覆盖当前 Vault PDF，并检查磁盘内容是否与打开/上次保存的基准一致。
- 不要关闭、禁用或热重载带未保存批注的视图。关闭或重载不是保存。

## 源码与资源入口

```text
plugin/
  main.js                         Obsidian 宿主、PDF 路由、自定义 View、保存
  asset-runtime.cjs               内嵌资源校验、解压、释放和缓存修复
  manifest.json                   与根 manifest 同步的输入元数据
  styles.css                      Obsidian 外层视图样式
viewer-adapter/
  obsidian-bridge.js              iframe 与 Obsidian 宿主之间的消息协议
  bridge.css                      Viewer 嵌入样式与只读样式
vendor/pdfjs-generic-legacy/
  build/pdf.mjs                   display/core API 包与自定义编辑器
  build/pdf.worker.mjs            PDF 解析、解码、保存等 Worker 实现
  build/pdf.sandbox.mjs           保留的脚本资源，当前文档脚本功能关闭
  web/viewer.html                 完整 Viewer DOM 与工具入口
  web/viewer.mjs                  Viewer 应用、快捷键及 UI 逻辑
  web/viewer.css                  Viewer、批注层、工具栏与编辑器样式
  web/{cmaps,iccs,standard_fonts,wasm,locale,images}/
  SHA256SUMS.json                 402 项冻结资源的哈希清单
  PROVENANCE.md                   来源与两个本地修复说明
scripts/
  build.mjs                      构建三个发布文件
  hash-vendor.mjs                冻结资源校验及显式更新清单
  deploy.mjs                     部署到测试库并备份旧插件
tests/
  fixtures/tracemonkey.pdf        已跟踪的测试 PDF，不用用户原件做写测试
  *.test.mjs                     单元、打包、宿主和浏览器回归
  offline-smoke.mjs               三文件离线功能验证
  native-*.mjs                    Windows 原生 Obsidian 验证脚本
dist/pdf-web-reader/
  main.js
  manifest.json
  styles.css
```

`vendor/` 是完整冻结构建产物，不是可任意用上游最新版替换的普通依赖。它包含 fork 的 Underline/Square 编辑器。替换为 npm 上游 PDF.js 或 Obsidian 私有 PDF.js，会丢失自定义行为或引入版本不匹配。

当前仓库直接使用可读的 vendor bundle 作为生产输入。修改 vendor 后必须同步 `PROVENANCE.md`、哈希清单、相关测试并重新构建；不能只改 `dist/main.js`，下一次 build 会覆盖它。

定位自定义编辑器时，搜索 `DrawingEditor`、`InkEditor`、`ShapeEditor`、`SquareEditor` 和 `UnderlineEditor`。当前继承链是 DrawingEditor → InkEditor → ShapeEditor → Square/Underline，故 Shape 的 DOM 也可能带 `.inkEditor` 类；不能只按类名推断工具类型。读取显示入口为 SquareAnnotationElement/UnderlineAnnotationElement；Worker 中对应 SquareAnnotation/UnderlineAnnotation 继承 StrokeShapeAnnotation。需要改标准 PDF 字典或外观流时检查 Worker，不能仅改 DOM 绘制。

## 发布资源机制

`scripts/build.mjs` 校验冻结资源、确认工具和快捷键存在，递归收集完整 build/web 资源、许可证和桥接文件。每个资源 gzip 后以 Base64 内嵌到 `VIEWER_ASSET_PAYLOAD`，资源 helper 也内联进 `main.js`。

发布产物精确为 `main.js`、`manifest.json`、`styles.css`。`dist/` 虽在 `.gitignore` 中，这三个产物已经被 Git 跟踪；忽略规则不代表它们不存在于远程。更新已跟踪产物可使用 `git add -u -- dist/pdf-web-reader`；不要为提交三个产物把整个忽略目录、缓存或测试输出强制加入 Git。

运行时首次打开 Reader，资源释放到：

```text
<vault.configDir>/plugins/pdf-web-reader/.asset-cache/<bundleId>/<contentHash>/
```

路径使用 Vault 相对路径和 Adapter API，没有运行时 Windows 绝对路径依赖。完成标记 `.complete.json` 仅在全树校验完成后写入；缺失或损坏的文件会由包内载荷修复。同一 Adapter/目录有进行中任务锁。旧 hash 目录目前不自动删除。

当前 0.1.4 的可识别值：

| 项目                 | 值                                                                 |
| -------------------- | ------------------------------------------------------------------ |
| Bundle ID            | `pdfjs-full-viewer-5.7.192-3f4171c02-fork`                         |
| Payload content hash | `d88d2028fd9a18f32207a2a16b1a28e1ed702496ec7e229dfeb3db2ebf439eba` |
| Vendor 哈希项        | 402                                                                |
| 实际内嵌运行资产     | 404                                                                |
| 解压资源总字节       | 12,311,319                                                         |
| gzip 资源总字节      | 4,592,687                                                          |
| 载荷 JSON 字节       | 6,182,678                                                          |
| 当前 main.js 字节    | 6,214,515                                                          |
| main.js SHA-256      | `9a0ef78a8c40978bd26e90161ebe20d15069952658516f291322e2a67aed627f` |

哈希是在明确算法和打包输入下生成，不是插件版本号。Apple 修改资源处理、Viewer 或桥接后，应重新计算，不要复制旧 hash 冒充新构建。

## 宿主和 Viewer 消息链

`PdfReaderView` 继承公开的 `EditableFileView`。宿主从 Adapter 读本地 Viewer HTML/CSS，将 CSS 内联，插入 `<base>` 和带会话 token 的桥脚本，再通过 `iframe.srcdoc` 启动。iframe 使用允许 scripts/same-origin 等能力的 sandbox；不要通过取消安全隔离来猜测解决 Apple 加载问题。

宿主从 `Vault.readBinary` 读取 PDF，保留磁盘基准副本，将二进制数据通过带 transfer list 的 `postMessage` 送入 Viewer。桥脚本用 PDF.js 原 loader 打开数据。

协议检查消息 source、channel、token、documentId 和 requestId。桥使用 `ready` 表示 Viewer 初始化成功，`opened` 表示文档已打开；这两者不是同一个验收阶段。保存由桥请求宿主，宿主经 `Vault.modifyBinary` 写入，并返回 `saved` 或 `error`。

桥禁用 standalone 文件选择和文件拖放替换，避免 Viewer 当前 PDF 与宿主保存目标分裂。它也拦截 standalone 下载/保存/原本的服务覆盖入口，不需要 `/api/local/open`、`/api/local/overwrite` 或本地 HTTP 服务。

文档 scripting、远程 AI/alt-text 模型下载以及合并拆分功能在桥中关闭。保留的 sandbox、完整资源和 sample PDF 不意味着它们需要启用或下载。

## 默认 PDF 路由的兼容边界

`installPdfOpenRouting` 包装 `WorkspaceLeaf.prototype.setViewState`，仅对当前 app 中核心 `type === "pdf"` 且能解析为 Vault PDF 的请求改写到自定义 View。

这使用了公开方法，但“替换核心 PDF 默认行为”本身是 monkey patch，不是官方专用替换接口。没有删除核心 PDF 扩展名注册。卸载时仅在 wrapper 仍为当前实现时恢复原方法；否则旧 wrapper 变为 inactive pass-through，避免破坏其他插件链。

macOS/iOS 需要重新验证普通文件点击、链接打开、恢复标签页、显式打开命令、禁用恢复及其他 PDF 插件共存。不要把所有未知 View 或 Markdown embed 强行改写成 Reader。

## 已解决的两个用户问题

### 下划线重复几何

用户观察到刚创建的部分下划线变为双线，并非仅保存重开后出现。原因是浏览器 Range 同时返回文字节点和完整 inline span 容器的矩形，两种矩形行高不同，转成 underline quads 后出现平行线。

0.1.3 在 `build/pdf.mjs` 的下划线选区路径只收集选中文字节点的矩形，并裁剪到原始选区。没有改动荧光笔选区算法、Worker 或 PDF 序列化格式。已经保存的旧错误几何不会自动重写，需用户删除重画。

回归入口为 `tests/underline-regression.test.mjs`。不能简单按相近 Y 合并所有框，否则可能破坏不同字号、跨列或真实不同基线的文字。

### 旧批注拦截二次创建

用户选中工具后点击已有批注，只能选中整个对象而不能继续选文字或在里面画新批注。原因是旧编辑器和绘图覆盖层截获 pointerdown；选中旧对象又可能将当前工具切成该对象类型。

0.1.4 增加两种明确交互状态：

- `.creationPriority`：五种创建工具活动时，旧编辑器主体和绘图覆盖层让出 hit testing。
- `.explicitlyEditing`：退出创建工具后明确双击旧对象，或显式 editId 请求，恢复对象编辑路径。

同模式显式编辑请求不再被提前 return 丢弃；取消选择和模式切换会清理显式状态。FreeText 提交时不能立刻清除显式编辑标记，否则选中的旧文本框提交后无法继续移动。

CSS 例外限制在 `:not(.drawing)`，防止覆盖绘制期间的 pointer-events 规则、破坏 `offsetX/Y`。聚焦的 FreeText 输入保持可编辑。工具栏、评论入口和橡皮擦不是无差别关闭目标。

修改入口为 `build/pdf.mjs`、`web/viewer.mjs` 和 `web/viewer.css`；Worker 和保存格式未改。回归入口为 `tests/annotation-interaction-regression.test.mjs`。不要用全局 `pointer-events:none` 替代这些分状态规则。

## Windows 验证证据与边界

0.1.4 产品提交前已有完整 Windows 运行结果：`npm test` 32/32，通过三文件离线功能测试。原生测试库完成安全重载，运行实例确认 0.1.4、正确资源 hash，并打开 14 页测试 PDF；没有修改用户 PDF 原件。

2026 年 10 月 7 日交接复验重新构建后，默认 `npm run test:release` 在 npm test 阶段得到 31/32：下划线回归的 `reopenFixture` 等待宿主 opened 计数达到预期时超时 90 秒，位置为 `tests/underline-regression.test.mjs:586`，调用发生在旋转场景循环。该次不是几何断言失败，流水线未继续执行 offline 阶段。随后同一产物运行 `node --test --test-concurrency=1 tests/*.test.mjs` 得到 32/32，约 28.3 秒；单独运行 `npm run test:offline` 也通过五工具创建及保存重开。没有修改产品代码或测试来规避失败。并发默认运行存在间歇重开超时，确切原因仍待定位，不应把串行通过写成默认流水线始终稳定。

已执行的交互回归包括旧 Square 内创建 Square 和 Ink、旧 Square 上选文字创建 Underline、旧 Underline 上再次 Underline、旧批注上 FreeText 与数字输入保护、旧 Highlight 上再次 Highlight，以及保存重开。退出工具后双击旧 Square 可明确进入对象编辑，实际拖动可移动；同模式 editId 切换明确目标也有回归。

不能扩大这些证据：当前 0.1.4 交互回归没有实际点击验收 resize 手柄、橡皮擦加 Undo、评论弹窗的完整矩阵。下划线几何回归包含 0/90/180/270 度场景，但不等于五种工具全部完成四旋转、缩放和打印的完整矩阵；触屏、Apple Pencil、iOS 软键盘更不能据 Windows 测试宣称通过。

测试诊断 JSON/PNG/PDF 位于忽略的 `tests/artifacts/`，不会随克隆到 Mac。源测试和公共 fixture 会随 Git 交付，可重新运行。诊断目录中的早期 timeout 图片或 partial 文件不是最终结果；读取最终 JSON 和测试退出状态。

## Apple 深度启动审计

以下证据来自当前代码、Windows 只读隔离探针和 Chromium 嵌入布局测试，没有 Apple 原生运行记录。

| 阶段           | 当前结论                                                                                                  | 实施对策                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| macOS 桌面     | 未发现需另装的运行依赖；宿主提供 Node，产物没有原生架构插件                                               | 用同一包验证原生 macOS，区分 Electron 和 Safari；Intel/Apple Silicon 的支持声明要与实际覆盖一致 |
| 移动启用       | 两份源 manifest 和 dist 标记 desktop-only；build、packaging test 也 assert true                           | 在移动移植完成后同步 metadata 和断言，不只改一个文件                                            |
| Crypto         | helper 顶层 require `node:crypto`，移动端不可用                                                           | WebCrypto SHA-256 加 feature detection；必要时内嵌纯 JS fallback                                |
| gzip           | helper 顶层 require `node:zlib`，并使用同步 `gunzipSync`                                                  | 异步 DecompressionStream 或内嵌解压器；保留流式输出大小上限和失败清理                           |
| Buffer         | Base64、ArrayBuffer 转换等依赖 Buffer                                                                     | 使用 TypedArray、TextEncoder/TextDecoder 和跨平台 Base64 处理                                   |
| DataAdapter    | 已使用抽象 API，未 cast FileSystemAdapter                                                                 | 验证移动 Adapter 的相对路径、隐藏目录、读写和资源 URL，不转用绝对文件路径                       |
| Viewer ESM     | HTML 静态加载 pdf.mjs/viewer.mjs，srcdoc 加本地 base                                                      | 在真实 WKWebView 检查 module script、MIME、origin、加载错误；失败会阻断 shell                   |
| Worker         | 优先 module Worker，失败有 fake worker 的动态 import 回退                                                 | 分别测试真实 Worker 和 fallback；两条 import 路径都失败会阻断 PDF 打开                          |
| 本地二进制资源 | 非 HTTP(S) URL 通常使 useWorkerFetch=false，走主线程 XHR/转发                                             | 真机确认 CMap、字体、WASM 读取；不能从 getResourcePath API 推断所有资源类型都可导入             |
| 编解码回退     | JPX 有 openjpeg JS fallback，JBIG2/CCITT 有 JS decoder                                                    | 保留全部回退资源，用对应内容 PDF 测试，不统一删除 WASM                                          |
| ICC 色彩       | useWorkerFetch=false 时 qcms 被禁用，会降低色彩管理能力                                                   | 将“首屏可读”和 ICC/CMYK 正确性分开验收，需要时改资源传递/初始化方案                             |
| JS 引擎        | legacy 包已补 Promise.withResolvers、AbortSignal.any、Response.bytes、URL.parse、Set 和 Uint8Array 新方法 | 不能把所有新 API 都误报为缺失；私有类方法等语法仍需最低版本或转译                               |

隔离产物探针实际得到：禁止 Node 模块时先在 `node:crypto` 失败；仅提供 crypto 时在 `node:zlib` 失败；两者都提供但没有 Buffer 时，首次 `ensureViewerAssets` 因 `Buffer is not defined` 失败。这不是模拟出完整 iOS，而是确认当前产物的确定依赖链。

三个 WASM 资源均存在，并在 Node/V8 验证为有效模块；这不证明 Apple JavaScriptCore 支持其全部目标特性。WebGPU、ImageDecoder、OffscreenCanvas 有检测或回退，不是统一的 Viewer 启动硬依赖。

## Apple 系统版本边界

不能把“Apple 多平台”解释为所有历史 macOS/iOS 版本。开始开发前需要明确最低 macOS、Obsidian installer/Electron、iOS/iPadOS 和 Obsidian mobile 版本。

- 当前 bundle 含 private class methods；Safari 15 引入这类语法，形成至少 iOS/iPadOS 15 的语法下限线索，但不证明整个插件支持 15。
- Safari/iOS 16.4 引入 Compression Streams。若只用原生 DecompressionStream，应据真实特性探针设边界；支持更早设备则需要内嵌解压 fallback。
- WebCrypto subtle 受 SecureContext 限制，Obsidian 自定义 scheme 是否提供该能力必须实际探测。
- 最新 PDF.js FAQ 的 Safari 版本表不能直接当成当前冻结 5.7.192 fork 的认证结果。
- macOS 桌面 Obsidian 使用 Electron/Chromium，不应拿 Safari 测试替代其原生验收。
- 桌面 Obsidian app 更新与 installer/Electron 更新有区别；minAppVersion 不能独自表达所有浏览器引擎要求。

## 移动交互和宿主缺口

### 工具栏与触控

使用当前生产 `createViewerDocument`、内联 CSS、obsidian-bridge 和测试 PDF，在 Chromium 触摸嵌入视图中成功收到 ready/opened，并等到工具启用。320 CSS px 宽时 Highlight 右界约 332，Ink 约 361，FreeText 约 390；后两者中心在视口外。390/430/768 宽时五个工具中心可达。按钮始终 28×28，normal density。

应先改窄屏布局，再扩大触控点击区；单纯改为更大按钮会加重溢出。需要覆盖 iPhone 竖屏、iPad 分屏、横竖切换和软键盘展开。上述布局探针不是 iOS 实机点击或手势验证。

Underline/Highlight 要验收长按选字、系统选择手柄、多行选区及已批注文字上的二次标注。Square/Ink 的新笔画在 annotation layer 起始，该层没有明确的绘制模式 touch-action 管理；当前 pointercancel 可能沿默认非 aborted 路径结束并提交部分笔画。需要定义手指/笔绘制、滚动、双指缩放及取消策略，不能对整个 Viewer 永久 touch-action:none。

FreeText 需要验证软键盘、中文 IME/组合输入、输入数字不切换工具、输入结束后的框选/移动，以及 VisualViewport 和安全区布局。iPad 外接键盘还应验证 Cmd+S、1–5、重复退出和非美式布局。

### macOS 弹出窗口

iframe 从 contentEl 创建，但宿主消息监听与 timer 使用 ambient window。若 View 所属窗口与模块全局不同，可能在错误窗口上监听 ready/save 消息；这是源码风险，尚未原生复现。

验证普通窗口、popout、窗口迁移及关闭后监听清理。需要时使用 contentEl.win 或 ownerDocument.defaultView 管理 View 所属窗口，并检查跨 realm 的 ArrayBuffer 类型判断。不要只替换为当前聚焦窗口，因为聚焦窗口未必是 Reader 所属窗口。

### 保存和生命周期

插件没有明确的活动 PDF onRename 同步处理。requestedPath 和桥 documentId 在 open 时确定，而保存又要求它们与 TFile.path 一致；文件改名或移动后可能保存失败。需要在原生 Obsidian 验证回调顺序，再同步身份或安全重开，不能丢弃未保存批注。

当前冲突检查是 readBinary 后 compare，再 modifyBinary，存在外部同步恰在检查与写入之间修改文件的窗口。不能用只支持文本的 Vault.process 假装获得 PDF 二进制原子事务。保留冲突拒绝和可恢复副本，明确实际保证范围。

onClose 清理 iframe 和编辑状态，桥 dispose 会终止等待中的保存确认；目前没有未保存关闭保护。移动后台、锁屏或 WebView 被系统回收时尤其需要可恢复草稿和恢复策略。建议保留手动 PDF 保存语义，草稿保护与自动覆盖用户 PDF 是不同动作。

## 资源性能与缓存策略

首次冷启动展开 404 个文件，写后逐个读回，再完整树复查，空缓存情况下约 808 次二进制回读。新 View 的暖缓存仍会解压全部载荷、校验 hash，并读取约 12.3 MB 缓存文件。单个 View 的 resourcePromise 会复用，但插件级 viewerAssetsPromise 成功后也清空。

移动适配应异步化并控制每次工作的批量、内存和 UI 进度。可保留会话内已成功的资源任务，另提供损坏检查/重试；这样会改变损坏检测时机，应写入测试和文档。

旧版本缓存没有自动回收。不要为优化直接删除所有缓存或插件目录。应仅清理已确认非活动的插件自有版本目录，并保证正在打开的 Viewer 不会失去资源。

当前完整资源含约 1 MB sample PDF、debug/sample 文件与禁用的 sandbox。它们不是正常打开 Vault PDF 的必要内容，但用户此前要求完整资源内嵌，构建和测试也按完整快照校验。不要擅自剪枝；性能改造先保持资源完整。

## 构建与回归操作

开发环境需要 Node/npm；用户安装插件不需要单独安装它们。原 Windows 验证使用 Node 24.19.0；这不是已确定的最低 Node 版本。安装已锁定依赖，不在接续初期顺便升级 PDF.js 或 puppeteer。

```sh
npm ci
npm run build
npm test
npm run test:offline
```

也可以用 `npm run test:release` 顺序执行 build、unit/browser tests、offline smoke。

默认回归发生重开超时时，保留错误和诊断后追加串行复验，不要删除失败证据，也不要把延长超时视为修复：

```sh
node --test --test-concurrency=1 tests/*.test.mjs
npm run test:offline
```

Mac 上先确认 Chrome/Chromium 的实际可执行文件位置，再通过 `PDF_READER_CHROME` 或 `PDFJS_CHROME` 指定；当前测试默认只找 Windows Chrome/Edge。示例仅适用于 Chrome 确实安装在该位置的情况：

```sh
export PDF_READER_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
npm run test:release
```

修改 vendor 文件后，审查实际 diff，再更新并验证冻结清单：

```sh
node scripts/hash-vendor.mjs --write
node scripts/hash-vendor.mjs
npm run build
npm test
npm run test:offline
git diff --check
```

`--write` 是对有意修改输入的显式操作，不能用它掩盖意外资源变化。哈希校验不是功能测试，也不替代源 diff 审查。

`npm run test:native`、`test:native:background`、`test:native:release` 当前不能直接当成 Mac 验证：native 脚本硬编码 Windows CLI、Vault 路径与 Vault ID，background wrapper 还调用 cmd.exe。先参数化或建立 Mac 专用入口，并保留未保存状态保护。

`scripts/deploy.mjs` 默认 Windows 测试库，可用 OBSIDIAN_VAULT_PATH 覆盖，但部署脚本仍固定 `.obsidian`。运行时支持实际 Vault.configDir 不代表部署脚本也已经支持自定义配置目录。请先确认目标测试库和配置目录再运行部署。

## 安全部署与数据规则

- 使用独立测试库和 fixture 副本；不要对用户书籍原件做写入验收。
- 部署前先确认所有 Reader 已保存，并关闭或安全禁用插件。deploy 脚本不替操作者检查所有活跃未保存视图。
- 旧插件连同自有缓存会移动到项目 `.deploy-backups/`，可恢复；不是永久删除。
- 替换磁盘 manifest 后，运行中的 Obsidian 可能仍缓存旧 manifest。检查磁盘、manifest map、运行实例三者一致；若 CLI 可用，安全 reload 后再次确认。
- CLI/CDP 只用于测试，不是最终插件依赖。Windows background wrapper 仅在开发测试期间做 focus emulation，不应搬入生产逻辑或冒充真正前台/移动验收。
- 用户明确要求不要干扰其正常浏览，不应反复要求其切前台，也不应强制操作其他 Vault 或窗口。
- 任何无法安全保留未保存编辑的重载、升级或窗口关闭都应先停下。不得用 git reset --hard、覆盖工作树或删除广泛目录来“清理环境”。

## Apple 适配实施顺序

1. 在用户指定的 Mac 目录克隆最新 main，阅读本文件、README、PROVENANCE、manifest、package 与入口源码。检查 Git 状态，不覆盖本地新改动。
2. 在用户指定的 Mac 测试库完成当前桌面基线，记录 Obsidian app/installer、macOS、CPU 架构。验证默认 PDF 路由、五工具、Cmd+S、普通窗口和 popout。
3. 把资源 runtime 改成移动可执行的异步实现。Node 构建工具可以继续留在 scripts；生产顶层不能加载移动缺失模块。保留三文件、离线、完整载荷及安全校验。
4. 制作分阶段启动诊断，在 iPhone/iPad 原生 Obsidian 中验证缓存、srcdoc、ESM、ready、真实 Worker/fake worker、opened、首屏和文字层。失败时修改可控的资源加载架构，不引入 HTTP 服务或 CDN。
5. 修复窄屏工具栏、触控目标、手指/笔/多指策略、选区提交和软键盘；同时保持桌面鼠标与快捷键回归。
6. 补 View 所属窗口、改名/移动、关闭草稿恢复、保存失败/同步冲突策略；保留用户明确保存的行为。
7. 用 fixture 副本完成每个平台五类标准 PDF 批注保存重开、二次编辑、撤销/重做/删除、橡皮擦、线宽/颜色、缩放与四种页面旋转。单独验收打印及对应平台的导出行为。
8. 在真实支持矩阵通过后改 desktopOnly 和说明；同步三份 manifest、versions、构建断言、packaging tests、README、PROVENANCE 和哈希。确认 Windows 功能未退化，再按用户授权提交、推送和发布。

## 原生验收记录内容

每个平台至少记录 app/installer 或移动 app 版本、系统版本、设备和输入方式，区分真实前台、自动化、浏览器模拟和纯静态审查。

启动记录需要包括实际资源 scheme/origin/baseURI、静态模块加载结果、桥 ready 时间、Worker 握手或 fake-worker 回退、PDF opened 和首屏时间。不要把用户文件全文、个人路径或访问 token 提交到公共仓库。

内容样本包括普通文字、中日韩 CMap/字体、无文字扫描件、JPX、JBIG2/CCITT、ICC/CMYK 和较大 PDF。三个 WASM 的存在或 V8 编译成功不能代替这些样本在 WebKit 的渲染结果。

最低设备矩阵应包含 macOS 桌面、iPhone 和 iPad；如承诺 Intel 与 Apple Silicon 两种 Mac，则分别验证。iPad 需覆盖分屏、手指、Pencil 和外接键盘；只有模拟鼠标测试不能证明这些输入方式可用。

## 官方依据

- [Obsidian Mobile development](https://docs.obsidian.md/Plugins/Getting%20started/Mobile%20development)：移动端无 Node/Electron；官方 iOS 远程调试路径需要 Mac 与 iOS 16.4+。该检查器要求不等于产品最低系统版本。
- [Obsidian 插件提交要求](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)：Node API 与 desktop-only 声明要求。
- [Obsidian 公开 API](https://raw.githubusercontent.com/obsidianmd/obsidian-api/master/obsidian.d.ts)：DataAdapter、EditableFileView、Vault 和平台能力的公开契约。
- [Obsidian 弹出窗口](https://docs.obsidian.md/plugins/guides/pop-out-windows)：窗口有独立 globals，使用元素所属 window/document。
- [Obsidian 更新与 installer](https://obsidian.md/help/Getting%2Bstarted/Update%2BObsidian)：桌面 Electron 引擎与 app 更新的区别。
- [WebKit Safari 15](https://webkit.org/blog/11989/new-webkit-features-in-safari-15/)：模块 Worker、private methods、相关语法与 WASM 特性。
- [WebKit Safari 16.4](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/)：Compression Streams。
- [WebCrypto](https://www.w3.org/TR/webcrypto/)：SubtleCrypto 的安全上下文条件。
- [Web Inspector](https://webkit.org/web-inspector/enabling-web-inspector/)：Apple 设备检查工具。
- [PDF.js FAQ](https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions)：legacy 支持边界及 API/Worker 必须匹配的原则。

项目和新增宿主代码为 Apache-2.0，第三方字体、色彩和解码器的原许可证保留。三个发布文件并不自动保证社区目录审核通过；当前未获得官方审核批准。资源释放仅物化已经随包提供的代码，不下载或自更新外部代码。

## 给 Mac Codex 的接续指令

可将以下内容作为新会话的用户消息。部署和具体实现仍须遵循该会话的授权及用户指定路径。

> 你接续开发 https://github.com/XxX-42/26_28_ObReader 。先确认最新 main，完整阅读 MACOS_HANDOFF.md、README.md 和 vendor/pdfjs-generic-legacy/PROVENANCE.md，再检查 Git 状态及运行入口。当前产品基线为 0.1.4，产品提交 85da554；Windows 已通过核心回归，但 macOS/iOS/iPadOS 尚未原生验收。目标是同一组三文件插件离线支持 macOS 和 iOS/iPadOS，保留正常打开 PDF、五种标准批注、12345 快捷键、保存重开和二次编辑。先确定我的 Mac 开发目录、独立测试库、最低系统版本和可用设备；不要把 Windows D 盘路径或原生脚本直接搬过来。按交接说明先建立 Mac 桌面基线，再移除移动端 Node 依赖并验证真实 Obsidian 资源和 Worker 链路，然后处理触控、软键盘、窗口与保存生命周期。不得损坏用户 PDF、扰动正常浏览、删减完整资源或换成上游未定制 PDF.js。具体审计和开发使用可用的 Luna Max 子代理，保持验证证据和未通过项清晰，不能仅改 isDesktopOnly 就宣布适配完成。
