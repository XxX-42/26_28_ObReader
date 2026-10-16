# 0.8.2：iPad 原生导航滚动

基线：main 427d79c3677e92964895d825cab536b89f43c5a8。
分支：codex/ipad-native-finger-scroll-0.8.2。

## 改动边界

页面手指接触只记录导航/选择抑制的生命周期，不执行 preventDefault、显式 pointer capture、scrollTop/scrollLeft 位移或自定义惯性。未选工具、未处于已有对象移动/缩放时的 Pencil 提前返回，交给浏览器。页面层使用 pan-x pan-y；活动文字输入保留控件行为。链接、按钮可正常激活。

选中批注工具的 Pencil 保留 PDF.js 原有编辑器路径；iOS 专属的活动笔触保护防止新接触抢占。旧数值惯性函数仍保留为未调用的历史代码，普通输入没有 startManualPointer 调用入口；它们的数值测试不是原生滚动验收证据。

不修改 WAL、迁移、合并、检查点、恢复协议或 PDF.js vendor，不升级依赖。桌面不使用新的触摸滚动路径。三端版本元数据统一 0.8.2。

## 证据与限制

- 改动前相关交互基线：15 项，13 通过、2 失败（旧 iPad 指针测试和鼠标工具模式等待）；原始日志保留。
- WAL 冻结回归：67/67。
- 构建、包装、选择、绘制生命周期和外置批注定向：最终 37/37；离线五工具创建、外置保存重开通过。
- 原有 iPad 大测试仍包含 touch-action:none 和手动惯性的旧契约断言，不能描述为已通过新原生契约。新浏览器测试单独验证实际触摸滚动和所有权。
- 浏览器工具模式使用公开 PDF.js API 设置，测试不代替原生工具栏点击验收。
- WKWebView 是否将无工具 Pencil 作为原生 pan，以及活动 Pencil 的 stylus TouchEvent/PointerEvent 顺序，需要 iPad 实机复验。Chromium/CDP 和合成事件不代表 iPad 实机通过。
- 全部失败尝试和测试夹具修复均留档，不继续扩展 Chrome teardown 调查。

## 部署

目标仅为用户明确指定的“远程仓库1”插件三文件。完整插件备份：
/Users/jiajia/Documents/ObReader-Deployment-Backups/native-scroll-0.8.2-20261016-123947

只替换 main.js、manifest.json、styles.css，保留设置、缓存、外置批注、恢复副本，不修改 PDF。候选包和文件哈希见 evidence/native-finger-0.8.2。

## 最终候选验证

新增可信触摸测试通过：阅读模式滚动约143px、Ink模式约155px，可信手指默认事件取消数0，显式手指捕获数0，未新增批注。活动笔触的合成非可迭代 TouchList 保护测试通过；不等价于实机 Pencil 验收。

最终组合定向 37/37；WAL 67/67；历史数值 helper 13/13（保持未调用，不代表原生惯性测试）。最终构建和离线 smoke 通过，402 个 vendor 文件核验不变。

已备份并替换指定库三文件，逐文件哈希一致、data.json 哈希不变。当前 Obsidian 打开的窗口为另一个 Documents 库，因此未对它执行重载；目标库下次重新加载插件后生效。本轮不操作任何用户 PDF。

独立 Luna Max 只读审计：当前源码无 P0/P1 阻断项。补强浏览器未捕获异常断言后再次通过，阅读/Ink 模式滚动分别140/150px。该测试使用活动编辑层而非已创建的 Ink canvas，画布旧 CSS 规则仅做静态检查；实机限制不变。
