import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const bridge = await readFile(new URL("../viewer-adapter/obsidian-bridge.js", import.meta.url), "utf8");
const controller = await readFile(new URL("../viewer-adapter/input/backlink-interaction-controller.js", import.meta.url), "utf8");
function extractFunction(name) {
  const start = bridge.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Missing ${name}`);
  const body = bridge.indexOf(") {", start) + 2;
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = body; index < bridge.length; index += 1) {
    const char = bridge[index], next = bridge[index + 1];
    if (lineComment) { if (char === "\n") lineComment = false; continue; }
    if (blockComment) { if (char === "*" && next === "/") { blockComment = false; index += 1; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "/") { lineComment = true; index += 1; continue; }
    if (char === "/" && next === "*") { blockComment = true; index += 1; continue; }
    if (["'", '"', "`"].includes(char)) { quote = char; continue; }
    if (char === "{") depth += 1;
    if (char === "}" && --depth === 0) return bridge.slice(start, index + 1);
  }
  throw new Error(`Unterminated ${name}`);
}

function fixture() {
  const functions = ["clearReaderBacklinkPresentation", "requestReaderBacklinksForPage",
    "applyReaderBacklinkPageResults", "onHostMessage"].map(extractFunction).join("\n");
  return vm.runInNewContext(`(() => {
    const window = { parent: {} };
    const document = { querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} };
    ${controller}
    const channel = "test-auth-channel", token = "test-token", rendererGeneration = "current-generation";
    const READER_BACKLINK_HIGHLIGHT_NAME = "test-highlight";
    const queries = [];
    const state = { activeDocumentId: "doc", activeOpenRequest: 1, disposed: false,
      actualSourceIdentity: { identityStatus: "KNOWN", sourceHash: "source-hash", orderedPageIdentities: ["page-one", "page-two"] },
      app: { pdfViewer: { currentPageNumber: 1 } }, readerBacklinkRequestSequence: 0,
      annotationUuidByRuntimeId: new Map() };
    const pageRoot = { querySelector() {}, querySelectorAll: () => [] };
    const pageElementForIndex = () => pageRoot;
    const textLayerForPage = () => ({});
    const performanceNow = () => 0;
    const runtimeLogRecord = () => {};
    const postToHost = (type, payload) => { queries.push({ type, ...payload }); return true; };
    state.backlinkInteractionController = new window.PdfReaderInputRuntime.BacklinkInteractionController({ documentRef: document });
    ${functions}
    const refresh = { channel, token, type: "reader-backlink-page-refresh", rendererGeneration,
      documentId: "doc", openRequest: 1, pageNumber: 1, pageIndex: 0,
      pageIdentity: "page-one", sourceHash: "source-hash" };
    return { state, queries, refresh, requestReaderBacklinksForPage, applyReaderBacklinkPageResults,
      receive: (message, source = window.parent) => onHostMessage({ source, data: message }) };
  })()`);
}

test("authenticated current backlink refresh issues a new same-page request and keeps strict result correlation RED", async () => {
  const f = fixture();
  assert.equal(f.requestReaderBacklinksForPage(1), true);
  const first = f.queries[0];
  assert.equal(f.requestReaderBacklinksForPage(1), false, "ordinary same-page deduplication stays enabled");
  f.receive(f.refresh);
  assert.equal(f.queries.length, 2, "a current authenticated refresh must break the initial same-page deadlock");
  const second = f.queries[1];
  assert.notEqual(second.requestId, first.requestId, "Viewer generates a fresh sequence rather than Host inventing an ID");
  assert.equal(second.type, "reader-backlink-page-request");
  const result = { ...second, type: "reader-backlink-page-results", markers: [], backlinkCount: 0 };
  assert.equal(await f.applyReaderBacklinkPageResults({ ...result, requestId: first.requestId }), false);
  assert.equal(await f.applyReaderBacklinkPageResults({ ...result, requestId: undefined }), false);
  assert.equal(await f.applyReaderBacklinkPageResults(result), true);
  assert.equal(f.state.backlinkInteractionController.latestPageRequest.requestId, second.requestId);
});

test("backlink refresh rejects unauthenticated or stale session page hash and identity without querying", () => {
  const f = fixture();
  f.requestReaderBacklinksForPage(1);
  for (const altered of [
    { channel: "forged" }, { token: "forged" }, { documentId: "old-doc" }, { openRequest: 0 },
    { rendererGeneration: "old-generation" }, { sourceHash: "old-source" },
    { pageNumber: 2, pageIndex: 1, pageIdentity: "page-two" },
    { pageIdentity: "wrong-page" }, { pageIndex: -1 }, { pageNumber: 2 },
  ]) {
    f.receive({ ...f.refresh, ...altered });
    assert.equal(f.queries.length, 1, JSON.stringify(altered));
  }
  f.receive(f.refresh, {});
  assert.equal(f.queries.length, 1, "event.source must still be the parent");
  f.state.actualSourceIdentity.identityStatus = "UNKNOWN";
  f.receive(f.refresh);
  assert.equal(f.queries.length, 1);
  f.state.actualSourceIdentity.identityStatus = "KNOWN";
  f.state.disposed = true;
  f.receive(f.refresh);
  assert.equal(f.queries.length, 1);
});
