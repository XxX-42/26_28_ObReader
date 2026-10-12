# PDF Web Reader 苹果平台开发交接上下文

## 当前 0.5.7 iPad 手指导航（2026-10-13）

三端统一 0.5.7。工具启用后，PDF 页面手指只能滑动，不可选中文本；Pencil、鼠标、工具控件与文字输入保留原功能。只修改自有输入适配层，冻结 Viewer、保存和同步协议保持不变。当前验证范围与交付记录见 GENERAL_ACCEPTANCE.md；0.5.6 包保留回滚，实体 iPad 行为仍待用户确认。

## 历史 0.5.6 手指惯性滚动（2026-10-13）

三端统一 0.5.6。80 ms 滚动位置样本使用 `exp(-age / 40ms)` 加权线性回归，启动 90 px/s、总矢量限速 4,000 px/s、衰减时间常数 350 ms、停止 10 px/s。采用真实 rAF 时间差与指数解析积分，跨停止阈值准确截至停止时刻；最多 128 个样本，同时间合并，不足两点或跨度不足 8 ms 不启动。抬指终点保留，静止不更新实际移动时间；隐藏取消当前惯性并阻断隐藏前触摸重启。手指／Pencil 隔离、保存／同步、冻结 Viewer、锁定依赖不变。原生测试仅使用独立库；本轮另有用户明确授权，仅备份替换“远程仓库1”插件三文件，保留设置、缓存、恢复与同步检查点，不操作 PDF。0.5.5 回滚包保留，实机 iPad 手感由用户确认。另修复标准 Link `/Dest` 被保存合并 guard 错误拒绝：在 lineage 已验证的同序页间映射叶页引用，保留既有页树及安全拒绝，不改协议或恢复格式。最终证据见 GENERAL_ACCEPTANCE.md。


## 历史 0.5.5 保存与内存候选（2026-10-13）

三端继续共用同一源码与三文件，版本统一 0.5.5。iPad/iOS 输入入口自动保存为停笔 3 秒，自动保存起始间隔至少 10 秒并按上一轮耗时适应（冷却上限 30 秒）；桌面仍为 1 秒空闲。自动保存过程中新增修订回到调度器，不连续追写；手动保存和可控关闭绕过冷却但仍等待输入边界和精确修订确认。移动端完整保存／合并使用共享重任务槽，先取得槽再进入写入队列，避免跨 Reader 内存峰值与锁顺序死锁。减少重复 PDF 字节复制；最后 Reader 关闭并完成待处理任务后释放内存检查点，磁盘恢复记录与删除记录保留。延长保存间隔会扩大强退前尚未持久化的编辑窗口；比较与写入之间的同步竞争窗口仍存在。

本轮原生验证仅 `/Users/jiajia/Documents/ObReader-Apple-Test`，主库和此前 `远程仓库1` 部署目录不操作。保留 0.5.4 回滚包；当前验证与交付见 GENERAL_ACCEPTANCE.md。Mac 移动模拟不代表实体 iPad 内存／崩溃验收。


本项目将带自定义批注功能的 Mozilla PDF.js Viewer 集成到 Obsidian 插件。当前阶段是 0.1general 通用候选（插件 0.5.7），目标为 Windows、macOS 和 iPadOS 共用同一源码与三文件插件。当前范围及验证状态见 [GENERAL_ACCEPTANCE.md](GENERAL_ACCEPTANCE.md)；[IPAD_ACCEPTANCE.md](IPAD_ACCEPTANCE.md) 保留 0.3.0 iPad 鼠标候选的历史记录与验收矩阵，[MACOS_ACCEPTANCE.md](MACOS_ACCEPTANCE.md) 保留早期 macOS 证据。

## 历史：0.5.4 自适应工具栏、惯性滚动与 Pencil 高亮

取消阅读区宽度 880px 以下强制双行，按实际控件所需空间决定换行；撤销／重做从字体字符改为 PDF.js 同机制的 16px SVG 遮罩图标。菜单和 Viewer 偏移跟随工具栏实际高度。增加手指抬起后的渐减惯性滑动，新接触、Pencil／鼠标操作、工具或文档切换取消惯性，保持手指不能绘制的规则。三端版本同步为 0.5.4，保留 0.5.3 输入策略和保存／同步／缓存核心，冻结 Viewer 与依赖不变。原生验证仍限指定测试库；仅在授权目录备份替换三文件，实机 iPad/Pencil 结果待设备复验。最终证据以 GENERAL_ACCEPTANCE.md 当前版本记录为准。

颜色／参数浮层外部点按收起但不取消工具。Pencil 在 OCR 式文字层的可信 pen 手势使用实际 caret 端点构建选区，再调用原生高亮；不会把手指拖动改成绘制。自由高亮 writer 实际输出 `/Ink /IT /InkHighlight`，共用保存核心据结构标记准确绑定，普通 Ink 保持原分类；新编辑器顺序按页记录，旧身份兼容。最终默认并发 194/194、离线自然退出 0；原生模拟完成两页文字／自由高亮保存重开。实机结果仍待用户验证，已失败内容可使用原有恢复命令取回；不直接操作用户 PDF 或旧恢复副本。

## 历史：0.5.3 工具栏收敛与 iPad 输入分工

0.5.3 继续共用 Windows、macOS、iPadOS 的三文件插件、保存／同步核心和桌面／移动入口。0.5.2 的 **显示阅读器状态栏** 设置保持默认关闭，缺失旧设置时也按关闭处理；开关即时更新当前插件实例的所有 Reader 和 popout，不重载 iframe。状态与恢复动作继续保存在 Reader 内部，现有恢复 Notice 和命令不依赖状态栏显示。

主工具栏用 32 px 的 **↶**/**↷** 撤销／重做按钮替代 **编辑**。删除移到 **更多**；继续使用 PDF.js 原生保存按钮，不复制出第二个保存按钮。主、次工具栏中的插入图像和打印按钮隐藏，冻结 Viewer 内的代码与节点保留。五个原生批注工具和桌面中键工具轮盘仍保留。缩放组宽 64 px；页码输入为 36 px，超过四位后每增加一位增加 8 px。已有四个缩放 glyph、百分比和自定义值保留；`↕` 表示 **适合整页**，沿用整页适配值，不表示 fit-height。0.5.1 后台预热和增量缓存索引不变；不改冻结 Viewer 或升级依赖。

iPad 输入按用户确认的当前工具自动分工：批注工具处于活动状态时，Apple Pencil 兼容的实际 `pen` 指针输入负责绘制、编辑或擦除；`NONE` 模式下笔输入平移 PDF。手指触碰 PDF 页面只用于导航平移，不触发页面链接、文字选择或批注交互；Reader 工具栏和侧栏控件仍可操作，原生 `input`／`contenteditable` 输入例外继续保留。实体 iPad／Pencil 事件投递仍待硬件验收；原生 CDP 触摸与 Pencil 模拟只覆盖自动化路径。当前不宣称压力感应、悬停、掌拒／掌形 AI 或 Scribble 支持。

冻结默认并发 `general-0.5.3-validation-default-2026-10-12T01-09-11-432Z` 为 193/193 通过、无失败／取消／跳过，Node 自然退出 0；离线记录 `general-0.5.3-validation-offline-2026-10-12T01-09-11-430Z` 也自然退出 0。独立库原生 UI 记录 `general-0.5.3-ui-native-1791767589751.json` 通过桌面与移动 SDK 路径，移动输入策略仅在移动入口启用；Pencil 策略模拟记录 `ipad-pointer-policy-1791767312635-32422.json` 自然退出 0。触摸和 Pencil 使用自动化事件模拟，不能当作 iPad 硬件或实际 Pencil 验收。最终独立审计未发现 P0 阻断。测试均在 `/Users/jiajia/Documents/ObReader-Apple-Test` 独立库内完成，并核验实际 Vault／插件身份；CDP loopback 端口按运行时归属发现。

最终候选包 SHA-256 为 `7e1b80709418a9ab3b1d3bae6d74120c113b3a2f422be44675baebd8d112f5cc`，含且仅含 `main.js`、`manifest.json`、`styles.css`；`main.js` SHA-256 为 `365755bccfe8d8887dcbd5c75aeccf84a64058846a6b69cf9e75e0e568611a4f`。Mac 暖启动记录 `general-0.5.3-native-1791767610375.json`：插件加载时、任何 Reader 打开前预热 167 ms，406 次 stat 检查、0 次缓存二进制验证读取、0 次解压；同实例后续 ensure 0 ms／0 次检查，首个 Reader 等待 0 ms、工具可用约 125.1 ms；第二个 Reader 0 次检查、工具可用约 93.6 ms。外部修改刷新、实际鼠标脏批注与远端三身份合并、旧检查点保护、重复事件不重开、保留 90° 旋转与页宽的同 iframe 刷新均通过。此为 Mac 样本，不构成 iPad 性能承诺；最终 handoff 确认桌面启用、自动保存开启，Reader/view/gate 为 0。按授权，已将候选三文件替换到 `/Users/jiajia/Documents/Documents/Obsidian/远程仓库1/.obsidian/plugins/pdf-web-reader`。记录 `general-0.5.3-target-replacement-1791767654581.json` 确认新文件与候选逐字节一致，旧 0.5.2 文件备份在 `.deploy-backups/2026-10-12T01-14-14-542Z/remote-vault-1-three-files`；用户数据一致，缓存、恢复文件、同步检查点和 PDF 未触碰。目标库运行实例未重载；用户应保存、关闭 Reader 后重载插件，iPad 同步后确认版本 0.5.3。主分支推送由主代理另行完成，以 Git 历史为准；不创建 GitHub Release。Windows 与 iPad/Pencil 实机验收仍待设备确认；Mac 移动模拟、CDP 触摸或 Pencil 模拟均不替代实际设备.

## 历史：0.5.2 状态栏与工具布局调整

0.5.2 继续共用 Windows、macOS、iPadOS 的三文件插件、保存／同步核心和既有桌面／移动入口。新增 **显示阅读器状态栏** 设置，默认关闭，旧设置缺失时也按关闭处理。更改设置会立即作用于当前插件实例的每个 Reader，包括 popout，不重新载入 iframe；关闭时不创建状态栏 DOM。Reader 内部保留最新状态与恢复动作，重新打开状态栏可再次显示；恢复错误 Notice 和 **恢复最近的 PDF 自动保存副本** 命令不依赖状态栏开关。状态文本及文档路径不进入诊断导出。

工具布局保留五个原生 PDF.js 批注工具、中键工具轮盘和 **编辑** 中的撤销、重做、删除、保存。单独的可点击 **工具** 轮盘按钮已移除。缩放组宽 80 px，提供 `auto`、`1:1`、`↕` 页面高度和 `↔` 页面宽度预设。0.5.1 后台预热与增量缓存索引保持不变；0.5.2 不修改冻结 Viewer 或升级现有依赖。

Mac 原生检查只在 `/Users/jiajia/Documents/ObReader-Apple-Test` 独立测试库进行，CDP 使用 loopback endpoint `9230`。已授权的安装替换只限 `/Users/jiajia/Documents/Documents/Obsidian/远程仓库1/.obsidian/plugins/pdf-web-reader` 中匹配的 `main.js`、`manifest.json`、`styles.css` 三文件，更新前备份旧三文件，保留设置、缓存、恢复副本和同步检查点。Windows 与 iPad 硬件结果不由 Mac 验证代替；iPad 实机验收及最终安装由用户执行。0.5.1、0.5.0 与 0.4.0 包继续作为历史回滚参考。当前冻结结果由 [GENERAL_ACCEPTANCE.md](GENERAL_ACCEPTANCE.md) 记录。

## 历史：0.5.1 重启缓存与自动预热修复

用户实测 iPad 重启后打开仍等待 10–15 秒，等待一分钟也未改善。0.5.1 在插件启用后直接安排后台预热，独立于布局回调和 DeferredView；失败记录并有界重试，前台可补试。完成标记增加按资源绑定的大小、修改时间和创建时间索引；重启只检查元数据，变化项才读内容和做 SHA-256。旧标记首次升级需核验一次建立索引；没有可信 stat 的平台安全回退。真实使用的少量 HTML/CSS/模块字节仍校验，去掉移动入口重复哈希同一模块的开销。冻结 Viewer、406 个资源、三端平台入口与 PDF 同步合并保持共用。

原生测试仍只用 `/Users/jiajia/Documents/ObReader-Apple-Test`；按用户最新明确授权，仅将三文件替换到 `/Users/jiajia/Documents/Documents/Obsidian/远程仓库1/.obsidian/plugins/pdf-web-reader`，先备份，不操作该库中的 PDF 或主动重载其 Obsidian 实例。iPad 实机复验由用户完成，证据与结果见 GENERAL_ACCEPTANCE.md 的 0.5.1 章节。

## 历史：0.1general 0.5.0 资源加速与跨端合并

本轮从 `ad05bb1` 接续。布局就绪后预热资源，最多四项并行，已有缓存先校验，仅缺失或损坏资源解压；同一插件实例复用成功准备结果及已验证模块字节。冻结 Viewer 不裁剪，402 个 vendor 文件未变，运行时 406 项。只新增锁定 pdf-lib 1.17.1 与内嵌许可证，独立浏览器 Worker 按需处理合并，不引入运行时 Node/Electron。

共用核心监听当前打开 PDF 的修改事件，并在前台及视图激活补查。本地未保存操作及已确认检查点均参与 UUID 合并；整条批注按有效编辑完成的时间戳、逻辑序号与设备／操作 ID 排序，删除记录写入 PDF。写前恢复、磁盘复核、写后验证和新修订保护保留。确认后在同一个 Viewer 刷新并恢复阅读状态和工具，撤销栈随文档替换重置。加密、页面结构变化、身份无法证明时暂停并恢复，不强行覆盖。

最新验证、候选包、耗时及未解决项以 GENERAL_ACCEPTANCE.md 的 0.5.0 章节为准。仅使用指定独立测试库；Windows 与 iPad 实机仍待用户验收。保留 0.4.0 回滚包；不创建 Release、不部署主库、不继续扩展 Chrome teardown 调查。

## 历史：0.1general 通用候选（插件 0.4.0）

开发起点源码为 40b1f09，包含 Windows c52e522 与 macOS 1034e0e 的工作。Windows、macOS、iPadOS 共用核心和同一发布包；插件运行时只使用 Obsidian 与标准浏览器 API，不依赖 Node/Electron。冻结 PDF.js Viewer 的 402 个文件保持不变，运行时资源共 404 项。插件 onload 时根据 Obsidian 平台状态一次性选择桌面或移动入口：桌面入口使用资源 URL 与弹窗协调，移动入口使用 Blob 模块／Worker 路径且不安装桌面弹窗协调。保存、恢复、编辑和指针行为使用共享代码。该实现说明不构成实体设备兼容性证明；目前不声称 Windows 或 iPad 实机验收通过；当前候选、证据及哈希见 [GENERAL_ACCEPTANCE.md](GENERAL_ACCEPTANCE.md)。

修订后的完整默认全套已在源码稳定时完成，所有产品功能断言通过（133 项中 131 通过、2 项进程退出／清理状态异常）。这两项仅归类为测试基础设施，不否定产品功能结果。`/Users/jiajia/Documents/ObReader-Apple-Test` 指定独立 Mac 测试库的功能核验已完成：生命周期脚本 19/19、Node 自然退出码 0；移动控件操作和功能断言均通过，但脚本在 `finally` 恢复 `emulateMobile(false)` 时收到 `Promise was collected`，报告保持 `incomplete`、Node 退出码 1。按修订口径，这项功能后清理异常不推翻完整通过的功能断言，也不称整个脚本正常通过。冻结候选包和哈希见 [GENERAL_ACCEPTANCE.md](GENERAL_ACCEPTANCE.md#冻结默认全套与候选文件)。原定十轮／十次复验门槛已撤回；不触碰用户主库，不创建 Release，也不进行额外 Chrome/Puppeteer/Crashpad/CDP 调查或依赖升级。本候选按用户授权正常推送 `main`，实际提交以 Git 历史为准。Windows 与 iPad 实机验收仍待设备检查；0.3.0 归档候选与 0.2.0 macOS 回滚包继续保留。

Mac 原生验证和部署仅允许独立测试库 /Users/jiajia/Documents/ObReader-Apple-Test；不部署用户主库，不创建公开 Release。iPad 最终部署由用户执行，实际 WKWebView 和鼠标事件投递仍待实机验收。磁盘比较与写入之间仍存在竞争窗口，强制退出或系统终止也可能绕过异步保存／关闭流程，不能承诺无损恢复。

后文的 0.3.0 与 0.2.0 章节及其余 Apple 交接审计均为历史记录。

## 历史：0.3.0 iPad 候选阶段（2026-10-11）

本阶段目标为 iPad Pro 2018、iPadOS 26.6、Obsidian 1.14.4 的启动、五工具、编辑保存及外接鼠标交互。Luna Max 子代理负责运行时、加载器、鼠标修复与独立审计。插件运行时采用浏览器 TypedArray、Base64、DecompressionStream 和内嵌 SHA-256，移除 Node/Electron 依赖；构建脚本继续使用 Node。完整冻结 Viewer 与离线三文件分发保留，manifest 改为 `isDesktopOnly: false`。

自动保存仍默认开启，保留串行写入、修订确认、冲突暂停和待保存恢复副本；绘制或拖动操作完成后合并保存。移动端不安装桌面弹窗协调。工具栏保留，并提供可点击轮盘及编辑动作入口；按实际 Pointer Event 区分鼠标、笔和触摸，本阶段没有 Pencil 压感、手写识别或触控手势设计。模块和 Worker 支持经校验资源 URL 与 Blob 回退，销毁时释放关联资源。

Mac 的 `app.emulateMobile(true)` 验证只能证明桌面 Obsidian 的移动分支；真实 WKWebView、iPad 外接鼠标按键传递和命中行为由用户部署后验收。实机证据获得前始终标记“iPad 外接鼠标待验收候选”。仅在 `/Users/jiajia/Documents/ObReader-Apple-Test` 独立实例验证，不部署主库或公开发布。强退恢复限制、基准比较至写入的竞争窗口、历史偶发 PDF 打开超时继续保留，不能因移动分支测试通过而删除。

## 历史：0.2.0 macOS 阶段更新（2026-10-11，保留 10 月 8 日实现）

2026-10-11 接续整合 Windows `c52e522`：保留本阶段 Mac 的文档身份、所属窗口、修订确认、恢复副本和关闭协调，引入工具轮盘、右键临时橡皮擦及延迟右键选择保护。文字输入停止 1 秒后使用 PDF.js 的保焦提交再自动保存，保留输入焦点和光标；组合输入与绘制手势仍等待结束。修复保存重开交互测试在页面未完成加载、命中旧矩形时发出双击的问题，测试改为核对实际页面和命中对象。整合后的验证结果以 MACOS_ACCEPTANCE.md 的 2026-10-11 记录为准，10 月 8 日证据仅对应之前的候选。

首次 Mac 开发基线为 `4b74bf9`；本轮接续 Windows main `c52e522`，原始 Mac 0.2.0 备份提交为 `781b3cc`。开发目录为 `/Users/jiajia/Documents/Documents/Codes/26_7_PdfRD_OB`。外层测试库完整复制至 `/Users/jiajia/Documents/ObReader-Apple-Test`，打开前对源与副本全部 60 个文件验证大小和 SHA-256，共 44,931,378 字节。快照继续保留原始 0.1.4，不随候选修改。

仅适配当前 Apple Silicon Mac、macOS 27.2、Obsidian 1.14.4；安装器为 1.12.7，Electron 39.8.3。iPhone/iPad 延后，保留 `isDesktopOnly: true`、完整冻结 Viewer、桌面 Node 资源运行时及离线三文件发布方式。本文后面的移动方案和历史未适配描述保留作背景，不属于本轮实施或兼容性承诺。具体开发和审计由 Luna Max 子代理执行。

0.2.0 修改 Reader 所属窗口消息监听与计时器绑定，支持弹出及迁移清理；跨窗口二进制判断不再依赖单 realm 的 instanceof。文档身份独立于可变路径，打开中 PDF 改名/移动同步保存目标。保存请求在排队入口固定原文档身份、TFile、基准和 iframe，切换后不会将旧 PDF 字节写到新目标。

自动保存默认开启，支持关闭并持久化设置。创建、删除、移动、调整大小、撤销/重做纳入修订追踪；保存串行执行，期间新增修订仍保持待保存。每次写入先持久化待保存 PDF 与元数据到插件 `.recovery`，核对磁盘基准后写入并读回验证。冲突/失败暂停自动覆盖，恢复命令写入独立 `PDF Recovery/` 文件；成功确认清理对应候选。基准比较与写入之间仍有同步竞争窗口，Obsidian API 无原子 compare-and-swap。恢复目录自身写入失败、强制退出和系统进程回收不能承诺无损恢复。

可控关闭及 Reader 文档切换在 SDK 拆除前等待精确的 documentId/openRequest/revision 准备完成确认；正在进行的笔画和组合输入到达边界后，暂时冻结新输入，直到关闭或取消。自动保存关闭或冲突暂停时只持久化独立 draft 恢复候选，不隐式写回原件、不清除 dirty；确认失败保留标签供重试。强制卸载或退出可绕过此拦截，更新前仍须保存并关闭所有 Reader。原生测试和部署支持配置 Vault、configDir、CLI、Chrome 和 loopback CDP，每个原生动作核对目标身份；部署拒绝启用中的插件和任何活动 Reader，完整备份旧插件后只装三文件。主库与公开 Release 不在授权范围。

弹出窗口整体关闭也须先准备同窗所有 Reader。0.2.0 对经 ownerWindow/workspace 身份核实的 SDK popout split 实例安装关闭协调，并在 beforeunload capture 阶段阻止 SDK 提前销毁；任一失败、文档身份变化或新增 Reader 就取消已准备对象并保留窗口。精确准备完成的 leaf 保持 SDK 的同步 detach 行为，已提交关闭允许延迟 beforeunload。迁移、最后 Reader 离开和卸载会清理自己的监听／wrapper。此入口依赖当前已核验的 Obsidian SDK 私有实例关系；若失配，只提示先保存／恢复，不全局猜测拦截。强制退出不承诺异步准备成功。

核实过的 `workspace.moveLeafToPopout` 入口也先完成保存／恢复准备。窗口迁移保持 documentId，递增 openRequest 并轮换 rendererGeneration；新 Viewer realm 重载已确认原件或精确的持久化 draft，保留修订、dirty 和冲突暂停。消息由所属窗口 realm 发送，继续严格校验 parent 来源。未拦截的 DOM 重载仅能恢复最近匹配的持久化检查点，额外未序列化编辑可能丢失；尚未核验返回主窗口的其他 SDK 入口，使用前须先保存／恢复。

原生基线、候选验收、默认并发与串行复验的结果和未解决项见 [MACOS_ACCEPTANCE.md](MACOS_ACCEPTANCE.md)。后台 focus-emulated 的 Electron 验证与系统真实前台操作明确区分，不用 Chrome harness 代替 Mac 原生证据。

以下两段功能及自然退出结果属于早期 Mac 候选的历史记录，不代表当前 0.4.0 验收结果。

本轮另修复已保存文字批注在 NONE 模式右拖擦除后，Cmd+Z 只恢复模型而未恢复 AP 的显示缺口。桥接层复用冻结 Viewer 的正常 reset/render 方法，仅协调精确保存批注，保留原对象和撤销重做栈；显示任务不参与保存边界，实际保存确认期间可延后，模式／会话变化和异常均清理。原先仅验证 AP 点击区不足以证明字形恢复：原生像素证据确认点击区已显示而页面画布仍为空。最终补充精确受影响页的正常 NONE-mode 重绘，清理派生 modified-ID 缓存后重置该页并进入既有渲染队列，不修改批注存储、历史或保存修订。新增真实可信按键、阻塞 ACK、原页面画布 ROI 的像素往返，以及保存重开像素回归。并发测试的一次退出挂起已定位为 Chrome 残留 Crashpad 继承 stderr；测试在核对自有浏览器退出且断开后释放其读端，保留人工介入的诊断记录，最终两种全套均自然退出。历史 PDF 打开未确认的偶发根因仍未证实，不能与该退出问题混为一谈。

最终同构建验证：默认并发 82/82、串行 82/82、离线通过；19 个 Mac 原生场景实际完成，包含真实弹窗关闭后的自动注销。诊断改为不改变 SDK 同步 detach 返回语义，并从稳定窗口观察、撤销测试绑定；旧通知遮挡与诊断干扰记录保留，不能当作产品缺陷已确定。交付仅本地候选，未推送或部署主库。详见验收记录和交付 JSON。

## 历史接续任务与交付边界

- 用户决定将 Apple 适配开发接续到 macOS；Windows 留作回归环境。
- 最新产品代码基线：`85da5549df4912300fe80191ed26a7f14a860aa4`，插件版本 `0.1.4`。
- GitHub 仓库：<https://github.com/XxX-42/26_28_ObReader>；当前产品分支是 `main`。
- 此交接文件在产品提交之后单独提交；克隆最新 `main`，不要停在旧版本提交。
- 交接时 Apple 适配尚未实施；本轮 macOS 状态见上文更新。`isDesktopOnly: true` 和历史 Windows 验证必须保持真实、可追溯。
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

## 历史功能合同（原 Apple 交接时记录）

插件 ID 是 `pdf-web-reader`，自定义 View 类型是 `pdf-web-reader-view`。最低 Obsidian 版本为 `1.14.4`；历史 0.1.4/0.2.0 的 `isDesktopOnly` 为 `true`，历史 0.3.0 iPad 候选改为 `false`。这是插件声明和测试范围，不代表已经确定 Apple 最低系统版本或完成 iPad 实机验收。

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
- 0.1.4 基线为手动保存。0.2.0 候选默认启用自动写回：有效编辑后 1 秒合并保存，文字停止输入后保焦提交，提交/失焦也触发保存；组合输入和绘制手势等待结束。设置可关闭自动保存，`Cmd+S` 仍立即请求手动保存。修订号及宿主确认决定未保存状态。
- 0.1.4 关闭或重载不负责保存；0.2.0 可控关闭具有保存／恢复流程。禁用、热重载和部署前仍须显式保存并关闭 Reader，不能依靠强制退出完成保存。

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

## 历史 Windows 验证证据与边界

0.1.4 产品提交前已有完整 Windows 运行结果：`npm test` 32/32，通过三文件离线功能测试。原生测试库完成安全重载，运行实例确认 0.1.4、正确资源 hash，并打开 14 页测试 PDF；没有修改用户 PDF 原件。

2026 年 10 月 7 日交接复验重新构建后，默认 `npm run test:release` 在 npm test 阶段得到 31/32：下划线回归的 `reopenFixture` 等待宿主 opened 计数达到预期时超时 90 秒，位置为 `tests/underline-regression.test.mjs:586`，调用发生在旋转场景循环。该次不是几何断言失败，流水线未继续执行 offline 阶段。随后同一产物运行 `node --test --test-concurrency=1 tests/*.test.mjs` 得到 32/32，约 28.3 秒；单独运行 `npm run test:offline` 也通过五工具创建及保存重开。没有修改产品代码或测试来规避失败。并发默认运行存在间歇重开超时，确切原因仍待定位，不应把串行通过写成默认流水线始终稳定。

已执行的交互回归包括旧 Square 内创建 Square 和 Ink、旧 Square 上选文字创建 Underline、旧 Underline 上再次 Underline、旧批注上 FreeText 与数字输入保护、旧 Highlight 上再次 Highlight，以及保存重开。退出工具后双击旧 Square 可明确进入对象编辑，实际拖动可移动；同模式 editId 切换明确目标也有回归。

不能扩大这些证据：当前 0.1.4 交互回归没有实际点击验收 resize 手柄、橡皮擦加 Undo、评论弹窗的完整矩阵。下划线几何回归包含 0/90/180/270 度场景，但不等于五种工具全部完成四旋转、缩放和打印的完整矩阵；触屏、Apple Pencil、iOS 软键盘更不能据 Windows 测试宣称通过。

测试诊断 JSON/PNG/PDF 位于忽略的 `tests/artifacts/`，不会随克隆到 Mac。源测试和公共 fixture 会随 Git 交付，可重新运行。诊断目录中的早期 timeout 图片或 partial 文件不是最终结果；读取最终 JSON 和测试退出状态。

## 历史 Apple 深度启动审计（移植前探针）

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

## 历史 Apple 系统版本边界

不能把“Apple 多平台”解释为所有历史 macOS/iOS 版本。开始开发前需要明确最低 macOS、Obsidian installer/Electron、iOS/iPadOS 和 Obsidian mobile 版本。

- 当前 bundle 含 private class methods；Safari 15 引入这类语法，形成至少 iOS/iPadOS 15 的语法下限线索，但不证明整个插件支持 15。
- Safari/iOS 16.4 引入 Compression Streams。若只用原生 DecompressionStream，应据真实特性探针设边界；支持更早设备则需要内嵌解压 fallback。
- WebCrypto subtle 受 SecureContext 限制，Obsidian 自定义 scheme 是否提供该能力必须实际探测。
- 最新 PDF.js FAQ 的 Safari 版本表不能直接当成当前冻结 5.7.192 fork 的认证结果。
- macOS 桌面 Obsidian 使用 Electron/Chromium，不应拿 Safari 测试替代其原生验收。
- 桌面 Obsidian app 更新与 installer/Electron 更新有区别；minAppVersion 不能独自表达所有浏览器引擎要求。

## 历史移动交互和宿主缺口（实施前审计）

### 工具栏与触控

使用当前生产 `createViewerDocument`、内联 CSS、obsidian-bridge 和测试 PDF，在 Chromium 触摸嵌入视图中成功收到 ready/opened，并等到工具启用。320 CSS px 宽时 Highlight 右界约 332，Ink 约 361，FreeText 约 390；后两者中心在视口外。390/430/768 宽时五个工具中心可达。按钮始终 28×28，normal density。

应先改窄屏布局，再扩大触控点击区；单纯改为更大按钮会加重溢出。需要覆盖 iPhone 竖屏、iPad 分屏、横竖切换和软键盘展开。上述布局探针不是 iOS 实机点击或手势验证。

Underline/Highlight 要验收长按选字、系统选择手柄、多行选区及已批注文字上的二次标注。Square/Ink 的新笔画在 annotation layer 起始，该层没有明确的绘制模式 touch-action 管理；当前 pointercancel 可能沿默认非 aborted 路径结束并提交部分笔画。需要定义手指/笔绘制、滚动、双指缩放及取消策略，不能对整个 Viewer 永久 touch-action:none。

FreeText 需要验证软键盘、中文 IME/组合输入、输入数字不切换工具、输入结束后的框选/移动，以及 VisualViewport 和安全区布局。iPad 外接键盘还应验证 Cmd+S、1–5、重复退出和非美式布局。

### macOS 弹出窗口

iframe 从 contentEl 创建，但宿主消息监听与 timer 使用 ambient window。若 View 所属窗口与模块全局不同，可能在错误窗口上监听 ready/save 消息；这是源码风险，尚未原生复现。

验证普通窗口、popout、窗口迁移及关闭后监听清理。需要时使用 contentEl.win 或 ownerDocument.defaultView 管理 View 所属窗口，并检查跨 realm 的 ArrayBuffer 类型判断。不要只替换为当前聚焦窗口，因为聚焦窗口未必是 Reader 所属窗口。

### 保存和生命周期

0.1.4 没有活动 PDF onRename 同步。0.2.0 已注册 rename 事件，同步 TFile/path/navigation，并向桥发送当前路径；documentId 为独立稳定会话标识，改名不重开。检查与写入期间发生移动时安全拒绝并保留恢复候选。

当前冲突检查是 readBinary 后 compare，再 modifyBinary，存在外部同步恰在检查与写入之间修改文件的窗口。不能用只支持文本的 Vault.process 假装获得 PDF 二进制原子事务。保留冲突拒绝和可恢复副本，明确实际保证范围。

0.1.4 的 onClose 直接清理 iframe 和编辑状态，没有未保存关闭保护。0.2.0 已增加有界 flush 与待保存恢复候选；强制终止仍可能绕过生命周期，不能承诺此时无损。此段描述 0.1.4 历史缺口；本阶段依用户决定默认自动写回 PDF，并保留关闭选项和恢复候选。

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

Mac 上先确认 Chrome/Chromium 的实际可执行文件位置，再通过 `PDF_READER_CHROME` 或 `PDFJS_CHROME` 指定；测试现会查找 Mac Chrome、Windows Chrome/Edge，并支持显式路径。示例仅适用于 Chrome 确实安装在该位置的情况：

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

上述入口现使用 tests/native-config.mjs 的参数及身份核对。Mac 原生隔离实例使用 loopback CDP，background wrapper 保持同一持久 session 的 focus emulation 并在 finally 恢复。新增 test:native:lifecycle 专门核验 Mac 保存及窗口生命周期。

`scripts/deploy.mjs` 使用 OBSIDIAN_VAULT_PATH 与 OBSIDIAN_CONFIG_DIR，Mac 不选默认库且限于独立测试库。运行前通过实际 app.vault 身份核对，并拒绝启用中插件和所有活动 Reader。

## 安全部署与数据规则

- 使用独立测试库和 fixture 副本；不要对用户书籍原件做写入验收。
- 部署前先确认所有 Reader 已保存，并关闭或安全禁用插件。deploy 脚本拒绝任何活动 Reader，但保存和关闭仍由操作者先完成。
- 旧插件连同自有缓存会移动到项目 `.deploy-backups/`，可恢复；不是永久删除。
- 替换磁盘 manifest 后，运行中的 Obsidian 可能仍缓存旧 manifest。检查磁盘、manifest map、运行实例三者一致；若 CLI 可用，安全 reload 后再次确认。
- CLI/CDP 只用于测试，不是最终插件依赖。Windows background wrapper 仅在开发测试期间做 focus emulation，不应搬入生产逻辑或冒充真正前台/移动验收。
- 用户明确要求不要干扰其正常浏览，不应反复要求其切前台，也不应强制操作其他 Vault 或窗口。
- 任何无法安全保留未保存编辑的重载、升级或窗口关闭都应先停下。不得用 git reset --hard、覆盖工作树或删除广泛目录来“清理环境”。

## 历史 Apple 适配实施顺序（原计划）

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

## 历史给 Mac Codex 的接续指令（已被本阶段范围覆盖）

以下保留最初的接续指令，不再作为当前实施范围。新会话应使用上文 0.1general 当前阶段及 GENERAL_ACCEPTANCE.md；IPAD_ACCEPTANCE.md 是 0.3.0 iPad 鼠标候选的历史矩阵。部署和具体实现仍须遵循当前授权及用户指定路径。

> 你接续开发 https://github.com/XxX-42/26_28_ObReader 。先确认最新 main，完整阅读 MACOS_HANDOFF.md、README.md 和 vendor/pdfjs-generic-legacy/PROVENANCE.md，再检查 Git 状态及运行入口。当前产品基线为 0.1.4，产品提交 85da554；Windows 已通过核心回归，但 macOS/iOS/iPadOS 尚未原生验收。目标是同一组三文件插件离线支持 macOS 和 iOS/iPadOS，保留正常打开 PDF、五种标准批注、12345 快捷键、保存重开和二次编辑。先确定我的 Mac 开发目录、独立测试库、最低系统版本和可用设备；不要把 Windows D 盘路径或原生脚本直接搬过来。按交接说明先建立 Mac 桌面基线，再移除移动端 Node 依赖并验证真实 Obsidian 资源和 Worker 链路，然后处理触控、软键盘、窗口与保存生命周期。不得损坏用户 PDF、扰动正常浏览、删减完整资源或换成上游未定制 PDF.js。具体审计和开发使用可用的 Luna Max 子代理，保持验证证据和未通过项清晰，不能仅改 isDesktopOnly 就宣布适配完成。
