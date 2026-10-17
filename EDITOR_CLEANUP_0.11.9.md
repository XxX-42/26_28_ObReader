# 0.11.9：编辑器清理与 LingQ 工具切换

## 基线与范围

- 基线：`a8f5f6ae89e134e60871e49ad1e05ad39bf6e2f7`（远端 0.11.8 功能分支）。核对时 `origin/main` 为 `07effedb925a81d5c581ad2d6578ecbcafc4b852`。
- 分支：`codex/ipad-editor-cleanup-0.11.9`；独立工作区，原工作区未提交改动未带入。
- 没有修改 PDF.js vendor、WAL/Sidecar 协议、同步合并、源文件写入或手指原生滚动算法。

## 已确认的故障链

批注存储中的删除占位行缺少可确认的 UUID/类型时，操作捕获原本会同步抛错。该捕获由 `AnnotationStorage.onModified`、`addCommands` 等观察回调触发，位于 PDF.js 创建绘图编辑器的调用栈中。异常中断了原生绘图会话后续清理；再次绘图可能访问已消耗的 Ink outliner，产生 `lines.at` / `last.subarray` 空值错误。

LingQ 开启状态和 PDF.js 工具状态原先独立：启用 LingQ 后仍可能处于 Ink 模式，已有输入优先级规则会正确拒绝词汇点击。问题在于显式进入词汇阅读时没有协调工具状态。

## 修复

- 将插件自己的观察、快照预检查、界面同步与取消清理异常隔离，保持原生模型方法的错误语义。Undo/Redo 和删除的观察预检查失败也不会跳过原始动作。
- 指针结束、取消、离开、丢失 capture 的清理分别释放 capture、移除指针状态；touch-action 刷新失败不能阻断后续清理。
- 保存、恢复、自动保存和导出准备失败返回失败并保留 dirty 状态。未完成的 Ink 提交只在提交成功后清除；没有伪造保存 ACK。
- 提前保存新建活编辑器的 UUID、类型、页码元数据，以解析后来的无载荷删除占位行。删除行不能生成 UUID。水合期间不分配身份；未验证的原生引用注册让位于现有身份握手。
- 显式启用 LingQ 在安全输入边界请求 READ；请求绑定文档、open request、renderer generation。Pencil、文字输入、composition 结束前不抢占；用户后来点击或通过键盘选的新工具优先。
- 诊断输入快照增加当前工具、LingQ 状态和有界捕获失败信息；Host 不收集失败消息内的 PDF 文本。

## 测试证据

- 完整测试集：840 项，838 项本轮整套运行通过；iPad pointer policy 与 mouse input 各有一项时序失败。随后对相同两项在基线、候选中分别串行对照，各 2/2 通过。尚不能将这两次失败确定归因于产品修改或基线；未删改原断言。
- 故障注入：观察器、Undo/Redo、删除身份、保存拒绝、pointercancel / pointerout / lostcapture 清理通过。
- 真实 Chrome/PDF.js：注入未知删除占位行后连续两次绘图、切换工具、拒绝不完整保存/导出通过；开启 LingQ 时持有 Pencil、迟到工具事件、异步 READ 切换、保存和后续词汇点击通过。
- 离线三文件 smoke：打开、五种工具、authenticated bridge、外置保存重开、批量删除及重开不复活通过。
- macOS Obsidian 独立测试库：后台渲染，使用 CDP pen 输入和 Obsidian eval API；两个 Ink 编辑器落盘、真实 ACK、LingQ READ 切换、关闭重开水合、再次关闭通过。测试源 PDF SHA-256 保持不变。脚本：`tests/native-editor-cleanup.mjs`。
- build 验证 402 个冻结 vendor 文件，生成三文件产物。已有关闭测试改为提取完整 `onClose` 方法，修正其固定 500 字符截断问题，保留 `flushDocument(250)` 断言。

## 限制

Chrome 的触控/Pencil 模拟和 macOS 后台渲染不代表真实 iPad WKWebView 验收。已被旧异常破坏的 iPad 内存绘图会话需要重载插件或重新打开 PDF；本次不会清除用户批注来掩盖该状态。身份确实不明的记录仍会阻止“保存成功”确认，但不会再中断绘图清理或否决用户关闭标签。
