import { open, rename } from "node:fs/promises";
import { WalAnnotationStore } from "../src/storage/wal/WalAnnotationStore.ts";

const [mode, target] = process.argv.slice(2);
const store = new WalAnnotationStore(target);
await store.init();
for (let index = 1; index <= 499; index++) {
  await store.applyOperation("CREATE", `annotation-${index}`, {
    id: `annotation-${index}`, kind: "Square", pageIndex: index % 357,
    payload: { index },
  });
}
// Allow a threshold-triggered checkpoint to settle before fault injection.
await new Promise((resolve) => setTimeout(resolve, 30));

if (mode === "torn-last-line") {
  const handle = await open(store.walPath, "a");
  await handle.write('{"lsn":500,"op":"CREATE","id":"annotation-500","payload":');
  await handle.sync();
  await handle.close();
} else if (mode === "snapshot-temp" || mode === "snapshot-published") {
  const temporary = `${store.snapshotPath}.tmp`;
  const handle = await open(temporary, "w");
  await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, lastLsn: 499, annotations: store.list() })}\n`);
  await handle.sync();
  await handle.close();
  if (mode === "snapshot-published") await rename(temporary, store.snapshotPath);
} else {
  throw new Error(`Unknown crash mode: ${mode}`);
}
process.send?.({ ready: true, mode, revision: store.revision });
await new Promise(() => {});
