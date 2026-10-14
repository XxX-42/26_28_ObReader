# 本地运行日志（开发改动）

插件启动后自动记录，无需开启设置。Windows、macOS、iPad 共用相同实现，不依赖 Node/Electron。

在插件设置中点击 **“导出 JSON”**，或使用命令面板的 **“导出 PDF 阅读器诊断”**。导出文件写入 Vault 的可见目录 `PDF Reader Diagnostics/`，iPad 无需访问隐藏目录。原有诊断快照保留，新增 `runtimeLog.records`，包含保留的历史会话和当前会话的详细运行记录；Reader 已关闭或插件已重启也可导出之前落盘的记录。

导出先取出 Viewer 待发送记录，再写入并封存当前日志分卷。具备 append/rename 的 Adapter 逐块写入单个 JSON，成功后才将临时 `.partial` 文件改为 `.json`；不具备这些能力时生成多个有效 JSON，主文件的 `runtimeLog.parts` 列出其余分卷。提供日志时需包含这些分卷。原始日志不删除、不改写。

`runtimeLog.complete`、`droppedRecords` 和 `readErrors` 明确报告写入、解析或读取缺失；`interruptedSessions` 列出没有正常结束记录的历史会话，其末尾可能在强退时丢失。出现这些情况不能视为完整证据。`capturedAt` 与 `cutoffSequence` 定义当前会话的导出截止点，导出期间产生的后续记录留给下次导出。导出按分卷读取，不一次拼接所有历史记录；单个源分卷仍需完整读取。

位置：`<Vault>/<配置目录>/plugins/pdf-web-reader/.logs/`，默认配置目录是 `.obsidian`。
每个启动会话产生 `UTC时间-会话编号-分卷号.log`。文件为 UTF-8，每行一个 JSON 记录，可用文本编辑器打开。

- `session.start/end`：插件会话起止。
- `function.begin/end/error`：函数名、调用编号、单调时钟耗时；异步函数在 Promise 结束时记录结果。
- `user`：点击、双击、指针类型及按钮、滚动、快捷键、输入/输入法事件。记录操作元数据，不记录输入值或 PDF 字节。
- `error/unhandledrejection/console.warn/console.error`：异常消息和堆栈；异常字段有长度上限。
- `viewer`：来自 Reader 的事件，带文档会话 ID 和 renderer generation；`row` 为 Viewer 原始 JSON 记录。
- `log-loss`：写入失败或缓存溢出时的显式缺失标记，不能将这种会话视为无缺失日志。

函数覆盖：插件、Reader、设置类方法，主入口顶层命名帮助函数，自有 Viewer 适配层命名函数，保存/同步/合并 Worker 客户端/重任务协调器的公开方法。冻结 PDF.js 不修改；其异常和控制台报错仍记录。匿名回调及独立模块内部的私有函数并未逐个改写，不能声称第三方库每一次内部调用都有日志。

每秒批量串行写入；有 append 的 Adapter 直接追加，没有 append 时另写分卷，避免重新读取完整日志。主进程待写缓存上限约 1 MiB 字符，Viewer 上限约 256 KiB 字符；约 8 MiB 字符后续写新分卷，历史分卷保留。

单独 **“立即写入本地运行日志”** 命令代码已注释保留，不再注册；内部 `.log` 持久记录继续用于历史留存和 JSON 导出。正常关闭 Reader 前同步取出尚未发送的日志，插件卸载时尝试写入末尾；系统强退仍可能丢失尚未落盘的末段。

日志保留真实异常消息/堆栈，异常本身可能包含文件路径或业务字符串；不会主动转储 PDF 内容、编辑器参数/返回值或消息中的二进制数据。
