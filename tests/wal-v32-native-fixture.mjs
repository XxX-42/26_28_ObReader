import { createHash } from "node:crypto";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stable(value[key])]),
  );
  return value;
}

export function snapshotHash(rows) {
  const ordered = [...rows].sort((a, b) => a.uuid.localeCompare(b.uuid));
  return createHash("sha256").update(JSON.stringify(stable(ordered))).digest("hex");
}

export function expectedNativeRows({ runId, docKey, lastVersion, count = 1000 }) {
  return Array.from({ length: count }, (_, index) => {
    const seq = lastVersion.seq - count + 1 + index;
    return { uuid: `${runId}-${index}`, kind: "Square", pageIndex: index % 357,
      embeddedRef: null, deleted: false,
      payload: { editor: { annotationType: 5, rect: [100 + index % 7, 100, 200 + index % 7, 200],
        color: [index % 256, 17, 231], thickness: 2, opacity: 0.9 },
      benchmark: { ordinal: index + 1, run: runId } },
      version: { rev: 1, deviceId: lastVersion.deviceId, seq },
      clock: { timestamp: 1, logical: seq, deviceId: lastVersion.deviceId,
        opId: `${lastVersion.deviceId}:${docKey}:${seq}` } };
  });
}

export function expectedNativeOperations(rows) {
  return rows.map((row) => ({ type: "ANNOTATION_SET", uuid: row.uuid,
    kind: row.kind, pageIndex: row.pageIndex, embeddedRef: null, payload: row.payload,
    originOpId: row.uuid, seq: row.version.seq, opId: row.clock.opId, version: row.version }));
}
