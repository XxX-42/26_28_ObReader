import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../plugin/main.js", import.meta.url), "utf8");

test("controlled close publishes the shared session before creating its async guard", () => {
  const start = source.indexOf("const pending = {\n      documentId,\n      openRequest,\n      promise: null,\n    };");
  assert.ok(start >= 0, "prepare-close should create one session-scoped pending object");
  const end = source.indexOf("return pending.promise;", start);
  assert.ok(end > start, "prepare-close should return the published promise");
  const body = source.slice(start, end);
  const publish = body.indexOf("this.closePreparation = pending;");
  const schedule = body.indexOf("pending.promise = Promise.resolve().then(async () =>");
  assert.ok(publish >= 0 && schedule >= 0 && publish < schedule,
    "closePreparation must be visible before any async/session identity guard can run");
});
