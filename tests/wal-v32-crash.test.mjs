import assert from "node:assert/strict";
import { test } from "node:test";
import { fork } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WalAnnotationStore } from "../src/storage/wal/WalAnnotationStore.ts";

const workerPath = fileURLToPath(new URL("./wal-v32-crash-worker.mjs", import.meta.url));

async function killAt(mode, target) {
  const child = fork(workerPath, [mode, target], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Worker did not reach ${mode}: ${stderr}`)), 30_000);
    child.once("message", (message) => { clearTimeout(timer); resolve(message); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => { clearTimeout(timer); reject(new Error(`Worker exited before ${mode}: ${code}/${signal} ${stderr}`)); });
  });
  assert.equal(ready.revision, 499);
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
}

for (const mode of ["torn-last-line", "snapshot-temp", "snapshot-published"]) {
  test(`fresh process recovers 499 rows after ${mode} kill`, async () => {
    const target = path.join(await mkdtemp(path.join(os.tmpdir(), `pdf-reader-v32-${mode}-`)), "document");
    await killAt(mode, target);
    const recovered = new WalAnnotationStore(target);
    await recovered.init();
    assert.equal(recovered.revision, 499);
    assert.equal(recovered.list().length, 499);
    assert.equal(recovered.get("annotation-499")?.payload.index, 499);
    assert.equal(recovered.get("annotation-500"), undefined);
    if (mode === "torn-last-line") {
      const wal = await readFile(recovered.walPath, "utf8");
      assert.ok(!wal.includes('"annotation-500"'));
    }
    if (mode === "snapshot-temp") assert.ok((await stat(`${recovered.snapshotPath}.tmp`)).size > 0);
    await recovered.close();
  });
}
