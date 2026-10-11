# 0.1general 通用候选（插件 0.4.0）

目标是 Windows、macOS 和 iPadOS 共用同一源码、核心功能和三文件插件，通过各自平台入口运行。起点为 `40b1f09`，已包含 Windows `c52e522` 和 macOS `1034e0e`。本文件按用户最新决定记录 0.1general／插件 0.4.0 候选的验收范围。

## 核心与平台入口

资源校验、五工具、Pointer Event 鼠标行为、文档身份、修订确认、串行保存、冲突暂停及恢复副本共用。Windows/macOS 使用桌面资源入口与弹窗协调；iPad 使用移动模块和 Worker 入口，不安装桌面弹窗协调。平台入口在插件加载时固定；改变 Mac 的移动模拟状态后必须重新加载插件。

运行时只使用 Obsidian、标准浏览器 API 与内嵌 SHA-256；Node/npm 仅用于构建和测试。完整冻结 Viewer、离线三文件分发、`isDesktopOnly: false`、插件 ID、设置及既有恢复记录保持兼容。鼠标行为由实际 pointerType、按键和浏览器能力决定，工具、编辑、保存及诊断均有可点击入口。

## 当前验收口径

用户已撤回原“十次默认并发、连续三次旧版全套”及基于浏览器自然退出状态的门槛。当前口径要求一次源码冻结后的完整默认全套中，所有产品功能断言实际执行并通过，并在 `/Users/jiajia/Documents/ObReader-Apple-Test` 指定 Mac 测试库完成独立功能核验。测试进程的 watchdog、强制关闭或纯清理／退出状态异常单独归入测试基础设施记录，在功能断言完整通过时本身不阻断候选评估。不得把未执行、跳过或因异常中断的产品功能断言记为通过；真实用户可见 P0 功能阻断才是当前阻断项。

当前状态：冻结默认全套和指定 Mac 测试库的产品功能核验均已通过修订后的功能验收口径。Windows 与 iPad 实机验收仍待设备检查；iPad 最终安装由用户执行。本候选通过本地功能口径，按用户授权正常推送 `main`；不创建 Release，不部署用户主库。实际提交以 Git 历史为准；指定 Mac 测试库之外不做原生操作。移动模拟、可信 CDP 鼠标事件和无 Node 浏览器检查不替代 WKWebView 或实际操作系统按键投递证据，清单见 [三平台实机验收清单](IPAD_ACCEPTANCE.md#three-platform-actual-device-checklist)。

## 冻结默认全套与候选文件

`tests/artifacts/general-validation-default-2026-10-11T20-32-33-875Z` 是源码稳定时的完整默认全套记录：133 项中 131 通过、2 项因测试进程清理异常失败，Node 退出码 1、信号为空。`desktop-toolbar` 在外部信号后被强制清理，FreeText 子进程以退出码 2 结束。所有产品功能断言均已完成并通过；这两项测试基础设施退出状态不推翻功能结果。

本地冻结候选与校验值：

| 文件 | SHA-256 |
| --- | --- |
| [0.1general 插件 0.4.0 候选 ZIP](dist/pdf-web-reader-0.1general-0.4.0-candidate.zip) | `4e50caece1b50bee70caf493b298f980f8da8ff8449cc2c5102939eb56264e98` |
| [修订版 0.3.0 iPad 候选 ZIP](dist/pdf-web-reader-0.3.0-ipad-mouse-revised-candidate.zip) | `358e4286e7e06fb3e57d1279d4d3db167a931bc829c796b2ecbf81532f1c1d83` |
| 两个 ZIP 内的 `main.js` | `201ceee6cb7b713df3d2277e6d9934565b04661779e541e715c8a093163fb2cb` |

指定 Mac 测试库的功能验收已完成；当前记录不代表 Windows 或 iPad 实机通过。候选按用户授权正常推送 `main`，不创建 Release，也不部署用户主库；实际提交以 Git 历史为准。

## 指定 Mac 测试库功能证据

`/Users/jiajia/Documents/ObReader-Apple-Test` 的 `native-macos-lifecycle-20261011203625445.json` 报告记录 19/19 场景完成，Node 自然退出码 0。移动入口的 `native-mobile-controls-20261011203945627-a7862f73.json` 已完成全部产品功能操作和断言：可信鼠标创建 Square、撤销／重做、手动保存、重开后可见以及 PDF 字节一致。该报告的整体状态是 `incomplete`，Node 退出码 1：功能操作之后，在 `finally` 恢复 `emulateMobile(false)` 时收到 `Protocol error (Runtime.callFunctionOn): Promise was collected`。因此保留清理异常，不能称这份脚本报告整体正常通过；按修订口径，这项功能后清理异常不推翻已经完成并通过的功能断言。

`general-final-native-handoff.json` 于 `2026-10-11T20:41:12.893Z` 在唯一指定 Vault 中记录状态 `passed`：版本 0.4.0、桌面模式、插件启用、自动保存开启、Reader／View／gate 均为 0；未触碰主实例，物理 iPad 未验证。测试自有 popout leaf 已清理，插件保持 desktop false/mobile false；32 个旧恢复文件经字节核对保持不变。

归档证据：[0.1general 证据包](dist/general-0.1-evidence.zip)、[证据清单](dist/general-0.1-evidence.manifest.json)、[源码差异](dist/general-0.1-source.diff)。证据包共 63,415,082 字节、847 个文件，SHA-256：`98f9867d5ce798809c863ad8331a8284d1f5e322c14d4d77a8076f680c24ef49`；清单 SHA-256：`d1ef015dd459e2da9fbfdec35fa7e5a3e659222150c10b85572b92283181bc30`。

## 历史验证记录

此前 17 轮默认并发及其 Chrome/Puppeteer/Crashpad/CDP 诊断均为历史证据；不再扩展浏览器根因调查或升级依赖。历史 0.3.0 默认并发 92/95 的失败日志和截图继续保留。第 18 轮的当前记录与候选校验值见上节。

第十四轮 `general-validation-default-2026-10-11T20-01-03-234Z` 使用同版本 Chrome for Testing 和 TEMPDB 单变量诊断，129 项中 127 通过、2 失败、0 取消、0 跳过；桌面工具栏和 FreeText 两项遇到 Chrome teardown watchdog，浏览器退出码 2，清理随后向已验证进程组发送 SIGTERM。Crashpad 数据库目录变化没有证明修复。

第十五轮 `general-validation-default-2026-10-11T20-09-58-366Z` 为显式 Worker 关闭诊断，133 项中 129 通过、4 失败；FreeText 当前 Worker 完整销毁后仍自然退出 2，另有工具栏、鼠标退出和清理单测调度假设问题。

第十六轮 `general-validation-default-2026-10-11T20-15-22-264Z` 为提前 500 毫秒采样的显式诊断，133 项中 132 通过、1 失败；FreeText 正常退出但采样文件缺失，鼠标测试仍自然退出 2。

第十七轮 `general-validation-default-2026-10-11T20-27-18-240Z` 在源码稳定时运行了 133 项，128 通过、5 失败，Node 自然退出 1、无信号。产品功能断言通过；失败记录为 annotation、toolbar、openLifecycle 的 Chrome teardown watchdog（自然退出 2）、FreeText 的强制进程组清理，以及独立的 Process fixture 单测。500 毫秒采样没有阻塞关闭；栈采样均超过 8 秒、未启动或没有可用栈，不能据此声称取得了有效线程栈。上述进程和清理问题保留作基础设施历史证据，不标记为产品功能失败。

`browser-test-launch` 的六项假启动测试覆盖测试启动、Crashpad 目录及所有权／清理记录，只验证测试基础设施，不代替产品功能或指定测试库核验。

## 安装、实机验收与回滚

本地冻结的 0.4.0 候选 ZIP 已生成，校验值见上表；默认全套和指定 Mac 测试库功能核验已按当前口径完成。以下步骤仅适用于独立测试库，不适用于用户主库；历史 0.3.0 ZIP 不是当前候选。

1. 在独立测试库保存并关闭所有 Reader，禁用插件，备份完整 `.obsidian/plugins/pdf-web-reader/`，包括设置、缓存和恢复副本。
2. 在指定测试库使用冻结候选 ZIP 时，仅替换 `main.js`、`manifest.json`、`styles.css`。完全退出并重新打开 Obsidian，确认插件版本 0.4.0 后启用；无需安装额外运行依赖。此候选包不是公开发行版。
3. 在独立 Windows 测试库核对默认 PDF 路由、五工具、Ctrl+S、自动保存、保存重开后双击二次编辑、多视图、改名、右键菜单不误创建批注／拖动擦除、中键轮盘、滚轮及弹出窗口。Windows `c52e522` 只是修复右键菜单延迟选中文字时误生成批注；普通右键仍是菜单交互，没有新增右键创建批注功能。故障时核对冲突暂停、恢复副本和关闭行为。
4. macOS 仅使用上述独立测试实例执行桌面清单，将快捷键改为 Cmd+S，并检查窗口迁移与关闭。指定测试库的当前功能结果和清理状态见上文；移动控件脚本的 `finally` 清理异常不改写其完整通过的功能断言，也不记为整个脚本正常退出。
5. iPad 最终安装由用户在独立测试库执行；按 [三平台实机验收清单](IPAD_ACCEPTANCE.md#three-platform-actual-device-checklist) 检查真实 WKWebView、离线启动及外接鼠标。历史 iPad 专项矩阵保留在同一文档。
6. 记录实际设备、系统、Obsidian 版本及鼠标配置；系统没有投递到 WebView 的中键或右键事件不能标为通过。出现问题先导出诊断，再禁用插件并恢复完整备份。保留旧恢复副本，不通过删除它们绕过错误。

本轮不扩展 Pencil 压感、手写识别或触控专项手势。强退前未持久化的编辑、恢复目录自身写入失败以及磁盘比较与写入之间的竞争窗口仍有局限。本候选按用户授权正常推送 `main`；不创建 Release，不部署用户主库。实际提交以 Git 历史为准。
