# macOS 0.2.0 候选验收记录

本阶段仅 macOS；iPhone/iPad 延后，isDesktopOnly 保持 true。用户主库未部署，公开 Release 未创建；源码、交付版本与测试证据见下文当前候选记录。

## 当前候选与真实画布回归（2026-10-11）

最终重绘候选 main SHA-256 为 `07ee54f876aa699f0cbeb9da335294ceb2d0a3608123ca46a6581bf3d0abb588`；bridge 源码为 `642869305818efb3a3c735ec238f5f1f924046a70131e52850be5299e9e82fb0`。构建核验 404 个运行时资源和 402 个冻结 vendor 文件，vendor 与 Windows `c52e522` 完全一致。

- 升级后的真实 page-canvas ROI 回归在旧 e755 包复现 Undo 字形未恢复，不能以 AP 点击区显示替代画布证据。失败日志 `freetext-pagecanvas-baseline-e755-20261011.txt` 保留。
- 桥接层仅对受影响页清理派生 modified-ID 缓存，并调用 PDF.js 正常 NONE-mode 页面重绘；文档／会话／代次／manager／页面／editor 身份限制保持，未修改批注数据或撤销栈，不制造额外保存修订。Luna Max 只读审计无阻断，见 `mac-integration-repaint-audit.json`。
- 定向像素测试自然退出通过：擦除／Redo 的 ROI fingerprint 为 `de72b3d5`，Undo／再次 Undo 恢复基线 `39f6d937`，像素差 0，保存重开后仍一致；同批注 ID 和 editor UID，mode NONE，无额外保存。日志 `freetext-pagecanvas-repaint-final-20261011.txt`。报告 errors 为空，但保留一条通用 404 console 警告；推测 favicon，未证实来源。
- 同构建默认并发 **82/82**，自然 exit 0，52.59 秒；串行 **82/82**，自然 exit 0，73.55 秒。日志 `mac-integration-default-repaint-final.txt`、`mac-integration-serial-repaint-final.txt`，没有自动重试或人工退出清理。
- 离线三文件 Viewer 的五工具、快捷键、桥接校验及保存重开通过：`mac-integration-offline-repaint-final.txt`。构建身份为 `mac-integration-repaint-build-identity.json`。

同一最终构建的 Mac 原生关键专项已通过：冷缓存离线三文件首开加载 404 项资源、真实 Worker、14/14 页，报告 `native-threefile-release-20261011013823307.json`，截图人工查看确认测试库、工具栏和页面显示。FT Undo 报告 `native-macos-lifecycle-20261011013901383.json`：同一已保存重开批注 `998R`／`UndoVisualProof`，NONE 模式右拖擦除 ROI 581→0、fingerprint `cfb24ba3`→`d4bc9245`；可信 Meta+Z 恢复 581／原 fingerprint，Meta+Shift+Z 清空，再撤销恢复，保存重开保留 AP／文本。此为独立测试 Obsidian 的后台 focus-emulated 验证，非物理前台键鼠操作。

诊断修正前的原生 19 个独立功能场景均已通过，同一 main SHA 为 `07ee54f…b588`。执行方式为逐场景进程顺序运行，FT Undo 先单独验证，其余 18 组在关闭精确本轮默认路由 Reader 后复验；不能描述为一次不间断的全套运行。总表为 `native-repaint-macos-aggregate.json`。

原生编排首次启动其余 18 组时，安全预检发现默认路由测试留下的 clean Reader `PDF迁移测试/native-default-20261011013953567-reenabled.pdf`，全部在 executedCases 为空时停止。没有执行或修改产品场景，失败报告与日志完整保留。核对精确路径、Vault／插件身份及 ready、无 pending、无 dirty／modified 后只关闭该标签，记录 `native-repaint-default-reader-cleanup.json`，随后明确重跑 18 组。没有取消或放宽预检规则，也不把中断伪装成初次全部通过。

覆盖手动／自动保存、保存期间编辑、多视图、改名移动、外部冲突、失败、关闭／恢复失败与重试、文档切换、工具矩阵、橡皮擦、轮盘、文字焦点与真实画布撤销、弹窗及迁移。工具矩阵包含缩放、四向旋转、移动／调整尺寸、Delete、Undo／Redo、颜色／线宽、保存导出及重开；打印仅生成页面并取消。弹窗测试记录 7 次实际 empty-window targetClosed=true，capture 与 post-dispatch 均 defaultPrevented=false／returnValue 空；一次恢复准备失败先拒绝关闭，重试后正常关闭。截图人工检查确认擦除前后与 Undo 后真实字形变化。

该轮最终清理先被 3 个本轮默认路由标签及 3 个 popout-close 遗留 plugin.views 实例拦下，失败保留为 `native-repaint-fixture-cleanup-preflight-failed.json`。最终核对精确路径、干净保存状态与身份后，正常 detach 仅这些本轮对象，再清理 38 个实际存在的 fixture 和 19 个空目录；5 项此前已不存在，没有递归目录删除，也没有删除用户恢复快照。安全交接 Reader／plugin.views／gate 均为 0，自动保存开启，focus／network 临时设置恢复。总表明确整窗关闭后的自动注销观察尚未解决，手动清理不计为自动注销通过。

只读调查确认 SDK `PopoutSplit.close` 调用 `leaf.detach`、`view.close` 后不等待异步 onClose，就请求关窗；同时该测试诊断把 routing.originalDetach 包为 async、在真正 detach 前等待恢复列表，且 onClose 包装依赖即将销毁的 owner realm。这些包装改变了实际关闭时序，不能据空 onClose trace 单独认定产品是否调用生命周期。独立无包装器原生基线现已通过：`native-plain-popout-close-baseline.json` 使用同一 07ee main，干净 14 页 PDF 经真实 moveLeafToPopout 与 gate.root.close 后约 109ms targetdestroyed；+1／+3／+8 秒 Reader、plugin.views、gate 全为 0，原 view 已 teardown、iframe 移除、ownerWindow.closed=true、root.win=null。未改变 focus emulation 或网络，自动保存保持开启并清理精确 fixture。两次未达到关闭阶段的脚本错误分别保留为 `…-preflight-harness-error.json`、`…-open-routing-harness-error.json`。无诊断对照未复现产品泄漏，先前三实例观察不足以认定产品缺陷，也不能证明具体由哪一项包装导致；现修正诊断时序并增加真实关窗后注销断言。

诊断包装现保持同步 detach 的原始返回值和异常，观察迁至稳定主窗口，并在 finally 撤销 Puppeteer exposed bindings；新增真实关窗后 Reader／view／gate／跨窗口注册自动清零断言。第一轮新观察器原生完整执行 19 组，18 组通过，仅 close-flush 在绘制前终点命中 `.notice-message`，未开始手势或关闭；三个弹窗组包含自动注销断言全部通过。原失败完整保留为 `native-observer-macos-notice-superseded-aggregate.json` 与对应日志。随后仅修正测试前置准备：等待通知自然消失，刷新已加载页面几何，并轮询两端严格真实命中后才启动一次拖动；不隐藏通知、不放宽断言、不重放手势。最终 harness SHA 为 `e67bbb3ad91c1a5f27eda5b7463fa5e3f534f5816b47bd6aa7d363aae6df28ff`，语法与 native-tooling 8/8 通过，Luna Max 独立审计无阻断，见 `native-observer-point-ready-static-audit.json`。页面几何在通知结束后刷新一次，等待期间布局变化仍可能导致安全的手势前超时。

最终同一 07ee 产品／e67bbb 测试观察器的 19 组原生复验全部实际完成并通过，19 个进程均自然 exit 0；总表 `native-observer-macos-final-aggregate.json` 为本轮最终原生结论。三条弹窗关闭路径实际 ownerWindow.closed=true，且 Reader leaf／plugin.views／gate 自动清零，没有人工 detach 补救；普通弹窗与迁移组也通过。最终安全交接只有一个测试库 app page，全部 Reader／views／gate 为空，自动保存开启，各进程 finally 释放临时 focus emulation；原生生命周期未设置网络阻断，冷离线专项已恢复其网络设置。本轮仅清理确证归属于此次运行的 fixture 和空目录，保留原恢复快照。此为独立 Electron 实例的可信 CDP 后台输入验收，不声明物理前台或打印机验证。浏览器默认／串行／离线证据对应同一产品哈希，最后修改仅限原生观察器与前置等待，没有重建或改变产品。历史并发打开确认超时仍保留，未声称偶发根因已经根除。

交付使用 `dist/pdf-web-reader-0.2.0-macos-c52e522-candidate.zip`（严格三个根文件）、`…-source.patch`（相对 Windows c52e522 的源码／文档／测试差异，排除 dist）、`…-evidence.zip` 和 `…-delivery.json`。源码整合保存在本地 `codex/macos-c52e522` 分支，以 Windows c52e522 和原始 Mac 781b3cc 为两个父提交；具体提交与文件 SHA-256 记录在 delivery JSON。未推送，公开 Release 未创建。下方旧 10 月 8 日包名及未提交状态只属于历史。

## 2026-10-11 接续：整合 Windows c52e522

本轮使用 Luna Max 子代理进行开发、测试调查和独立审计。整合保留 Mac
0.2.0 的 owner-window、修订确认、恢复副本以及关闭／迁移保护，接续 Windows
`c52e522` 的轮盘、临时橡皮擦、保焦文字提交和右键延迟选择保护。

- 修复前完整复制现存工作目录（包括 `.git`、交付包和忽略的证据，排除可重装的
  `node_modules`），347 个文件逐一比较；备份位于旁边的
  `26_7_PdfRD_OB-backup-20261011-1791670185447`，附 SHA-256 清单。
- 后续 Git 检查刷新了备份 index 的 stat 缓存；清单保留复制时的原哈希和刷新后的
  哈希及原因。备份 staged tree 与 `4b74bf9` 完全一致，源码和交付包没有改变。
- 缺失的 `main` 引用恢复到 `4b74bf9`，仅从原索引恢复 461 个缺失文件。
  原始 Mac 0.2.0 另保存为 `781b3cc`，分支
  `codex/macos-0.2.0-before-windows`。
- 指定测试库此前不存在，重新复制外层快照并核对全部 60 项大小和 SHA-256，
  共 44,931,378 字节；验证后仅在该副本禁用插件并关闭空 Reader 占位。
- 新独立 profile 为 `tests/artifacts/mac-integration-profile-20261011`，
  CDP 仅绑定 `127.0.0.1:9226`；确认 Vault 为
  `/Users/jiajia/Documents/ObReader-Apple-Test`，configDir 为 `.obsidian`。
  运行 Obsidian 1.14.4、Electron 39.8.3、Chromium 142、Apple Silicon 和
  macOS 27.2。主实例 PID 46580 未部署插件、未更改进程；系统窗口选择尝试意外聚焦主窗口后立即停止，未点击或读写主库。后续仅使用已核验身份的 9226 独立实例。

前一轮冻结三文件 main SHA-256 为
`1d1a36601ba1e46f12d13ce49cc0f665ec2e991dc06f0bc4279e4a4b6d5aed55`，
包含 404 个运行时文件，冻结 vendor 的 402 项校验通过。

- 默认并发全套 78/79：下划线 `saveAndReopen` 等待第二次打开确认超过 90 秒；
  保存确认已完成。浏览器退出后子进程仍闲置，采样和日志保留；仅向该子进程
  发送 TERM，让 runner 输出原始超时堆栈和失败汇总。运行记为失败，不计为通过。
- 增强下划线错误日志与限时清理后的第二次默认并发自然退出，仍为 78/79（约 50.27 秒）：下划线通过约 8.54 秒，批注交互的文字焦点断言失败，记录于 `mac-integration-default-diagnostic-20261011.txt`。不自动重试，不覆盖第一轮失败。
- 相同冻结源码与产物的串行全套 79/79，约 70.27 秒；下划线回归约 3.69 秒。
  这只能证明串行复验通过，不能据此宣称并发重开问题已解决。
- 文字创建后补齐真实 pointerup、正值布局及同节点两帧焦点恢复检查。最终默认并发 79/79（48.35 秒）与串行 79/79（64.70 秒）均自然退出，无自动重试；对应 `mac-integration-default-readiness-final.txt` 与 `mac-integration-serial-readiness-final.txt`。产品 main 哈希未变，先前失败继续保留。
- 离线五工具、桥接消息核验、PDF 保存／重开通过。
- 对应日志为 `mac-integration-default-final.txt`、
  `mac-integration-default-hang-sample.txt`、`mac-integration-serial-final.txt`
  和 `mac-integration-offline-final.txt`，均位于 `tests/artifacts/`。

下文 10 月 8 日记录为历史证据，不作为本轮整合候选的验收结果。

整合采用 Mac 既有保存协议和安全部署入口。Windows 的
`tests/autosave-bridge.test.mjs`、`tests/native-autosave.mjs` 和
`tests/deploy-cache.test.mjs` 未直接移入：分别由真实浏览器自动保存回归与宿主测试、
参数化 Mac 原生生命周期测试、拒绝启用中插件／Reader 的部署预检和原生三文件测试
覆盖对应行为。Windows 在活动 Reader 内保留缓存 URL 的部署策略与本阶段先关闭
Reader、备份整个旧插件的策略不同；没有据此宣称活动中热更新受支持。
外层内容区采用 Windows 的高优先级零 padding 规则，覆盖 Obsidian／主题默认留白；
保留 Mac 宿主仍使用的加载、恢复和错误状态区样式。

保留调查过程中的失败和中断证据：首次整合包 `e27f2e89…` 的默认全套测试由本任务
主动中止，以停止并行浏览器压力并调查原生加载；这次运行不计为通过。其原生
三文件首开在资源解包完成后未取得 Worker，记录为失败。后续对同一旧包分别验证
冷缓存正常网络、暖缓存离线拦截、冷缓存离线拦截，三次均完成 14 页 PDF、真实
Worker 和打开确认，均只有 `app://` 资源与 `blob:` Worker，没有请求失败或运行时
错误。报告分别为 `native-first-open-diagnostic-20261010223704687.json`、
`native-first-open-diagnostic-20261010223727867.json`、
`native-first-open-diagnostic-20261010224035328.json`，位于 `tests/artifacts/`。
诊断后恢复了逐文件一致的测试插件缓存，Reader 为空、网络拦截和 focus emulation
已关闭。先前超时未复现，根因未确定，不能据三次通过宣称偶发加载问题已解决。

关闭边界复审确认一个独立源码缺口：零 live Reader 且没有 pending close 时，
残留 gate 不再取消原生 beforeunload，并在直接 SDK close 的零视图分支清理。
新增两个宿主回归，真实 Reader 等待保存保护保持通过。新构建 main SHA-256 为
`3548d7084df31d672206bbc109602581ae2360655827ff67751274b323e6d58d`，
最终证据须重新对应这一构建，不能混用上述 `1d1a366` 验收。

该新构建最终默认并发 81/81（46.96 秒）、串行 81/81（64.73 秒）与离线
五工具／保存重开均通过，日志为 `mac-integration-default-gate-cleanup-final.txt`、
`mac-integration-serial-gate-cleanup-final.txt` 和
`mac-integration-offline-gate-final.txt`。先前新包串行 80/81 的失败是
下划线功能断言已完成后的浏览器清理超时，保留 `mac-integration-serial-gate-final.txt`。
清理现核对测试浏览器实际退出、连接断开与独占进程组状态，不仅重等同一关闭
Promise；fallback 会保留 sidecar，主 child 未退出、连接未断开、stdio 未关闭或已核实独占组仍有进程时会报错，功能错误仍为主错误。PGID 无法核实的路径只向本测试 child 发送 TERM，不能证明其他进程全部退出；TERM 后仍存活只报错，没有升级强杀，runner 仍有被残留句柄拖住的可能。
本轮日志、JSON 和截图均为本地忽略的取证文件，通过本轮 evidence ZIP 一并交付，不在源码提交中伪装成已跟踪内容。


### 3548 候选的原生分组复验

同 main SHA-256 `3548d708…` 的冷安装通过（`native-threefile-release-20261011002429184.json`），核对三文件、404 项资源、真实 Worker、14 页、离线拦截和缓存损坏恢复；截图已人工查看。普通五工具／快捷键／保存重开／默认路由也通过。

19 组全部执行；首次 14/19 整组通过，随后 matrix、eraser、popout-close 在修正真实界面操作后各自复验通过，合计 17/19，按分组计数，不是一次全套不中断通过。matrix 首次有通知遮挡与菜单滚动裁剪：测试等待通知结束，用真实滚轮将旋转按钮移进可点击区域，复验 `native-macos-lifecycle-20261011004024765.json` 完成缩放、90/180/270/0 旋转、批注调整／删除／撤销重做、蓝色 7pt、保存重开及 14 页打印生成后取消。eraser 先真实关闭参数浮层再测，`native-macos-lifecycle-20261011003514116.json` 通过七种模式的右拖。弹窗关闭前置工具按钮的模式与参数浮层操作修正后，`native-macos-lifecycle-20261011004043738.json` 通过持有保存、自动保存关闭的恢复副本、恢复写入失败和重试。未放宽按钮或页面真实命中断言。

3548 有两项未通过：

- FreeText 擦除后 Cmd+Z 的模型恢复但显示没有恢复。`native-macos-lifecycle-20261011003814415.json` 捕获 iframe 可信 Meta+KeyZ；删除 tombstone 清除，998R 对应 editor 恢复且 connected，但 0×0，AP 仍 display:none，ROI 非白像素为 0。原保存重开 AP 的 ROI 为 581。隐藏 DOM 的文字仍在不算恢复通过；继续定位显示重建。
- 空弹窗在有界等待内没有实际关闭。`native-macos-lifecycle-20261011002838751.json` 已完成迁移保存、重开与监听清理；关闭时 Reader 空、gate 空，beforeunload 捕获阶段 defaultPrevented=false，CDP target 却仍存活；未取分发完成后的状态，不能排除后续 Obsidian/native handler 阻止关闭。SDK 标签清理不算 Electron 窗口关闭，不能把零视图 gate 修复当作此问题的根因证明。

3548 收尾汇总为 `native-macos-final-aggregate-3548-20261011.json`：关闭 6 个确证测试标签，清理 53 个自建文件和 27 个空目录；测试库 Reader/gate 均为空、autoSave=true、插件开启、focus emulation 与网络拦截已恢复。收尾时空弹窗已不在 target 列表，但未证明最初关闭请求在验收时限内完成，仍保留该失败。

本轮修复与回归边界：

- 旧文档有待提交文字时切换文件，保留并重新安排旧会话计时器，先完成旧修订确认再打开新文件；覆盖保存确认被阻塞期间继续输入后切换。
- 右键手势在 PDF.js 初始化前注册捕获监听；仅 Viewer 内右键参与擦除边界，只有左键 Ink 设置笔画提交状态。持有超过 1.25 秒时不序列化或写入，释放后再保存。
- Escape 和真正窗口失焦可以结束右键手势；元素失焦不得提前结束，延迟清理必须仍匹配原 pointer 对象。
- PDF.js 重新挂载文字编辑器的短暂失焦／恢复不再取消待保存计时器；真实失焦采用焦点代次校验的延迟提交边界。未增加通用光标重定位；冻结 Viewer 的保焦提交负责保存时保留光标。
- 保存重开双击测试等待实际页面加载完成、稳定批注 UID 和真实命中位置。文字测试等待创建、重新挂载和焦点恢复后用真实键盘输入；工具切换使用真实鼠标点击验证可信失焦，不用程序化点击替代。
- 保存期间继续输入、两个切文档路径、右拖释放／Escape／可信窗口失焦均有真实 PDF.js 浏览器回归。这里是源码组件回归；三文件实际产物由离线和原生验收验证。

### FreeText 普通阅读模式撤销外观修复

新 main SHA-256 为 `e75589554fa7c381a7aa2cfbe36b7a8e626ad531acdc8d010f4f1100897528cb`（6,282,889 字节），取代上述 3548；manifest/styles 未变，402 项 frozen vendor 继续与 Windows c52e522 完全一致。

根因是临时橡皮擦返回 NONE 后，Viewer 已按删除态隐藏保存批注的 AP；后续 undo 只重建 editor，没有同步普通阅读模式的 AP。桥接层现在在真实 undo/redo 后，针对精确保存批注 ID，复用 PDF.js 的 resetAnnotationElement/renderAnnotationElement 显示协调；保留原 editor 和命令栈，不直接改 CSS、不写额外 storage、不单独增加修复 revision。任务核对 PDF 对象、文档／打开／renderer 身份及页层和 editor 对象；离开 NONE 或会话变化取消，异常也清理。视觉任务不计入保存边界，避免保存与同步互等，只在真实输入／序列化／宿主确认期间推迟。

新增真实浏览器回归 `tests/free-text-undo-appearance-regression.test.mjs`。未修复版在创建／保存重开／可信右拖和可信 Meta+Z 均完成后，AP 仍隐藏而失败（`free-text-undo-appearance-1791680249873.partial.json`）；修复版暂停擦除保存 ACK、执行可信撤销，确认释放 ACK 后继续保存并恢复同一 AP，覆盖 Redo／再次 Undo 和最终保存重开（`free-text-undo-appearance-1791680793734.partial.json`）。专项有 runtime errors 空，但 console 留有一条泛化 404；依据测试 HTML 和路由推断可能是 favicon，记录未包含请求 URL，不能当作已捕获的来源。独立 Luna Max 静态审计确认保存死锁、模式切换与异常清理风险已处理；大量页面／编辑器时逐页枚举 snapshot 的性能尚未专项测量。

e755 首次默认全套的批注交互功能断言通过后，Node 子进程未退出。取证显示只有 4 个 PipeWrap、没有活动请求，主线程空闲等待；`lsof` 证明测试 Node 17461 的 fd19 与该次 Chrome 残留 Crashpad 17495 的 fd2 对接。Puppeteer 的 readline 记录器等待 stdout/stderr close，但其 Browser.close 只等待 Chrome 主进程 exit 并断开 CDP。手动关闭精确测试读端后，runner 汇总 82/82、exit0、259.73 秒；此为人工介入诊断，不算最终自然退出验证。记录为 `mac-integration-default-appearance-final.txt`、对应 `annotation-hang-sample`／`annotation-handles`／`annotation-handles-detail`／`annotation-open-files` 和 `manual-cleanup.json`。没有杀 Crashpad 或操作其他应用进程。这证明该次退出等待的原因，不证明历史 PDF 打开未确认的间歇超时同根因。

测试清理通过 `tests/browser-test-cleanup.mjs` 核对该测试创建的浏览器已退出、CDP 已断开，才释放它的 stdout/stderr 读端；不杀任何 PID。关闭有界、逐步记录 sidecar，保留原功能异常。受影响两项专项 2/2 自然退出（`browser-test-cleanup-targeted-20261011.txt`）。独立审计无阻断；deadline timer 使用 unref，并不独自维持事件循环，这是保留的实现边界。

e755 的最终有效验证：默认全套 **82/82，50.43 秒**（`mac-integration-default-appearance-cleanup-final.txt`），串行全套 **82/82，74.22 秒**（`mac-integration-serial-appearance-cleanup-final.txt`），均自然 exit0、没有人工关闭读端或终止子进程；离线真实三文件的五工具／鉴权／保存重开通过（`mac-integration-offline-appearance-final.txt`）。默认与串行批注／下划线证据另复制到各自 `mac-integration-default-appearance-*` 和 `mac-integration-serial-appearance-*`，避免相同 contentHash 文件名在下一轮被覆盖。

e755 的同包原生结果为 **18/19**，冷安装、普通五工具／默认路由以及三组 popout 都通过，包含 beforeunload 分发后 defaultPrevented=false、returnValue 为空且实际 targetClosed=true。此前空窗失败的根因仍未确认，不能据此宣称已查明。FreeText Undo 仍失败（`native-macos-lifecycle-20261011012359396.json`）：AP section 已恢复正尺寸，却只是透明点击区；page canvas 的实际 ROI 仍是 0 像素，而原保存重开是 581。浏览器专项此前只核对 section 尺寸和内容，漏掉真实字形，因而不能作为该行为完整修复的证据。本轮将升级真正的 page canvas 像素断言，并补受影响页的正常 NONE 重绘；e755 作为后续修复前候选保留，不能与后续构建混算。

## 环境与测试边界

- 开发目录：/Users/jiajia/Documents/Documents/Codes/26_7_PdfRD_OB；main 基线 4b74bf9。
- Apple Silicon arm64，macOS 27.2，Obsidian app 1.14.4 / installer 1.12.7，Electron 39.8.3 / Chromium 142。
- 测试库：/Users/jiajia/Documents/ObReader-Apple-Test，configDir .obsidian。外层快照打开前源与副本 60/60 文件大小/SHA-256 验证通过，44,931,378 字节。仓库快照保持原始 0.1.4。
- 使用独立 user-data-dir 的真实 Obsidian 实例。原生自动化为后台 focus-emulated Electron；独立 Chrome harness 是浏览器回归，不等同 OS 前台手工操作。具体开发与审计使用 Luna Max 子代理。
- 官方 CLI 已安装，但隔离 profile 不通过主实例 CLI socket 路由，使用 127.0.0.1:9226 CDP。每个操作前核对实际 Vault/configDir。

## 原始 0.1.4 基线

真实 Worker 打开 14 页 tracemonkey 副本；默认路由、五工具、主键盘/数字小键盘 1–5、输入保护、Cmd+S、保存重开均完成。重开包含 FreeText、Highlight、Ink、Square、Underline，dirty=false。证据：tests/artifacts/mac-baseline-save-reopen.json。

完整原生 smoke 未通过：432 CSS px Reader 窗格把 secondary toolbar toggle 挤到 x455，保存菜单不可点击。保留失败 JSON/PNG：native-obsidian-smoke-20261008063513608。0.2.0 的窄窗格两行工具栏针对实际问题修复；720px 及以下使用两行，721px 保持原布局。

## 整合过程中的失败

首次默认并发 49 项：45 通过、4 失败。旧两套手动测试没有返回新增 revision，另有新 toolbar harness 的资源路由错误和 autosave 测试对象查找错误，分别修复并重新核验。随后串行旧测试重开仍超时，原因是测试故意丢弃待保存编辑与新 bridge 的未保存打开保护冲突；在测试显式保存/确认后重置 fixture。离线旧测试首次亦在“无编辑重复保存”等待新增写入时超时；新协议已干净时不重复写盘，测试调整为核对计数不变后重开验证内容。不得把这些失败删除后称为始终稳定。

首次原生冷检查碰到开发期间 source/build 漂移（bridge 源大小 49574，已构建大小 48658），停止于资产比较；已安全关闭测试 Reader、禁用插件，冻结源后重新构建部署再测。

隔离原生 background 初次受 hasFocus 前置断言阻挡：CDP 已使 document 可见，但真实后台 document.hasFocus 可为 false；改为要求 renderable visibility，保留焦点诊断，并由真实输入/保存功能断言验证。源修改期间的一次串行包装检查亦报告 bridge 59777/60757 字节漂移，最终冻结后重构建复验。annotation NONE 双击编辑等待超时后来在最终默认并发中重现（53/54）；事件证据显示点击时命中 page.loadingIcon.loading 的渲染遮挡，8秒后目标 Square 才可命中。测试先等 textLayer 不等页面/批注完成，存在就绪竞态，正在改为等待实际目标命中后双击。原始0.1.4对照提前在重开等待超时，未用于证明产品回归。

历史 Windows 默认并发重开超时记录仍在 MACOS_HANDOFF.md。即使本轮通过，也不能证明旧间歇问题已经根除。annotation 双击测试已增加真实目标可命中的就绪检查；最终默认与串行均通过，失败摘要及指针命中证据保存在 mac-default-before-readiness-fix.json。

原生保存中继续绘制用例发现真实产品问题：bridge 的 body.wait 全屏遮罩在等待宿主确认时挡住指针输入。已移除保存/恢复路径的阻塞遮罩，保留保存串行状态；新增持有首个确认期间用真实鼠标绘制的 Chrome 用例通过，原生复验已确认真实 Ink 在首写阻塞期间完成，writeCalls=2，重开保留 Ink 与 Square（native-macos-lifecycle-20261008072059497）。最初的 API undo 测试可绕过遮罩，不能替代真实输入；保留 native-macos-lifecycle-20261008071546956 / 20261008071823199 失败证据。

原生生命周期进一步发现 SDK 的 leaf.detach() 先移除 Reader 标签，而不等待 async onClose：首个宿主写入被刻意阻塞时，200ms 内标签已经消失，违反可控关闭等待；冲突暂停后的 close draft 也没有生成。外部字节冲突、失败写入与恢复命令此前均通过。失败证据 native-macos-lifecycle-20261008072742534；已补充 SDK 拆除前的精确准备确认与取消保护，后续原生关闭／恢复拒绝和重试通过。

关闭协议整合后的冷安装 native-threefile-release-20261008075241045 报告通过，但截图出现重复关闭失败提示。不能只依据 passed 字段忽略可见问题：缓存修复测试在字节干净后直接禁用插件，绕过可控 leaf 拦截；SDK 销毁中重复调用 prepare-close 的路径亦需要清理。测试入口现改为先显式关闭，再禁用；onClose 的 teardown 标记避免 SDK super.onClose 再触发第二次准备确认，首次 dirty flush 失败仍保留提示。最终冷检查及截图通过。直接在后台跑冷检查曾被 hidden 前置检查拒绝（mac-final-native-release.txt）；之后用持久 CDP focus session 运行并在 finally 释放，记录 mac-final-release-focus-wrapper.json。

原生 native-macos-lifecycle-20261008075313941 已通过全部关闭、恢复拒绝／重试及同 leaf 切换用例，之后 matrix 的点击及 Mac 键盘阶段卡住，CDP localhost 也失去响应；最终截图、设置恢复及 focus 清理均超时，报告保留这些错误，没有 PNG。后续脚本补正确 Mac Carbon keycodes、按钮及 iframe 的实际命中断言、每步增量证据。native-macos-lifecycle-20261008082022554 的命中辅助函数存在模板插值错误，Zoom／旋转未执行成功；真实 Cmd+Z 已通过，随后 Cmd+Shift+Z 再次使 CDP 无响应。该报告已收尾为 incomplete/interrupted，未把未完成项当通过。仅向验证过 profile 参数的独立测试进程发 SIGTERM；第二次进程未退出后只对该测试 PID 升级 SIGKILL，用户主进程 PID3798 未处理；卡住的 matrix 未落盘临时编辑无法恢复，属于测试自建副本，见 mac-isolated-instance-restart.json。Mac 键盘驱动已改用 Puppeteer 原生 keydown/up，后续矩阵分组通过（091252703）；不再使用造成冻结的手动 native keycode 路径。

迁移原生用例又发现 srcdoc realm 重载后 PDF 文档丢载：host.ready 仍真、pendingBytes 已用完，新 Viewer 12 秒后仍 pages=0/mode=-1。失败报告 native-macos-lifecycle-20261008090507906；未用该 ready 字段假称通过。已增加核实过的 workspace.moveLeafToPopout Reader 专用准备检查点、稳定 documentId、新的 openRequest／rendererGeneration，以及新 realm 的原件或精确恢复 draft 重载。auto-save-off／冲突暂停状态及修订保持；旧 prepared 被清除。独立浏览器实验还证实 main-realm postMessage 会让 popup iframe 看到 opener 来源，严格 parent 检查会拒绝；现在统一使用 owner-window realm sender，未放宽来源检查。无拦截的 DOM 重载只恢复最近匹配 durable draft 或已确认原件，并明确提示额外未序列化更改可能未保留。

## 最终验证

最终审计另发现 popout split.close() 不等待 leaf.detach()，会先销毁窗口；普通标签关闭保护不能单独覆盖这条路径。已对核实过的所属窗口与 SDK split 实例增加同窗 Reader 协调及 beforeunload capture，精确准备后同步 detach；失败／身份变化／新增 Reader 时取消并保留窗口。SDK 已提交关闭后持续允许延迟 beforeunload，未提交关闭则解冻并提示。40/40 宿主测试覆盖真实父级“不 await detach”的模型、持有确认、失败重试、多 Reader 部分失败、迁移和 later wrapper 清理；私有关系失配及强退限制见 mac-popout-host-audit.json。同候选原生结果按分组列于下方，原始失败记录保留。

重开与输入测试的失败历史保留：默认 FreeText 输入就绪失败（61/62，mac-default-freetext-readiness-failure.txt）；串行短暂失焦失败（71/72，mac-final-serial-freetext-focus-failure.txt）；新增点击断言将空 contenteditable internal 的自然零宽误判为不可点击（77/78，mac-final-default-freetext-entry-failure.txt），现使用实际有尺寸的外层编辑框真实点击并继续断言焦点、选中、连接、键盘与输入。期间默认与串行各有72/72成功记录，不等于始终稳定。定向又出现第四个 open 已发出、没有 opened/error、PDF.js document 为空的间歇超时，代次过滤被排除，随后第八次open亦发生间歇等待：loadingTask active、progress=100%、pdfDocument=null、无页面/错误；就绪检查已让mode切换通过。深层根因仍未证实，后续诊断保留在测试中。

后续默认全套76/78失败（mac-default-debounce-mode-failure.txt）：工具模式等待和1秒 debounce 计时断言；串行78/78通过（150.64秒，mac-pre-owner-rebind-serial-tests.txt）。计时原用 mouse.up 的 CDP 往返后打点，现改为真实 pointerup 事件的 performance 时间；工具切换增加当前 PDF、页面、编辑器和按钮就绪检查及失败状态记录。随后默认79/79通过（524.07秒，mac-pre-focus-harness-default-tests.txt）；串行78/79失败（70.65秒，mac-final-serial-real-focus-click-failure.txt）：真实创建指针已将active/selected/connected/contenteditable设好，但测试额外要求空框outer可点击，与creationPriority下的pointer-events设计冲突。现在已有真实创建焦点时直接真实键入，只在失焦时真实命中再聚焦；保留五个trusted keydown、五个trusted input及12345内容断言，定向1/1通过。最终两种全套复验结果列于交付小节。

原生完整普通窗口矩阵分组 native-macos-lifecycle-20261008091252703 通过：真实鼠标批注、蓝色7pt、实际resize手柄、Cmd+Z/Shift+Z/Delete、缩放、90/180/270/0旋转、保存重开及PDF.js14页打印后取消；截图已检查。随后真实background/default routing在091314088通过。旧999e候选的弹窗关闭三条用例全部通过（095543232）：持有写入时窗口等待、auto-off关闭只写恢复副本、恢复目录写入失败保留窗口且重试成功。

999e候选带编辑迁移的auto-on通过，但auto-off失败（094614982、095414151）：exact draft已持久化且原件哈希不变，新 iframe 的 bridge generation正确、PDF.js initializedPromise fulfilled、无console错误，host却仍绑旧 ownerWindow，收不到 ready。新ba6候选以 iframe实际parent为优先窗口，并在每次load早退前重绑；40/40宿主测试包含异步adoption且contentEl仍属旧document的真实模型。原生三条迁移复验通过（native-macos-lifecycle-20261008100402026）：auto-on待确认迁移、auto-off恢复dirty/代次后真实Cmd+S、恢复写入失败拒绝迁移且重试成功，构建与安装SHA均为ba6。

最终ba6候选冷安装通过（native-threefile-release-20261008100135194）：404项释放/哈希核验、真实Worker、14页、离线HTTP/WebSocket阻断、损坏icon恢复；截图无重复关闭错误Notice。mac-final-release-focus-wrapper.json记录准确构建SHA和finally焦点释放。离线桥接校验计数等待曾超时（mac-offline-bridge-counter-failure.txt），只缺伪来源消息；50ms删除srcdoc探针时脚本尚未运行，现等严格计数收到再销毁。离线另有第三次opened等待120秒超时，原次尚无快照，不能拿其他次状态冒充。补齐诊断后focused离线五工具/保存重开全通过，最终进程自然exit0；清理较慢也保留在mac-offline-focused-reopen-20261008.json。

## 同一候选的最终原生汇总

main.js SHA-256：ba6eeb1dff9dd8e2ecbbe7712ddc4c7cb83322b681427062b81856afae5c62fd。16组均有同构建与安装哈希证据；按分组汇总，不能称作一次不中断的全套通过。总表 native-macos-final-aggregate-202610081022.json。

| 组 | 通过证据 |
| --- | --- |
| 手动/自动/保存期间继续编辑、改名移动、多视图、外部冲突、写入失败、三种关闭恢复、切换、完整矩阵、橡皮擦、普通弹窗（14组） | native-macos-lifecycle-20261008100451987.json 的 completedCases；该次随后因弹窗诊断wrapper未清理而失败，原报告保留 |
| 弹窗迁移：auto-on、auto-off dirty、恢复写入失败与重试 | native-macos-lifecycle-20261008100402026.json |
| 弹窗关闭：持有确认、auto-off恢复、恢复失败与重试 | native-macos-lifecycle-20261008101751051.json；诊断注册表零残留 |
| 普通窗口五工具、1–5、Cmd+S/保存重开/二次编辑及默认路由 | native-background-20261008102032776.json；其子smoke/routing及buildIdentity均核验 |
| 三文件冷安装/离线资源/缓存修复 | native-threefile-release-20261008100135194.json；截图检查通过 |

最终测试库已启用0.2.0、autoSave=true、Reader空、无诊断wrapper、focus emulation已关闭；native-final-safe-handoff-202610081022.json。旧插件完整备份 .deploy-backups/2026-10-08T10-01-15-383Z/pdf-web-reader；原始0.1.4备份 .deploy-backups/2026-10-08T06-52-28-295Z/pdf-web-reader。原生新窗口重启曾恢复旧空New Tab弹窗，仅核对测试profile/无Reader后清理，主进程未处理。

## 交付文件与最终自动化

候选 main.js 为 ba6eeb1dff9dd8e2ecbbe7712ddc4c7cb83322b681427062b81856afae5c62fd（6,274,960字节）；manifest与styles分别268／506字节。构建核验402个冻结vendor文件、404个运行时资源，未改移动运行时。ZIP严格只有main.js、manifest.json、styles.css，并逐字节核对ZIP/dist/安装文件一致。远程main收尾复核仍为4b74bf9。

最终默认并发79/79，exit0，370.55秒；日志mac-final-default-tests.txt。较慢退出阶段的只读诊断仅见4个PipeWrap、无活动网络句柄/请求，根因未证实；调试器已断开、进程自然退出，未强制终止最终测试。最后一次串行曾报77通过/1失败/1取消；系统日志确认该次跨越18:35:19–18:42:07（+0800）的408秒合盖睡眠，underline超时与睡眠重叠，浏览器断连的精确单独原因未证实。这次作为中断记录保留在mac-serial-disconnect-cleanup-timeout.txt和mac-serial-system-sleep-interruption.json，不算有效最终复验。唤醒后的串行用仅本测试进程有效的caffeinate -i防空闲睡眠重跑，不改变持久设置，不阻止主动合盖。清醒串行复验79/79、exit0、77.28秒；日志mac-final-serial-tests.txt，临时防空闲睡眠随测试进程退出释放。离线测试完整exit0，五工具、鉴权、保存重开通过；此前超时与定向失败原样保留，不声称重开间歇问题已经根除。

交付目录dist：pdf-web-reader-0.2.0-macos-candidate.zip（三文件候选），pdf-web-reader-0.2.0-source.patch（相对4b74bf9的源码/文档/测试差异），pdf-web-reader-0.2.0-macos-evidence.zip（JSON/截图/日志与本记录），pdf-web-reader-0.2.0-delivery.json（各文件SHA-256和验证引用）。源码尚未提交或推送，公开Release未创建。证据包不含用户profile、Obsidian本体或提取的专有源代码。

## 保存与恢复限制

自动保存默认开启，可持久化关闭。编辑完成后 1 秒合并；正在绘制或组合输入时等待边界。串行保存仅按 exact documentId/requestId/revision 确认清除 dirty；途中继续编辑保持待保存。文件改名/移动保留文档身份，并更新路径。关闭开关阻止新请求，宿主已接受/入队请求作为进行中的保存完成。

每次写原件前先保留恢复 PDF/元数据，核对基准，再写入和读回；冲突/失败暂停自动覆盖。恢复命令只写独立 PDF Recovery 文件。关闭 auto 或冲突暂停后的可控关闭也先持久化恢复候选，不隐式改原件、不把 dirty 标为已保存。成功写回并确认才清理对应候选。

二进制比较与写入之间仍有同步竞争窗口，Vault API 不提供原子 compare-and-swap。强制进程退出可能绕过 async close；输入边界最多等待 110 秒，宿主 flush 120 秒。若仍无法完成序列化/恢复持久化，不能保证恢复；恢复目录本身不可写也会失败。宿主单次保存等待可达 120 秒，与关闭 flush 超时可能接近同时到期。主库、公开发布、Intel Mac、移动端不在本轮证据范围。返回主窗口的其他SDK迁移入口尚未核验；仅已核实的moveLeafToPopout有可控准备保护，无拦截的DOM重载只能恢复最近持久化检查点，额外未序列化编辑不保证保留。

现有 secondaryDownload 为“保存到仓库”，其 PDF 输出通过真实保存重开验证；没有单独 Download Copy UI。打印核验仅生成 PDF.js 打印页并取消，不声称实际打印机输出已通过。vendor pointercancel 保持既有语义，本轮没有承诺取消笔画永不提交。
