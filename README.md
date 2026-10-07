# PDF Web Reader for Obsidian

This project packages the modified PDF.js viewer as a desktop-only Obsidian
plugin. The plugin opens a vault PDF in its own view, transfers the PDF bytes
to the bundled viewer, and writes saved bytes back to that same vault file.
It does not require the Windows launcher or the PDF.js development server.

## Development layout

- `plugin/` contains the Obsidian plugin shell.
- `viewer-adapter/` contains the host-to-viewer message bridge.
- `vendor/pdfjs-generic-legacy/` is the frozen viewer/runtime snapshot from
  PDF.js fork commit `c80e5a952` on `windows`.
- `scripts/` contains build and deployment commands.
- `dist/pdf-web-reader/` is the complete installable plugin output.

All project code and generated output live in this directory. The original
PDF.js repository is only the historical source for the frozen vendor build;
the build command reads the vendored snapshot and does not compile or modify
that repository.

## Build

Run from this directory:

```powershell
npm install
npm run build
```

The build verifies the SHA-256 manifest for the frozen Viewer before copying
`plugin/main.js`, `plugin/manifest.json`, and
`plugin/styles.css`, the viewer runtime, and the bridge into
`dist/pdf-web-reader/`. The runtime includes its worker, CMaps, ICC profiles,
fonts, locale data, images, and WASM decoders for offline use. PDF.js is
licensed under Apache-2.0; the license and snapshot provenance are included
with the vendor files.

## Automated browser checks

Install Google Chrome or Microsoft Edge, build the runtime, then run:

```powershell
npm run build
npm run test:offline
```

Set `PDF_READER_CHROME` to a browser executable if it is not found in the
standard Windows locations. The test starts a temporary static-file server
for the built bundle only; it has no PDF.js API, port-8888 service, or remote
network dependency. It opens a copied fixture through the same `srcdoc`
bridge protocol as the plugin, checks all five editor modes, annotation save
and reopen, and message validation.

## Install into the test vault

Build first, then run:

```powershell
npm run deploy
```

By default deployment targets
`D:\Documents\Obsidian\测试插件\.obsidian\plugins\pdf-web-reader`. Set
`OBSIDIAN_VAULT_PATH` to another vault only when intentionally testing there.
If this plugin folder already exists, deployment saves a timestamped backup
under this development directory's `.deploy-backups/` before replacing it.
The backup stays outside Obsidian's plugin scan. Deployment does not alter
other vault files.

In Obsidian, enable **PDF 阅读器**, then use the command palette action
**在 PDF 阅读器中打开当前 PDF** or the PDF file context-menu action
**使用 PDF 阅读器打开**. After enabling the plugin, PDFs opened normally from
the file browser also use this viewer. A PDF already open in the built-in
viewer is not replaced automatically.

## Obsidian packaging and distribution status

### Local full-folder installation

The current `dist/pdf-web-reader/` output is a complete local plugin folder:
`main.js`, `manifest.json`, and `styles.css` are at its root, while the
modified PDF.js runtime, worker, locale and other resources are under
`viewer/`. `npm run deploy` copies the **whole folder** into
`.obsidian/plugins/pdf-web-reader/`; the plugin ID and folder name match.
This full-folder copy is the supported way to test the current build.

The extra `viewer/` directory is plugin-owned runtime data, not another
Obsidian plugin. The host reads hidden plugin resources through
`Vault.configDir` and the public adapter resource APIs, while PDF contents are
read and written with the Vault binary-file APIs. Obsidian documents that
hidden configuration files are accessed through the Adapter API, and exposes
`configDir`, `readBinary`, `modifyBinary`, and resource-path methods in its
public API. See [Vault and adapter guidance](https://docs.obsidian.md/Plugins/Vault)
and the [Vault API reference](https://docs.obsidian.md/Reference/TypeScript%2BAPI/App/vault).
Consequently, copying only the three root files while omitting `viewer/` is
not a valid installation of this particular plugin.

The plugin shell uses the public `Plugin`, `EditableFileView`, workspace,
command, event-registration, and Vault APIs. Its PDF reader is a standard
file view derived from `EditableFileView`; it uses the file-view lifecycle and
file/path state rather than a generic `ItemView`. The view and listeners are
registered in `onload()` and cleaned up on unload. See the official
[Obsidian API declarations](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
for `EditableFileView`. `isDesktopOnly:
true` is set because this embedded runtime is currently supported only in
Obsidian Desktop. The `main.js` entry is a CommonJS module exporting the plugin
class.

### Official Community Plugins directory: not ready for one-click install

The current package must **not** be described as directly installable from the
official Community Plugins directory. The official release workflow says the
installer downloads the release attachments `main.js`, `manifest.json`, and
`styles.css` (when present); it does not recursively install the repository or
an arbitrary nested `viewer/` directory. This plugin's `main.js` requires that
directory at runtime, so a release containing only the documented three files
would be incomplete. A manual installation of the entire `dist/pdf-web-reader`
folder works; that is different from one-click Community Plugins installation.
See [Submit your plugin](https://docs.obsidian.md/plugins/releasing/submit-plugin)
and the official [Obsidian releases repository](https://github.com/obsidianmd/obsidian-releases).

This source tree also is not yet submission-ready: it has the manifest under
`plugin/manifest.json` rather than at repository root, and has no root-level
license for the new plugin code (`viewer/LICENSE` covers the PDF.js snapshot,
not this plugin). The official submission guide calls for a root README,
`LICENSE`, and `manifest.json`, plus a GitHub release tagged to the manifest
version with the required individual assets. No packaging redesign or
Community Plugins submission is included in this migration.

### Manifest and default-open notes

The current manifest has a well-formed ID (`pdf-web-reader`), semantic version
(`0.1.1`), `minAppVersion`, and `isDesktopOnly`. Before public submission:

- Replace the Chinese display name **PDF 阅读器**: the current official
  manifest guidance asks for Basic Latin characters in plugin names.
- Replace `author: "Local development"` with the actual maintainer name.
- Update the description to satisfy the directory's current style rules; in
  particular, it currently ends in Chinese punctuation rather than the
  required ASCII period.
- Verify `minAppVersion: "1.5.0"` against the oldest Obsidian build actually
  supported. The public APIs used here predate that version, but this migration
  was tested only on the current desktop build, not on Obsidian 1.5.0.

See the official [Manifest reference](https://docs.obsidian.md/Reference/Manifest)
and [plugin submission requirements](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins).

While enabled, the plugin routes ordinary PDF file opens in Obsidian—including
opens initiated from the file browser or ordinary file links—to this viewer by
default. It does not take over embedded PDFs, and it does not change Windows'
system-wide `.pdf` file association. A built-in PDF view that was already open
before the plugin was enabled is not switched automatically; close and reopen
the file to use this viewer. This avoids replacing a view that might contain
unsaved form input. The reader uses manual save: save to the vault before
closing its tab or disabling/reloading the plugin.

`Plugin.registerExtensions(extensions, viewType)` is a public API
([official API declarations](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)),
but it is not a safe way to replace Obsidian's built-in PDF registration in the
current tested app: the built-in `pdf` view is already registered, duplicate
registration throws, and unregistering only removes that registry entry
rather than restoring the core viewer. The plugin therefore leaves the core
PDF registration untouched and routes an ordinary open request for a workspace
leaf through a reversible wrapper around the public
`WorkspaceLeaf.setViewState()` method. This wrapper is a monkey patch, **not an
official extension point for replacing core view behavior**. It is scoped to
the plugin's `app`, is disabled on unload, and restores the original method
only if the wrapper is still installed. Other plugins that patch the same
method, or future Obsidian changes to the file-opening path, may conflict;
revalidate this behavior after Obsidian upgrades. In the current tested
version, ordinary file-browser PDF opens reach `setViewState()`.

## Obsidian 使用说明（最小迁移版）

插件 ID 为 `pdf-web-reader`，Obsidian 中显示名称为 **PDF 阅读器**。
可在命令面板运行 **在 PDF 阅读器中打开当前 PDF**，或在 PDF 文件右键菜单中选
**使用 PDF 阅读器打开**。PDF 使用插件内置的 PDF.js Viewer 与 Worker 打开，不依赖
`localhost:8888` 服务。

五个工具快捷键如下，主键盘与数字小键盘都可使用：

| 按键 | 工具     |
| ---- | -------- |
| `1`  | 下划线   |
| `2`  | 矩形框   |
| `3`  | 荧光笔   |
| `4`  | 自由画笔 |
| `5`  | 文字框   |

再次按当前工具的快捷键或按反引号（`）退出工具。输入框和可编辑文本里的数字
不会切换工具；快捷键切换也不会自动展开参数面板。

**MVP 目前是手动保存。** 修改后请先点 Viewer 次级工具栏里的“保存到仓库”
（标题提示“保存 PDF 到仓库（覆盖当前文件）”），或使用 `Ctrl+S`，
待状态提示确认保存完成后再关闭该标签页或禁用/重载插件。Obsidian 自定义视图的关闭流程不能阻止
用户丢弃未保存编辑，因此关闭标签页或禁用/重载插件都不会替代保存。

### 当前 Windows 测试仓库

本机验证仅针对外层测试仓库 `D:\Documents\Obsidian\测试插件`，Vault ID 为
`d9f81db5f3fef6ee`。完整构建与部署后，可只重载这个插件并运行原生应用测试：

```powershell
npm run build
npm run deploy
& 'D:\Applications\Obsidian\Obsidian.com' 'vault=d9f81db5f3fef6ee' 'plugin:reload' 'id=pdf-web-reader'
npm run test:native
```

原生测试会在该 Vault 的 `PDF迁移测试/` 下新建一份带时间戳的 PDF 副本，并通过
Obsidian CLI/CDP 验证默认打开、快捷键、五种批注创建、保存和重新打开、颜色修改、
删除及本地文件打开拦截；第二阶段会在验证所有现存 Viewer 文件均已保存后，测试插件
禁用时使用 Obsidian 内置 PDF 视图、重新启用后恢复默认 Viewer，并确认 Markdown、图片及
嵌入 PDF 不被误接管。测试 PDF、Markdown 和图片副本都会保留，便于手工复查；机器可读
结果与截图写到 `tests/artifacts/native-*-<timestamp>.{json,png}`。脚本不会删除其他 Vault
内容，也不会触碰原始 PDF.js 仓库。
