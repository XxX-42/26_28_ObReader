import assert from "node:assert/strict";

export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Use public Store APIs to create two DISTINCT verified checkpoints that both
// cover existing batches. A newly registered witness changes the device set,
// not the annotation content. No checkpoint, ACK or digest is fabricated.
export async function prepareRetainedGc({ document, stores, witness, files, paths, now }) {
  await witness.registerDocument({ sourcePath: document.sourcePath });
  await witness.readDocument(document);
  for (const store of stores) await store.readDocument(document);
  const current = JSON.parse(files.get(paths.checkpoint));
  const previous = JSON.parse(files.get(paths.checkpointBackup));
  assert.notEqual(current.integrity, previous.integrity);
  assert.deepEqual(previous.coveredBatches, current.coveredBatches);
  const statuses = await stores[0].inspectDevices(document);
  assert.ok(statuses.devices.every((device) => device.retired || device.acknowledged),
    "every active device must ACK the exact current checkpoint before advancing mock time");
  now.value += RETENTION_MS + 1;
  return { current, previous };
}
