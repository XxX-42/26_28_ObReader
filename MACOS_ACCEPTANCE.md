# macOS 0.2.0 候选验收记录

本阶段仅 macOS；iPhone/iPad 延后，isDesktopOnly 保持 true。未部署用户主库，未公开 Release，源码差异保留在当前工作树。

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
