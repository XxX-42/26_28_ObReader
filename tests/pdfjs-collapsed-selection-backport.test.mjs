import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const vendorRoot = new URL("../vendor/pdfjs-generic-legacy/", import.meta.url);
const [viewer, provenance] = await Promise.all([
  readFile(new URL("web/viewer.mjs", vendorRoot), "utf8"),
  readFile(new URL("PROVENANCE.md", vendorRoot), "utf8"),
]);

test("frozen TextLayerBuilder ignores delayed collapsed selection after pointer release", () => {
  assert.ok(/if\s*\(range\.collapsed\s*&&\s*!isPointerDown\)\s*\{[\s\S]{0,400}?continue;/.test(viewer),
    "the frozen Viewer must ignore a delayed collapsed range while retaining active-pointer selections");
  assert.ok(provenance.includes("#22134") && provenance.includes("#22137") &&
    provenance.includes("1a30040c83ca0785f455175b99b9051c84181883"),
  "the local PDF.js backport must identify its exact upstream provenance");
});
