import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
const source = await readFile(new URL("../plugin/main.js", import.meta.url), "utf8");
const start = source.indexOf("  async prepareControlledClose(reason) {");
const end = source.indexOf("  notifyRecoveredDraft()", start);
const methods = source.slice(start, end);
function harness(reply) {
  const notices = [];
  const Host = vm.runInNewContext(`(class Host { ${methods} })`, {
    makeToken: () => "close-1", CHANNEL: "pdf-web-reader", Promise, Date,
    Notice: class { constructor(message) { notices.push(message); } },
  });
  const host = Object.assign(new Host(), {
    documentId: "doc", openRequest: 1, ready: true, iframe: {},
    currentRevision: 3, confirmedRevision: 2, pendingSaves: 0,
    plugin: { isUnloading: false }, flushRequests: new Map(),
    ownerWindow: { clearTimeout },
    hasPreparedClose(doc, open) { return this.preparedClose?.documentId === doc && this.preparedClose?.openRequest === open; },
    bindOwnerWindow() {}, sendCancelClose() {},
    notifyFlushOutcome(result) { if (!result?.ok || result.dirty) this.notifyUnflushed(); },
    scheduleFlushTimeout(request) {
      if (!request.deadline) return;
      assert.ok(request.deadline - Date.now() <= 250);
      request.timerWindow = this.ownerWindow;
      request.timer = setTimeout(() => request.finish({ ok: false, dirty: true, timeout: true }), Math.max(0, request.deadline-Date.now()));
    },
    postToViewer(message) {
      if (reply) queueMicrotask(() => this.flushRequests.get(message.id)?.finish({ documentId: "doc", openRequest: 1, ...reply }));
      return true;
    },
  });
  return { host, notices };
}
test("failed save cannot veto close and is never reported as saved", async () => {
  const {host,notices}=harness({ok:false,dirty:true});
  assert.equal(await host.prepareControlledClose("detach"),true);
  assert.equal(host.preparedClose.unconfirmed,true);
  assert.equal(host.preparedClose.recovered,false);
  assert.equal(notices.length,1);
  assert.equal(await host.prepareControlledClose("detach"),true);
  assert.equal(notices.length,1);
});
test("unresponsive renderer allows close within the short best-effort budget", async () => {
  const {host}=harness(null); const began=Date.now();
  assert.equal(await host.prepareControlledClose("detach"),true);
  assert.ok(Date.now()-began<1000);
  assert.equal(host.preparedClose.unconfirmed,true);
  assert.equal(host.flushRequests.size,0);
});
test("disconnected and not-ready dirty readers also publish close permission", async () => {
  for (const values of [{iframe:null},{ready:false}]) {
    const {host,notices}=harness(null);Object.assign(host,values);
    assert.equal(await host.prepareControlledClose("detach"),true);
    assert.equal(host.hasPreparedClose("doc",1),true);
    assert.equal(notices.length,1);
  }
});
test("successful save acknowledgement retains its verified revision", async () => {
  const {host,notices}=harness({ok:true,dirty:false,prepared:true,revision:3});
  assert.equal(await host.prepareControlledClose("detach"),true);
  assert.equal(host.preparedClose.revision,3);
  assert.equal(host.preparedClose.unconfirmed,undefined);
  assert.equal(notices.length,0);
});
test("direct SDK teardown uses the same bounded flush, not the old 120-second wait", () => {
  const start=source.indexOf("  async onClose() {");
  const body=source.slice(start,source.indexOf("\n  getOwnerWindow() {",start));
  assert.match(body,/flushDocument\(250\)/);
});

test("a throwing transport cannot lock the tab", async () => {
  const {host,notices}=harness(null);
  host.postToViewer=()=>{throw new Error("disconnected transport");};
  assert.equal(await host.prepareControlledClose("detach"),true);
  assert.equal(host.preparedClose.unconfirmed,true);
  assert.equal(host.flushRequests.size,0);
  assert.equal(notices.length,1);
});
