import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { auditNativeRouteMatrixEvidence, NATIVE_RELEASE_FILES } from "../tests/native-learning-acceptance.mjs";

const [candidateDirectory, ...reportPaths] = process.argv.slice(2);
if (!candidateDirectory || reportPaths.length === 0) {
  throw new Error("Usage: node scripts/audit-native-learning-evidence.mjs <three-file-candidate-directory> <saved-report.json> [...]");
}
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const candidateFiles = {};
for (const file of NATIVE_RELEASE_FILES) {
  candidateFiles[file] = digest(await readFile(path.join(candidateDirectory, file)));
}
const inputs = await Promise.all(reportPaths.map(async reportPath => {
  const bytes = await readFile(reportPath);
  return { path: path.resolve(reportPath), sha256: digest(bytes), report: JSON.parse(bytes.toString("utf8")) };
}));
const audit = auditNativeRouteMatrixEvidence({ candidateFiles, reports: inputs.map(input => input.report) });
console.log(JSON.stringify({ schemaVersion: 1, candidateDirectory: path.resolve(candidateDirectory),
  candidateFiles, inputs: inputs.map(({ report, ...input }) => input), audit }, null, 2));
if (audit.status !== "PASS") process.exitCode = 1;
