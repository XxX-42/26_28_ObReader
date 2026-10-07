import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifyVendorHashes } from "../scripts/hash-vendor.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendor = path.join(root, "vendor", "pdfjs-generic-legacy");
const dist = path.join(root, "dist", "pdf-web-reader");

test("vendored PDF.js runtime matches its frozen SHA-256 manifest", async () => {
  assert.equal(await verifyVendorHashes(), 402);
});

test("vendored viewer retains all five controls and the 1–5 mode order", async () => {
  const html = await readFile(path.join(vendor, "web", "viewer.html"), "utf8");
  const js = await readFile(path.join(vendor, "web", "viewer.mjs"), "utf8");
  for (const id of [
    "editorUnderlineButton",
    "editorSquareButton",
    "editorHighlightButton",
    "editorInkButton",
    "editorFreeTextButton",
  ]) {
    assert.ok(html.includes(id), `Missing editor control ${id}`);
  }
  assert.match(
    js,
    /AnnotationEditorType\.UNDERLINE,\s*AnnotationEditorType\.SQUARE,\s*AnnotationEditorType\.HIGHLIGHT,\s*AnnotationEditorType\.INK,\s*AnnotationEditorType\.FREETEXT/,
  );
  assert.match(
    js,
    /case 49:\s*case 97:/,
    "The number row and numpad shortcuts must be present",
  );
});

test("built plugin contains the offline worker and local runtime resources", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(dist, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.id, "pdf-web-reader");
  assert.equal(manifest.isDesktopOnly, true);
  for (const relative of [
    "main.js",
    "styles.css",
    "viewer/web/viewer.html",
    "viewer/web/obsidian-bridge.js",
    "viewer/web/bridge.css",
    "viewer/build/pdf.mjs",
    "viewer/build/pdf.worker.mjs",
    "viewer/web/locale/locale.json",
    "viewer/web/cmaps",
    "viewer/web/standard_fonts",
    "viewer/web/wasm",
    "viewer/LICENSE",
    "build-info.json",
  ]) {
    await access(path.join(dist, relative));
  }
});
