# 0.1general 并发故障调查记录

状态：历史调查档案。用户已修订当前候选验收口径；停止 Chrome、Puppeteer、Crashpad 与 CDP 根因调查、扩展诊断和依赖升级。第 18 轮冻结默认全套的产品功能断言已通过，两项退出／清理异常归类为测试基础设施问题；指定 Mac 测试库的功能核验也已完成。移动控件报告保留 `incomplete` 状态和 `Promise was collected` 清理异常，不把整个脚本报告称为通过；按当前口径，已完成并通过的产品功能断言满足本地候选门槛。当前状态与候选哈希见 [GENERAL_ACCEPTANCE.md](GENERAL_ACCEPTANCE.md)。下列运行及其失败记录完整保留，但不再按旧的进程退出门槛决定产品功能验收。

## 基线与证据保留

源码基线为 `40b1f09`，包含 macOS `1034e0e` 与 Windows `c52e522`。
原始 0.3.0 默认并发结果为 92/95，三项失败均保留。原日志、截图、诊断、候选包和 macOS 回滚包已按 SHA-256 归档到 `general-original-2026-10-11T15-44-34-039Z`，后续运行不会覆盖该目录。

以下批次按当时的旧验收规则运行。日志保留真实 Node 退出码、信号、运行参数、源码哈希和失败附件；当时把强制清理和非零浏览器退出列为批次失败。现行口径将纯测试进程退出／关闭异常与产品功能结果分开记录；只要完整产品功能断言均已执行并通过，这类异常本身不阻断当前候选评估。历史结果不作改写。

| 默认并发批次 | 结果 | 源码冻结 | 结论 |
| --- | --- | --- | --- |
| `general-validation-default-2026-10-11T16-09-32-087Z` | 102/105，Node 自然退出 1 | 否 | 保留调查证据，不计验收 |
| `general-validation-default-2026-10-11T16-23-35-422Z` | 108/110，Node 自然退出 1 | 是 | 重开与鼠标编辑失败，不计验收 |
| `general-validation-default-2026-10-11T16-52-26-680Z` | 106/110，Node 自然退出 1 | 是 | 启用诊断；Worker 启动、焦点、退出和清理单测失败，不计验收 |
| `general-validation-default-2026-10-11T17-12-40-035Z` | 111/112，Node 自然退出 1 | 是 | 启用诊断；浏览器测试本轮通过，TERM/KILL 清理单测失败，不计验收 |
| `general-validation-default-2026-10-11T18-06-39-526Z` | 第 1 轮 114/114；第 2 轮 112/114，Node 自然退出 1 | 是 | 驱动升级后，鼠标编辑状态和 Chrome 自然退出码 2 仍失败；停止批次，不计最终验收 |
| `general-validation-default-2026-10-11T18-17-30-302Z` | 112/114，Node 自然退出 1 | 是 | 启用诊断；新增追踪遮蔽函数标记导致鼠标测试前置断言失败，另有第 3 次打开超时；不计验收 |
| `general-validation-default-2026-10-11T18-25-35-808Z` | 112/115，Node 自然退出 1 | 是 | 启用诊断；两项重开超时及工具栏测试对额外渲染暂停回调的计数敏感，不计验收 |
| `general-validation-default-2026-10-11T18-33-19-563Z` | 115/117，Node 自然退出 1 | 是 | 启用诊断；跨页面更新删除活动空文字框的新增回归明确复现，Chrome 自然退出码 2，保留修复前证据 |
| `general-validation-default-2026-10-11T18-54-40-319Z` | 114/118，3 失败、1 超时取消，Node 自然退出 1 | 是 | CSP 隔离已替代三项测试的全 URL Fetch 暂停；两项功能通过但 Chrome 退出 2，鼠标测试直接 draw 绕过渲染队列，下划线总时限取消；不计验收 |
| `general-validation-default-2026-10-11T19-26-19-724Z` | 116/118，2 失败，Node 自然退出 1 | 是 | 同版本官方 Chrome for Testing 差分；全部 PDF/编辑功能通过，两项进程清理失败，不计验收 |
| `general-validation-default-2026-10-11T19-42-36-289Z` | 125/127，2 失败，Node 自然退出 1 | 是 | 原安装 Chrome；异步定向进程查询及独立 Crashpad 后，全部功能通过，但两项 Chrome watchdog 退出 2，停止十轮批次 |
| `general-validation-default-2026-10-11T19-46-09-509Z` | 123/127，4 失败，Node 自然退出 1 | 是 | 显式单变量关闭 MacAppCodeSignClone 的诊断仍触发 watchdog／强制清理；拒绝将该开关作为修复，不计验收 |
| `general-validation-default-2026-10-11T19-49-23-095Z` | 122/127，5 失败，Node 自然退出 1 | 是 | 同版本官方 Chrome for Testing；全部功能通过，退出 2／强制清理仍失败，停止十轮批次，不计验收 |
| `general-validation-default-2026-10-11T20-01-03-234Z` | 127/129，2 失败、0 取消、0 跳过，Node 自然退出 1、信号为空 | 是 | 同版本 Chrome for Testing 的 TEMPDB 单变量默认并发诊断；桌面工具栏和 FreeText 两项均因 Chrome teardown watchdog 退出码 2 后触发已验证进程组 SIGTERM。将 Crashpad 数据库移到系统临时目录未证明修复，也不计验收 |
| `general-validation-default-2026-10-11T20-09-58-366Z` | 129/133，4 失败，Node 自然退出 1 | 是 | 显式 Worker 关闭诊断；Worker 已销毁但 FreeText 仍自然退出 2，另有工具栏、鼠标退出失败及新清理单测的 2ms 调度假设失败，不计验收 |
| `general-validation-default-2026-10-11T20-15-22-264Z` | 132/133，1 失败，Node 自然退出 1 | 是 | 显式提前 500ms 采样；FreeText 自然退出 0，但未生成有效采样文件；鼠标测试仍 watchdog 自然退出 2，无终止信号，不计验收 |
| `general-validation-default-2026-10-11T20-27-18-240Z` | 128/133，5 失败，Node 自然退出 1、信号为空 | 是 | 第 17 轮；产品功能断言通过，失败项为 annotation、toolbar、openLifecycle 的 Chrome teardown watchdog（自然退出 2）、FreeText 的强制进程组清理，以及单独的 Process fixture 单测。500ms 采样没有阻塞关闭；栈采样均超 8 秒、未启动或没有可用栈。退出／清理问题保留为测试基础设施历史证据，不作为产品功能失败 |
| `general-validation-default-2026-10-11T20-32-33-875Z` | 131/133，2 失败，Node 自然退出 1、信号为空 | 是 | 第 18 轮冻结默认全套；所有产品功能断言均完成并通过。`desktop-toolbar` 外部信号后被强制清理，FreeText 子进程退出码 2；两项归类为测试进程／清理基础设施状态，不阻断功能候选。指定 Mac 测试库功能核验已完成 |

## 历史调查记录（已停止）

### PDF 重开

最新失败中 d0–d8 正常打开。d9 的 Worker 10 仅出现主线程发出的初始 `test`，没有 Worker 返回的 `ready`、`test` 或 `GetDocRequest`；加载任务和 `app.open` 均未完成。阻塞发生在 PDF 解析之前，不能归因于批注不可见。

Puppeteer 的自动附加流程会暂停新 Worker，并发送 `Runtime.runIfWaitingForDebugger` 恢复执行。现有失败证据没有对应 Target/Runtime 时序，因此当时不能认定它就是根因；后续的被动 CDP 记录作为历史诊断证据保留。

首轮 CDP 探针的健康结果暴露了诊断缺口：Puppeteer 的 public Target 类型把专用 Worker 映射为 `other`，探针因而漏掉 Runtime 命令。已改为使用原始 CDP 类型，并补齐首次打开失败时的持久化记录；针对性健康运行记录了十次 Worker 附加及恢复命令。该探针缺陷不构成产品 Worker 根因。

测试驱动也存在版本范围差异：[Puppeteer 官方支持表](https://pptr.dev/supported-browsers)将原使用的 24.43.1 对应到 Chrome 148，将 25.12.0 对应到 Chrome 154；本机安装的是 Chrome 154.0.8037.99。历史上曾将开发依赖锁定到 25.12.0，并适配原生测试的连接状态 API。只读连接指定测试库成功，其文档标题为 Obsidian 1.14.4，安装器 UA 为 1.12.7，内嵌 Chromium 为 142；这次连接不是完整原生验收。驱动源码比较未发现自动恢复 Worker 的顺序变化，不能断定原始阻塞由版本不匹配造成。该版本记录为调查背景；当前不进行依赖升级或浏览器版本差分。

驱动升级后的鼠标单项运行新增一次 Square 双击进入编辑失败。事件记录显示工具模式完成事件已到达，但只收到一次指针按下／释放，没有 `dblclick`。Puppeteer 25 的 `Mouse.click` 使用 `count` 指定次数，旧 `clickCount` 参数未产生双击；已迁移对应调用，保留原编辑断言和期限，复验待完成。`Mouse.down/up` 和原始 CDP 的 `clickCount` 仍有效，不一并改写。此新增失败与原先的并发超时分开记录。原生测试配置目录存在 `obsidian-1.14.4.asar`，与文档标题一致；UA 中的旧安装器版本单独记录。

打开确认另已改为核对当前请求、实际 loading task、PDF proxy 和首页面准备状态；过期全局 `documentloaded` 事件不能确认新文档，销毁会取消等待。针对性回归通过，但该改动尚不能解释或宣称解决上述 Worker 启动阻塞。

新的原始 CDP 记录证实，部分停滞 Worker 的恢复命令已经成功返回且执行上下文存在，仍没有启动握手。请求拦截是进一步调查的候选原因：[Puppeteer 25.12.0 的 NetworkManager](https://raw.githubusercontent.com/puppeteer/puppeteer/puppeteer-v25.12.0/packages/puppeteer-core/src/cdp/NetworkManager.ts)在 Fetch 暂停先到达时，随后使用 Network 事件所在会话构造请求；页面 Fetch 与 Worker Network 事件可能来自不同会话。[同类驱动问题及修复](https://github.com/hardkoded/puppeteer-sharp/issues/3397)保留了暂停事件所属会话。`18-33-19` 的健康 underline 记录有 18 对跨会话请求，均为 Network 先到达、暂停与继续使用页面会话，79 次继续命令全部成功。因此已确认易受影响的设置，但尚未捕获本项目错误配对的失败，不能把候选原因标记为已解决。

使用本机安装的 Puppeteer 25.12.0 实际 `NetworkManager`，受控复现已确认：先到达的页面 Fetch 暂停事件与随后到达的 Worker Network 事件配对后，`Fetch.continueRequest` 发往 Worker 会话，返回协议错误；调用者的 `request.continue()` Promise 仍被驱动当作已完成。这是驱动的确定性回归证据，记录为 `general-fetch-session-reproducer-2026-10-11T18-43-34-258Z-54364-685b0745-2e36-4571-affb-6bb8cb5d9ab9.json`，故意退出 1，不能计为验收通过。真实失败是否由该顺序触发仍待进一步证明。测试网络隔离已改为经过受控验证的浏览器响应策略，避免对允许的本地 Worker 请求进行 Fetch 暂停；独立受控检查已证明页面、srcdoc、Blob Worker 及网络模块 Worker 的禁止来源请求被阻断，第二个本地服务器收到零次请求，Chrome 自然退出 0；CSP 并不是浏览器全局网络防火墙或顶层导航沙箱。完整默认批次仍失败，因此不能宣称全部超时已经修复。

### 文字批注渲染与焦点

压力失败中，输入前批注层已存在。编辑时页面渲染状态变为运行中，原焦点离开文本框；另一次失败中，用户点击工具栏后，PDF.js 的 `pause(false)` 定时回调再次把焦点移入批注包装元素。

冻结 Viewer 中的页面 reset 会隐藏批注层，隐藏会导致浏览器原生失焦。缩放的延迟重绘与该调用链相符，但需要记录 reset 的实际调用理由，再决定同视口保护范围。真实缩放和旋转必须继续更新坐标及批注层，不能被保护逻辑吞掉。测试保留真实双击、逐键输入、焦点、批注可见及二次保存断言。

`18-33-19` 新增的跨页面回归使用实际第二页批注层及其当前视口，在第一页空文字框保持焦点和编辑状态时调用更新。更新前编辑器属于第一页当前层和共享管理器，显示尺寸约 147×50；更新后编辑器被删除。冻结 Viewer 的 `AnnotationEditorLayer.update` 无条件调用共享管理器的 `commitOrRemove`，因此另一个页面的相同视口更新也能提交当前编辑器。这一场景已得到修复前失败证据。针对性保护后鼠标单项 1/1、Chrome 正常退出 0；对应归档为 `general-open-focus-investigation/crosspage-green-1791744034048`，仍须补齐边界及默认并发验收。历史偶发失败是否来自同一接收页面，不能仅凭这一回归认定。

### 浏览器退出

失败的 Chrome 154.0.8037.99 输出 `Teardown watchdog expired; recording dump and terminating.`，随后自然退出码为 2；测试清理没有发送信号。Chromium 自身的 macOS teardown watchdog 是直接退出机制，底层阻塞阶段仍待线程栈和关闭时序证据确认；对应实现见 [Chromium 官方提交](https://chromium.googlesource.com/chromium/src/+/dc1ae3ada2dffe30971100b5b1d3185b1ad395c1%5E%21/)。不会通过关闭 watchdog、增加等待或把退出码 2 算作正常通过来解决。

清理单测另暴露已退出父进程与同组、未经验证的管道持有者之间的身份核对竞争。修正后的处理仅等待和终止验证过的测试资源；未经验证的持有者不会收到信号。该单测修复与真实 Chrome 阻塞分别记录。

最新健康关闭时间线显示，`browser.pages()` 枚举耗时 12.038 秒，随后两个页面关闭仅耗时 29/87 毫秒。Puppeteer 的页面枚举会初始化从未访问的初始空白页，在清理时引入新的 CDP 初始化工作。测试现可显式传入已创建的页面句柄，关闭这些页面后由正常 `Browser.close` 关闭剩余目标，不在清理阶段初始化空白页。相关单测要求自然退出码 0；该修正的默认并发效果及 watchdog 阻塞原因仍需复验。

另一个确定的清理故障来自 Chrome 已自然退出 0 后，全机同步 `ps` 查询超时，导致组状态不可核实。现已改为同一时限内异步查询明确 PID／组 ID；只有无输出的正常无匹配状态才视为空，其余错误及超时继续拒绝终止。新增回归核对查询进行中仍能收到子进程退出事件、查询失败不发信号、退出组为空及未经验证管道持有者的自行退出。清理与启动入口共 29/29 单元通过，独立源码审计无阻断。

普通 macOS Chrome 的 Crashpad 数据库并不随 `--user-data-dir` 自动隔离。统一测试启动入口使用 Chromium 官方支持的 [BREAKPAD_DUMP_LOCATION](https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/app/chrome_crash_reporter_client.cc) 为每个浏览器分配唯一目录；启动与清理记录不包含环境变量或 PDF 内容，原始 dump 不复制到交付诊断。八个并发空白浏览器均自然退出 0，但 `19-42-36` 全套仍有两项 watchdog。此后原安装 Chrome 和同版本 Chrome for Testing 的 Documents 路径隔离也均未达到验收门槛。`20-01-03` 的 TEMPDB 单变量差分将数据库放到系统临时目录，仍有两项 teardown watchdog、退出码 2 和经身份验证的 SIGTERM 清理；数据库位置变化不是已证实的修复，也不能据此判断历史 watchdog 根因。

`20-01-03` 全套中的六项 `browser-test-launch` 假启动测试验证 Crashpad 路径、所有权记录和清理元数据；六项通过仅说明测试基础设施工作，不是 PDF、批注或并发功能验收，也不抵扣两项浏览器失败。

[Chrome for Testing 官方差异说明](https://chromium.googlesource.com/chromium/src/+/main/docs/chrome_for_testing/README.md)列出自动化版本移除 CodeSignCloneManager。仅改变该特性的原安装 Chrome 单变量诊断仍失败；该诊断使用明确记录、带哈希的 Node preload，保持退出 watchdog、PDF 渲染和全部断言，未加入产品或正式测试入口。失败证明不能将该特性直接认定为根因。此处保留旧差分与当时尚未解释的退出记录；不再安排浏览器差分或根因追踪。

`18-06-39` 批次第 2 轮证明显式页面清理仍不足以解决 watchdog：FreeText 页面关闭耗时 28 毫秒，CDP 在调用 `Browser.close` 后约 194 毫秒断开，约 10.196 秒时 watchdog 触发，约 11.654 秒时 Chrome 自然退出码 2。鼠标测试也在页面关闭和 CDP 断开之后出现同类退出。两者均没有收到清理信号。当时计划在后续默认并发诊断中采集 Chrome 线程状态；该计划及采样结果均作为历史证据，不再继续调查。

显式 `PDF_READER_PDF_TEARDOWN_DIAGNOSTICS=1` 仅在公共 FreeText fixture 完成断言和失败快照后，使用原有 20 秒关闭预算等待 PDF.js 关闭。单项 1/1，Chrome 自然退出 0；默认并发 `20-09-58` 中，关闭准备 16 毫秒，当前 loadingTask、Worker 和 transport 均销毁，随后 Chrome 仍触发 watchdog，自然退出 2，无清理信号。因此等待当前 PDF Worker 不是已证实的退出修复，未修改产品关闭流程。独立审计确认诊断默认关闭、限定测试页面且未增加关闭预算。

该轮清理单测还证实了 `browserCloseCalledAt <= closeDeadlineAt + 2ms` 的调度假设在负载下失败。该单测问题及对原始绝对 deadline 的核对作为测试基础设施记录保留；不据此推断产品行为或重开浏览器调查。

## 历史补充与当前边界

同版本官方 Chrome for Testing 154.0.8037.99 的默认并发差分保留在 `19-26-19` 批次。全部浏览器功能断言通过且本轮没有 watchdog；FreeText 的 Chrome 自然退出 0，但清理中的全局同步 `ps` 查询超时，无法核实同组进程；另一项清理单测未在既有期限内确认其自行退出的管道持有者。该差分和退出异常均为旧门槛下的历史测试基础设施证据，不用于当前功能判定。

对等待输入结束的销毁路径，审计最初提出的泄漏判断经源码核对为误报：`dispose → clearScheduledWork → resolveInputBoundaryWaiters(false)` 已清理当前等待者。本次新增真实文字输入、未确认保存、composition 和待打开请求的销毁回归，单项自然退出 0，未修改这条产品销毁逻辑。

鼠标新增失败进一步区分为测试前置条件错误：直接调用 `PDFPageView.draw()` 没有设置渲染队列优先页，导致绘制暂停。已改为使用实际 Viewer.update 和正常渲染队列，保留焦点、实际缩放、批注尺寸、保存重开和二次编辑断言；单项通过，仍待完整默认并发门槛。

旧计划要求十次默认全套复验和三次连续 0.3.0 全套通过；用户已撤回该门槛。第 18 轮满足冻结默认全套的产品功能断言条件；指定 Mac 测试库功能核验也已完成，详见 [GENERAL_ACCEPTANCE.md](GENERAL_ACCEPTANCE.md)。串行通过记录、历史浏览器退出结果和本文件中的诊断均不替代该核验；纯退出基础设施异常本身不否定已通过的产品功能断言。

Mac 原生操作仅允许 `/Users/jiajia/Documents/ObReader-Apple-Test` 独立实例；该测试库的功能核验已完成：生命周期脚本 19/19、Node 退出码 0；移动控件的产品功能断言均完成并通过，但脚本在恢复移动模拟状态时遇到 `Promise was collected`，最终报告保持 `incomplete`、Node 退出码 1。用户主库不在操作范围内。Windows 与 iPad 实机验证仍待用户完成，本地模拟结果不代替实机结论。
