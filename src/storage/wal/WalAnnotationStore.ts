import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, stat, truncate } from "node:fs/promises";
import path from "node:path";
import type { FileHandle } from "node:fs/promises";
import type { AnnotationRecord, OperationType, WalEntry, WalSnapshot } from "./types.ts";

const MAX_LINE_BYTES = 16 * 1024 * 1024;

function plainJson(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  if (Array.isArray(value)) {
    seen.add(value);
    const result = value.every((item) => plainJson(item, seen));
    seen.delete(value);
    return result;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  seen.add(value);
  const result = Object.entries(value).every(([, item]) => plainJson(item, seen));
  seen.delete(value);
  return result;
}

function validRecord(value: unknown): value is AnnotationRecord {
  return !!value && plainJson(value) && !Array.isArray(value) &&
    typeof (value as AnnotationRecord).id === "string" && !!(value as AnnotationRecord).id &&
    typeof (value as AnnotationRecord).kind === "string" && !!(value as AnnotationRecord).kind &&
    Number.isSafeInteger((value as AnnotationRecord).pageIndex) && (value as AnnotationRecord).pageIndex >= 0 &&
    !!(value as AnnotationRecord).payload && typeof (value as AnnotationRecord).payload === "object" &&
    !Array.isArray((value as AnnotationRecord).payload);
}

function validEntry(value: unknown): value is WalEntry {
  if (!value || typeof value !== "object" || Array.isArray(value) || !plainJson(value)) return false;
  const entry = value as WalEntry;
  return Number.isSafeInteger(entry.lsn) && entry.lsn > 0 &&
    ["CREATE", "UPDATE", "DELETE"].includes(entry.op) &&
    typeof entry.id === "string" && !!entry.id && Number.isSafeInteger(entry.ts) && entry.ts >= 0 &&
    (entry.op === "DELETE" ? entry.payload === undefined : validRecord(entry.payload) && entry.payload.id === entry.id);
}

function validSnapshot(value: unknown): value is WalSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value) || !plainJson(value)) return false;
  const snapshot = value as WalSnapshot;
  if (snapshot.schemaVersion !== 1 || !Number.isSafeInteger(snapshot.lastLsn) || snapshot.lastLsn < 0 ||
      !Array.isArray(snapshot.annotations) || !snapshot.annotations.every(validRecord)) return false;
  return new Set(snapshot.annotations.map((item) => item.id)).size === snapshot.annotations.length;
}

async function maybeRead(file: string): Promise<string | null> {
  try { return await readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

type ScanResult = { entries: WalEntry[]; validByteOffset: number; tornTail: boolean };

async function scanWal(file: string): Promise<ScanResult> {
  const entries: WalEntry[] = [];
  let pending = Buffer.alloc(0);
  let validByteOffset = 0;
  let previousLsn = 0;
  let exists = true;
  try { await stat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false; else throw error; }
  if (!exists) return { entries, validByteOffset, tornTail: false };
  for await (const chunk of createReadStream(file)) {
    pending = Buffer.concat([pending, chunk as Buffer]);
    if (pending.length > MAX_LINE_BYTES && !pending.includes(10)) throw new Error("WAL_LINE_TOO_LARGE");
    for (;;) {
      const newline = pending.indexOf(10);
      if (newline < 0) break;
      const line = pending.subarray(0, newline);
      if (line.length === 0 || line.length > MAX_LINE_BYTES) throw new Error("WAL_LINE_INVALID");
      let parsed: unknown;
      try { parsed = JSON.parse(line.toString("utf8")); }
      catch { throw new Error(`WAL_MIDDLE_LINE_INVALID at byte ${validByteOffset}`); }
      if (!validEntry(parsed) || parsed.lsn <= previousLsn) throw new Error(`WAL_MIDDLE_LINE_INVALID at byte ${validByteOffset}`);
      previousLsn = parsed.lsn;
      entries.push(parsed);
      validByteOffset += newline + 1;
      pending = pending.subarray(newline + 1);
    }
    if (pending.length > MAX_LINE_BYTES) throw new Error("WAL_LINE_TOO_LARGE");
  }
  // A record has no commit delimiter until its newline is present. Only the
  // trailing incomplete record may be discarded; a corrupt middle record fails closed.
  return { entries, validByteOffset, tornTail: pending.length !== 0 };
}

export class WalAnnotationStore {
  readonly snapshotPath: string;
  readonly walPath: string;
  private readonly annotations = new Map<string, AnnotationRecord>();
  private handle: FileHandle | null = null;
  private lastLsn = 0;
  private uncompacted = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private checkpointScheduled = false;
  private closed = false;

  constructor(basePath: string) {
    if (!path.isAbsolute(basePath)) throw new TypeError("WAL base path must be absolute");
    this.snapshotPath = `${basePath}.annotations.json`;
    this.walPath = `${basePath}.annotations.wal`;
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async init(): Promise<void> {
    if (this.handle || this.closed) throw new Error("WAL_ALREADY_INITIALIZED");
    await mkdir(path.dirname(this.walPath), { recursive: true });
    const text = await maybeRead(this.snapshotPath);
    if (text !== null) {
      let value: unknown;
      try { value = JSON.parse(text); } catch { throw new Error("WAL_SNAPSHOT_INVALID"); }
      if (!validSnapshot(value)) throw new Error("WAL_SNAPSHOT_INVALID");
      this.lastLsn = value.lastLsn;
      for (const record of value.annotations) this.annotations.set(record.id, record);
    }
    const scanned = await scanWal(this.walPath);
    if (scanned.tornTail) await truncate(this.walPath, scanned.validByteOffset);
    let expected = this.lastLsn + 1;
    for (const entry of scanned.entries) {
      if (entry.lsn <= this.lastLsn) continue;
      if (entry.lsn !== expected) throw new Error("WAL_LSN_GAP");
      this.applyMemory(entry);
      this.lastLsn = entry.lsn;
      this.uncompacted++;
      expected++;
    }
    this.handle = await open(this.walPath, "a");
    this.armIdleCheckpoint();
  }

  private applyMemory(entry: WalEntry): void {
    if (entry.op === "DELETE") this.annotations.delete(entry.id);
    else this.annotations.set(entry.id, entry.payload!);
  }

  private armIdleCheckpoint(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.closed || this.uncompacted === 0) return;
    this.timer = setTimeout(() => { void this.checkpoint().catch(() => undefined); }, 30_000);
    this.timer.unref?.();
  }

  async applyOperation(op: OperationType, id: string, payload?: AnnotationRecord): Promise<WalEntry> {
    return this.serialize(async () => {
      if (!this.handle || this.closed) throw new Error("WAL_NOT_OPEN");
      const entry: WalEntry = { lsn: this.lastLsn + 1, op, id, ...(payload === undefined ? {} : { payload }), ts: Date.now() };
      if (!validEntry(entry)) throw new TypeError("WAL_ENTRY_INVALID");
      if (op === "CREATE" && this.annotations.has(id)) throw new Error("WAL_ANNOTATION_EXISTS");
      if (op === "UPDATE" && !this.annotations.has(id)) throw new Error("WAL_ANNOTATION_MISSING");
      const line = Buffer.from(`${JSON.stringify(entry)}\n`, "utf8");
      if (line.length > MAX_LINE_BYTES) throw new Error("WAL_LINE_TOO_LARGE");
      // A resolved ACK follows a data flush. This is slower than buffered append,
      // but a completed ACK must not mean merely "copied into the OS cache".
      let offset = 0;
      while (offset < line.length) {
        const { bytesWritten } = await this.handle.write(line, offset, line.length - offset);
        if (bytesWritten <= 0) throw new Error("WAL_APPEND_INCOMPLETE");
        offset += bytesWritten;
      }
      await this.handle.datasync();
      this.applyMemory(entry);
      this.lastLsn = entry.lsn;
      this.uncompacted++;
      this.armIdleCheckpoint();
      if (this.uncompacted >= 100 && !this.checkpointScheduled) {
        this.checkpointScheduled = true;
        setImmediate(() => {
          void this.checkpoint().catch(() => undefined).finally(() => { this.checkpointScheduled = false; });
        });
      }
      return entry;
    });
  }

  get(id: string): AnnotationRecord | undefined { return this.annotations.get(id); }
  list(): AnnotationRecord[] { return [...this.annotations.values()]; }
  get revision(): number { return this.lastLsn; }

  async checkpoint(): Promise<void> {
    return this.serialize(async () => {
      if (!this.handle || this.closed) throw new Error("WAL_NOT_OPEN");
      if (this.uncompacted === 0) return;
      const snapshotLsn = this.lastLsn;
      const snapshot: WalSnapshot = { schemaVersion: 1, lastLsn: snapshotLsn, annotations: this.list() };
      const snapshotTmp = `${this.snapshotPath}.tmp`;
      const compactTmp = `${this.walPath}.compact.tmp`;
      const snapshotHandle = await open(snapshotTmp, "w");
      try { await snapshotHandle.writeFile(`${JSON.stringify(snapshot)}\n`, "utf8"); await snapshotHandle.sync(); }
      finally { await snapshotHandle.close(); }
      await rename(snapshotTmp, this.snapshotPath);
      // The published snapshot already covers all prior entries. Retain any
      // later entry if a future implementation permits concurrent append here.
      const scanned = await scanWal(this.walPath);
      if (scanned.tornTail) throw new Error("WAL_TORN_DURING_CHECKPOINT");
      const compactRows = scanned.entries.filter((entry) => entry.lsn > snapshotLsn);
      const compactHandle = await open(compactTmp, "w");
      try {
        await compactHandle.writeFile(compactRows.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf8");
        await compactHandle.sync();
      } finally { await compactHandle.close(); }
      await this.handle.close();
      this.handle = null;
      await rename(compactTmp, this.walPath);
      this.handle = await open(this.walPath, "a");
      this.uncompacted = compactRows.length;
      this.armIdleCheckpoint();
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.checkpoint();
    await this.serialize(async () => {
      this.closed = true;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      await this.handle?.close();
      this.handle = null;
    });
  }
}
