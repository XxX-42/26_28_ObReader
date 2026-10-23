# Windows 0.14 Native 启动阻塞

2026-10-23，独立 Windows Native 测试中，同一份 Bridge 资源出现：

- 原资源的 Vault 相对路径长 230 个字符；DataAdapter 可读取 737,800 字节，但 `app://` fetch 失败。
- 将相同字节暂存到测试库内 35 字符的相对路径，`app://` 返回 200，字节数和 SHA-256 完全相同。
- SHA-256：`fbfb002b5e2d90b72a34fc45559661de0cd3a03a0f3fcde43d70b712c76e950e`。
- 临时探针文件已删除。具体 Windows URL 长度阈值尚未确定。

这证明阻塞位于资源路径加载，不能归因为 PDF、学习对象或 WAL。原路径包含冗长的 vendor 描述和完整内容哈希，加入 Vault 绝对路径后超过常见 Windows 路径长度。

最小修复只在 Windows 启用紧凑的可重建资源缓存目录：

`<plugin>/.asset-cache/v2/SHA256(JSON([bundleId, contentHash]))/`

完整 bundle 身份仍进入 256 位目录键；文件哈希、完整性标记、修复、并发排队和版本隔离全部保持。其他平台继续使用原目录。没有修改 PDF.js/vendor、PDF 或用户数据；不删除旧缓存。

先保留新的路径长度回归 RED，再实现适配。相关资源完整性、修复、并发与 stat-index 单元回归 38/38 通过。Windows Native 重新加载与真实学习链路仍需后续验证，不能以单元通过代替。
