import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { nativeConfig, nativeEvalJson, assertNativeVaultIdentity } from "./native-config.mjs";
import { expectedNativeRows, expectedNativeOperations, snapshotHash } from "./wal-v32-native-fixture.mjs";
import { verifyNativeWalColdReopen } from "./native-wal-v32-cold-reopen.mjs";

const report = JSON.parse(await readFile(process.argv[2], "utf8"));
const relativePdf = report.preflight.activePath;
const { expectedLast } = report.result;
const runId = expectedLast.payload.benchmark.run;
const identity = nativeEvalJson(`JSON.stringify({vault:app.vault.adapter.basePath,
  configDir:app.vault.configDir,document:app.workspace.activeLeaf.view.annotationDocument})`);
assertNativeVaultIdentity(identity);
assert.equal(identity.document.docKey, report.preflight.docKey);
const expectedRows = expectedNativeRows({ runId, docKey: identity.document.docKey,
  lastVersion: expectedLast.version });
assert.deepEqual(expectedRows.at(-1), expectedLast);
const expectedStateHash = snapshotHash(expectedRows);
const expectedOperationHash = snapshotHash(expectedNativeOperations(expectedRows));
const recovery = await verifyNativeWalColdReopen({ relativePdf, document: identity.document,
  expectedLast, expectedCount: 1000, expectedStateHash, expectedOperationHash });
const fixturePath = path.join(nativeConfig.vault, relativePdf);
const sourceSha256 = createHash("sha256").update(await readFile(fixturePath)).digest("hex");
assert.equal(sourceSha256, report.sourcePdf.beforeHash);
assert.equal((await stat(fixturePath)).mtimeMs, report.sourcePdf.beforeMtimeMs);
process.stdout.write(JSON.stringify({ expectedStateHash, expectedOperationHash, recovery, sourceSha256,
  sourceMtimeMs: (await stat(fixturePath)).mtimeMs }, null, 2));
