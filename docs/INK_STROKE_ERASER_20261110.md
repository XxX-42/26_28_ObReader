# Ink 按笔划擦除验收（2026-11-10）

## 基线与发布包

- 功能分支：`codex/ink-stroke-eraser`，基线 `eb697bb41ca51da1b710698d639723a320702de2`。
- 核对远端 main：`54420167964cc11ddea7955500fac7cd7fc0e51a`；没有合并或改写 main。
- 正式安装包保持 **0.15.2**。当前仓库完整 build 的版本较旧，不能直接覆盖安装包。
- `scripts/patch-installed-ink-eraser.py` 只将三个运行时资源的精确差量及 Host 分派/跨窗口适配补入已安装包，其他既有改动保留；遇到上下文不一致立即失败。
- 正式 main.js SHA-256：`bba92541c3084c5dd15ad07e3ef2652eb4b8d0e995aa84ef3a4d21f5293fb3ba`。
- 资源 payload：`1ede9c462c18531fa252996ff1927c70d2725477f3a10aef2c9bb1abd5ea4321`。

## 行为与边界

沿实际 Bezier 路径命中，只删除命中的完整笔划。空白包围框不触发擦除；同一个 InkEditor 的第一、三笔保持，UUID 不变。每个对象每次手势共用一个可更新的撤销命令；同一手势可继续擦除该对象其他笔划。最后一笔沿原 editor.remove 生命周期删除。

DrawingEditor 仅新增同步私有 outlines、边界和 draw layer 的窄适配；原生 Ink 路径变更进入序列化。撤销恢复原始路径也必须显式序列化，不能用 null 误表达为删除。路径 NaN 占位继续使用既有序列化。

补齐了三个实际暴露的持久化边界：

1. 工具切换后，原生 Ink 与外置替代对象可能并存；擦除解析到有效外置对象，并屏蔽过时原生绘制。
2. 水合对象后续编辑保留 embeddedRef；带复制标记的 Ink 恢复时禁止执行粘贴偏移。原生来源身份与墓碑保持，不生成替代 UUID。
3. Host 将 Ink 的 embedded 更新/墓碑送入既有 JSONL，不送进原 PDF erase/restore；跨窗口操作使用 structuredClone 转到 Host realm 后仍通过原 Canonical 校验。Date 等非 JSON 对象仍被拒绝。

没有新增 WAL schema、操作类型、持久化撤销栈或第二套 Annotation Store。其他原生批注的现有分派保持。保留 Pencil 捕获补丁、鼠标/手指输入所有权、链接批注保护和保存确认。

## 测试事实

| 验证 | 结果 |
| --- | --- |
| 旧 eraser 曲线空白点击 | RED：错误删除整个对象 |
| 新 Ink 路径、UUID、原生/外置、多笔手势、撤销/重做、保存重开及最后一笔 | PASS；浏览器运行时异常为零 |
| 新 Host Ink 更新/墓碑及跨 realm（含非法 Date 拒绝） | 2/2 PASS；原包 RED |
| Selection、Pencil、生命周期、JSONL/WAL 等相关集 | 56/56 PASS |
| 完整 autosave 与 annotation interaction 文件 | 2/2 PASS |
| trusted mouse | PASS |
| iPad policy 浏览器模拟 | 隔离运行 PASS；并发运行曾有一次既有 80ms 时延门限失败，证据保留 |
| 完整 Annotation Host 文件 | 14/15；旧 native erase journal recovery 用例失败，已在未修改基线复现同一失败，未改断言 |
| build / vendor | PASS；406 嵌入资源，402 vendor 哈希验证 |
| Offline 五工具、保存重开、批量删除 | PASS |

没有宣称整个仓库所有 gate 均通过。真实 iPad、Windows 本轮未验收。

## macOS 实际运行

独立 Apple 测试库使用与正式部署完全相同的 main.js。通过实际 CDP 鼠标与保存按钮完成 3→2→1→0，每阶段关闭重开，最终截图为空白页；UUID 和 embeddedRef 保持，已配对 PDF SHA-256 全程不变：

`db47e85214673548fa1b8e2628d03d81dac840c6cafa7174efd40cc62fb1db94`

限制：新建、尚未配对的合成 PDF 在首次保存时仍会触发 **既有 V15 身份配对元数据追加**；已验证完整原字节前缀保留。本轮没有修改该协议，不能将此首次配对描述成整个 PDF 字节未变。后续擦除/保存均无 PDF 写入。

## 正式部署

正式库原 Reader 有未确认的 Ink，且因跨窗口 Canonical 错误不能保存。先备份外置数据和三文件，使用与最终 Host 等价的临时 realm 入口适配，经正常保存路径确认 **31/31**，再替换三文件、重载并重新打开原 PDF。没有丢弃未确认操作，也没有绕过保存校验。

- 备份：`/Users/jiajia/Documents/ObReader-Deployment-Backups/ink-stroke-20261110-135312`
- 证据：`/Users/jiajia/Documents/ObReader-Test-Evidence/ink-stroke-20261110`
- 保存前、保存后、部署后正式 PDF SHA-256 均为：`ef74fc59bc5e10b27049ae0515bc278e0a442fc1209e7d051a766933a838a6f8`
- 重载确认版本 0.15.2；原 PDF 正常打开，sourceMismatch=false，52 条持久化批注恢复，新的 stroke eraser 方法已加载。

