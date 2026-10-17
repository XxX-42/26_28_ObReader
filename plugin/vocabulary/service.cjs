/*
 * Local English vocabulary store, deliberately independent of PDF and
 * annotation persistence. All I/O goes through Obsidian's Vault DataAdapter.
 */
const SCHEMA = "pdf-web-reader-vocabulary";
const SCHEMA_VERSION = 1;
const DIRECTORY = "00_Archive/21_VocabularyData";
const SNAPSHOT_PATH = `${DIRECTORY}/en.vocab.json`;
const BACKUP_PATH = `${SNAPSHOT_PATH}.previous`;
const STATUSES = new Set([1, 2, 3, 4, 5]);
const SOURCES = new Set(["user", "import"]);
const TOKEN_LIMIT = 12;
const MAX_IMPORT_CHARS = 8 * 1024 * 1024;
const MAX_IMPORT_RECORDS = 25000;
const MAX_STORE_RECORDS = 25000;
const MAX_RECORD_FIELD_CHARS = 4096;
const MAX_TOTAL_TEXT_CHARS = 1024 * 1024;

const PRIVATE = new WeakMap();

class VocabularyStoreError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.name = "VocabularyStoreError";
    this.code = code;
  }
}

function makeToken() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function normalizeTermKey(value) {
  if (typeof value !== "string") return "";
  const key = value
    .normalize("NFC")
    .replace(/[\uFB00\uFB01\uFB02\uFB03\uFB04]/g, (ligature) => ({
      "\uFB00": "ff",
      "\uFB01": "fi",
      "\uFB02": "fl",
      "\uFB03": "ffi",
      "\uFB04": "ffl",
    })[ligature])
    .replace(/[\u2018\u2019\u02BC\uFF07]/g, "'")
    .replace(/\(([\p{Script=Latin}\p{Script_Extensions=Latin}\p{M}0-9]+)\)/gu, "$1")
    .replace(/-\s+/gu, " ")
    .replace(/\.{3,}/gu, "…")
    .toLowerCase()
    .normalize("NFC")
    .replace(/\s+/gu, " ")
    .trim();
  if (!key) return "";
  // English words and phrases may contain letters, combining marks, spaces,
  // apostrophes, and hyphens. Do not strip arbitrary punctuation into a key.
  const words = key.split(" ");
  // Imported dictionaries commonly use dotted abbreviations (a.m.), slash
  // alternatives (at/for), ellipsis placeholders (consider… as), and
  // parenthesized labels (sb/sth). Preserve those distinctions in the stored
  // key rather than rejecting the entire otherwise-valid snapshot.
  const allowedWord = /^[\p{Script=Latin}\p{Script_Extensions=Latin}\p{M}0-9]+(?:['./…-][\p{Script=Latin}\p{Script_Extensions=Latin}\p{M}0-9]+)*(?:\.|…)?$/u;
  if (words.some((word) => word.length > 128 || !allowedWord.test(word)) || key.length > 1600) return "";
  return words.some((word) => [...word].some((character) => /\p{Script=Latin}/u.test(character))) ? key : "";
}

function stateOf(service) {
  const state = PRIVATE.get(service);
  if (!state) throw new TypeError("Invalid VocabularyService receiver");
  return state;
}

function recordCopy(record) {
  return record ? { ...record } : undefined;
}

function emptyStats() {
  return {
    total: 0,
    imported: 0,
    updated: 0,
    skippedExisting: 0,
    skippedKnown: 0,
    invalid: 0,
  };
}

function validateStatus(status) {
  if (!STATUSES.has(status)) {
    throw new RangeError("Vocabulary status must be an integer from 1 to 5.");
  }
  return status;
}

function cleanRecord(raw, now, defaultSource = "user") {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const surface = typeof raw.surface === "string" ? raw.surface : raw.key;
  const key = normalizeTermKey(surface);
  if (!key) return null;
  if (raw.type != null && raw.type !== "word" && raw.type !== "phrase") return null;
  const type = raw.type || (key.includes(" ") ? "phrase" : "word");
  if ((type === "word") === key.includes(" ")) return null;
  if (type === "phrase" && (key.split(" ").length < 2 || key.split(" ").length > TOKEN_LIMIT)) return null;
  const status = raw.status == null ? 1 : Number(raw.status);
  if (!STATUSES.has(status)) return null;
  const createdAt = Number.isFinite(raw.createdAt) && raw.createdAt >= 0
    ? raw.createdAt : now;
  const updatedAt = Number.isFinite(raw.updatedAt) && raw.updatedAt >= 0
    ? raw.updatedAt : createdAt;
  const source = SOURCES.has(raw.source) ? raw.source : defaultSource;
  const result = {
    key,
    type,
    surface: String(surface).trim(),
    status,
    createdAt,
    updatedAt,
    source,
  };
  if (typeof raw.translation === "string") result.translation = raw.translation;
  if (typeof raw.note === "string") result.note = raw.note;
  if ([result.translation, result.note].some((field) => typeof field === "string" && field.length > MAX_RECORD_FIELD_CHARS)) return null;
  return result;
}

function decodeSnapshot(text, now) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new VocabularyStoreError(
      "Vocabulary data is not valid JSON; the original file was left untouched.",
      "vocabulary-corrupt-json",
      { cause: error },
    );
  }
  if (
    !parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
    parsed.schema !== SCHEMA || parsed.schemaVersion !== SCHEMA_VERSION ||
    parsed.language !== "en" || !Number.isSafeInteger(parsed.revision) ||
    parsed.revision < 0 || !Array.isArray(parsed.records)
  ) {
    throw new VocabularyStoreError(
      "Vocabulary data has an unsupported or invalid schema; the original file was left untouched.",
      "vocabulary-corrupt-schema",
    );
  }
  const records = new Map();
  for (const raw of parsed.records) {
    if (records.size >= MAX_STORE_RECORDS) {
      throw new VocabularyStoreError("Vocabulary data exceeds the supported record limit.", "vocabulary-corrupt-record");
    }
    const record = cleanRecord(raw, now, "import");
    if (!record || record.key !== normalizeTermKey(raw.key ?? raw.surface)) {
      throw new VocabularyStoreError(
        "Vocabulary data contains an invalid record; the original file was left untouched.",
        "vocabulary-corrupt-record",
      );
    }
    if (records.has(record.key)) {
      throw new VocabularyStoreError(
        "Vocabulary data contains duplicate keys; the original file was left untouched.",
        "vocabulary-duplicate-key",
      );
    }
    records.set(record.key, record);
  }
  return { records, revision: parsed.revision };
}

function snapshotText(records, revision) {
  if (records.size > MAX_STORE_RECORDS) throw new RangeError("Vocabulary store exceeds the supported record limit.");
  let textChars = 0;
  for (const record of records.values()) {
    textChars += record.key.length + record.surface.length + (record.translation?.length || 0) + (record.note?.length || 0);
    if (textChars > MAX_TOTAL_TEXT_CHARS) throw new RangeError("Vocabulary text exceeds the supported store size.");
  }
  const ordered = [...records.values()]
    .sort((left, right) => left.key.localeCompare(right.key, "en"))
    .map((record) => ({ ...record }));
  const text = `${JSON.stringify({
    schema: SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    language: "en",
    revision,
    records: ordered,
  }, null, 2)}\n`;
  if (text.length > MAX_IMPORT_CHARS) throw new RangeError("Vocabulary snapshot exceeds the supported file size.");
  return text;
}

async function adapterExists(adapter, path) {
  if (typeof adapter.exists !== "function") {
    throw new TypeError("Vault DataAdapter must implement exists(path).");
  }
  return Boolean(await adapter.exists(path));
}

async function ensureDirectories(adapter) {
  if (typeof adapter.mkdir !== "function") {
    throw new TypeError("Vault DataAdapter must implement mkdir(path).");
  }
  for (const path of ["00_Archive", DIRECTORY]) {
    if (!(await adapterExists(adapter, path))) await adapter.mkdir(path);
  }
}

async function removeIfExists(adapter, path) {
  if (!(await adapterExists(adapter, path))) return;
  if (typeof adapter.remove !== "function") {
    throw new TypeError("Vault DataAdapter must implement remove(path).");
  }
  await adapter.remove(path);
}

function enqueue(state, task) {
  const operation = state.serial.then(task, task);
  state.serial = operation.catch(() => undefined);
  return operation;
}

async function loadState(service) {
  const state = stateOf(service);
  if (state.loaded) return service;
  if (state.loadPromise) return state.loadPromise;
  state.loadPromise = (async () => {
    const adapter = state.adapter;
    if (!(await adapterExists(adapter, state.path))) {
      // A previous process may have stopped between staging and the final
      // rename. Recover only a verified backup when the canonical file is
      // absent. A damaged canonical file is never silently replaced.
      if (await adapterExists(adapter, state.backupPath)) {
        const text = await adapter.read(state.backupPath);
        const decoded = decodeSnapshot(text, state.now());
        state.records = decoded.records;
        state.revision = decoded.revision;
        state.diskRaw = null;
        state.recoveredBackup = true;
      } else {
        state.records = new Map();
        state.revision = 0;
        state.diskRaw = null;
      }
      state.loaded = true;
      return service;
    }
    const text = await adapter.read(state.path);
    const decoded = decodeSnapshot(text, state.now());
    state.records = decoded.records;
    state.revision = decoded.revision;
    state.diskRaw = text;
    state.loaded = true;
    return service;
  })().catch((error) => {
    state.loadError = error;
    throw error;
  });
  return state.loadPromise;
}

async function writeSnapshot(state, text, expectedRaw) {
  const adapter = state.adapter;
  await ensureDirectories(adapter);

  const hadCanonical = await adapterExists(adapter, state.path);
  const currentRaw = hadCanonical ? await adapter.read(state.path) : null;
  if (currentRaw !== expectedRaw) {
    state.poisoned = new VocabularyStoreError(
      "Vocabulary data changed outside this Reader session; refusing to overwrite it.",
      "vocabulary-external-change",
    );
    throw state.poisoned;
  }

  if (typeof adapter.write !== "function" || typeof adapter.rename !== "function") {
    throw new TypeError("Vault DataAdapter must implement write(path, data) and rename(oldPath, newPath).");
  }

  const temporary = `${state.path}.tmp-${state.makeToken()}`;
  let staged;
  try {
    await adapter.write(temporary, text);
    staged = await adapter.read(temporary);
  } catch (error) {
    await removeIfExists(adapter, temporary).catch(() => undefined);
    throw error;
  }
  if (staged !== text) {
    await removeIfExists(adapter, temporary).catch(() => undefined);
    throw new VocabularyStoreError("Vocabulary staging verification failed.", "vocabulary-stage-verify");
  }

  // Staging itself may take long enough for Vault Sync or another local
  // process to replace the canonical file. Recheck immediately before the
  // rename window, so such a change is preserved instead of moved to backup
  // and silently discarded.
  try {
    const latestExists = await adapterExists(adapter, state.path);
    const latestRaw = latestExists ? await adapter.read(state.path) : null;
    if (latestRaw !== expectedRaw) {
      state.poisoned = new VocabularyStoreError(
        "Vocabulary data changed outside this Reader session; refusing to overwrite it.",
        "vocabulary-external-change",
      );
      throw state.poisoned;
    }
  } catch (error) {
    await removeIfExists(adapter, temporary).catch(() => undefined);
    throw error;
  }

  let movedCanonical = false;
  try {
    if (hadCanonical) {
      // The primary was read and matched the last committed snapshot before
      // this swap. Avoid rename-over-existing, which some mobile adapters do
      // not support, by moving the previous verified snapshot aside first.
      await removeIfExists(adapter, state.backupPath);
      await adapter.rename(state.path, state.backupPath);
      movedCanonical = true;
      // Vault Sync can still win the narrow interval between the last read
      // above and this rename. Verify the bytes actually moved before the
      // staged snapshot is installed, and preserve any external update.
      const movedRaw = await adapter.read(state.backupPath);
      if (movedRaw !== expectedRaw) {
        state.poisoned = new VocabularyStoreError(
          "Vocabulary data changed during replacement; the external snapshot was preserved.",
          "vocabulary-external-change",
        );
        throw state.poisoned;
      }
    }
    // Preserve an externally recreated canonical file when the adapter can
    // observe it before installation. DataAdapter has no compare-and-swap or
    // no-replace rename primitive, so this check narrows (but cannot make
    // atomic) the cross-process Vault Sync race window.
    if (await adapterExists(adapter, state.path)) {
      state.poisoned = new VocabularyStoreError(
        "Vocabulary data changed during replacement; the external snapshot was preserved.",
        "vocabulary-external-change",
      );
      throw state.poisoned;
    }
    await adapter.rename(temporary, state.path);
    const installed = await adapter.read(state.path);
    if (installed !== text) {
      throw new VocabularyStoreError("Vocabulary snapshot verification failed after rename.", "vocabulary-commit-verify");
    }
    // The newly installed snapshot is now verified. The backup is only needed
    // across the replacement window, so cleanup failure does not revoke ACK.
    await removeIfExists(adapter, state.backupPath).catch(() => undefined);
    return;
  } catch (error) {
    let recovered = !movedCanonical;
    if (movedCanonical) {
      try {
        const primaryExists = await adapterExists(adapter, state.path);
        if (primaryExists) {
          const primaryText = await adapter.read(state.path);
          if (primaryText !== text) {
            // A sync process recreated the canonical path during our swap.
            // Keep both its canonical bytes and our verified backup instead
            // of replacing either one; this service instance must fail closed.
            state.poisoned = new VocabularyStoreError(
              "Vocabulary data changed during replacement; the external snapshot was preserved.",
              "vocabulary-external-change",
            );
            await removeIfExists(adapter, temporary).catch(() => undefined);
            throw state.poisoned;
          }
          await adapter.remove(state.path);
        }
        await adapter.rename(state.backupPath, state.path);
        recovered = true;
      } catch (restoreError) {
        if (restoreError?.code === "vocabulary-external-change") throw restoreError;
        recovered = false;
      }
    }
    await removeIfExists(adapter, temporary).catch(() => undefined);
    if (!recovered) {
      state.poisoned = new VocabularyStoreError(
        "Vocabulary replacement failed and the previous snapshot could not be restored; stop using this store and preserve its files.",
        "vocabulary-rollback-failed",
        { cause: error },
      );
      throw state.poisoned;
    }
    throw error;
  }
}

function assertWritable(state) {
  if (state.loadError) throw state.loadError;
  if (state.poisoned) throw state.poisoned;
  if (state.disposed) {
    throw new VocabularyStoreError("Vocabulary service has been disposed.", "vocabulary-disposed");
  }
}

function makeRecord({ key, type, surface, status, translation, note, source, createdAt, updatedAt }) {
  const record = { key, type, surface, status, createdAt, updatedAt, source };
  if (typeof translation === "string") record.translation = translation;
  if (typeof note === "string") record.note = note;
  return record;
}

async function applyImport(service, inputs, policy = {}) {
  await loadState(service);
  const state = stateOf(service);
  const overwriteExisting = policy.overwriteExisting === true;
  const overwriteKnown = policy.overwriteKnown === true;
  const stats = emptyStats();
  stats.total = inputs.length;
  const valid = [];
  for (const raw of inputs) {
    const record = cleanRecord(raw, state.now(), "import");
    if (!record) {
      stats.invalid += 1;
      continue;
    }
    valid.push(record);
  }
  if (!valid.length) return stats;

  await enqueue(state, async () => {
    assertWritable(state);
    const next = new Map(state.records);
    let changed = false;
    for (const incoming of valid) {
      const existing = next.get(incoming.key);
      if (existing?.status === 5 && !overwriteKnown) {
        stats.skippedKnown += 1;
        continue;
      }
      if (existing && !overwriteExisting && !(existing.status === 5 && overwriteKnown)) {
        stats.skippedExisting += 1;
        continue;
      }
      if (!existing && next.size >= MAX_STORE_RECORDS) {
        stats.invalid += 1;
        continue;
      }
      const now = state.now();
      if (existing) {
        next.set(incoming.key, makeRecord({
          ...incoming,
          createdAt: existing.createdAt,
          updatedAt: now,
          source: "import",
        }));
        stats.updated += 1;
      } else {
        next.set(incoming.key, makeRecord({
          ...incoming,
          createdAt: now,
          updatedAt: now,
          source: "import",
        }));
        stats.imported += 1;
      }
      changed = true;
    }
    if (!changed) return;
    const nextRevision = state.revision + 1;
    const text = snapshotText(next, nextRevision);
    await writeSnapshot(state, text, state.diskRaw);
    state.records = next;
    state.revision = nextRevision;
    state.diskRaw = text;
    state.recoveredBackup = false;
    notifySubscribers(state, { revision: nextRevision, type: "import", changedKeys: valid.map((record) => record.key) });
  });
  return stats;
}

function notifySubscribers(state, event) {
  for (const listener of [...state.listeners]) {
    try { listener({ ...event, changedKeys: [...(event.changedKeys || [])] }); } catch { /* A subscriber cannot break persistence. */ }
  }
}

function parseCsvRows(text) {
  if (typeof text !== "string") throw new TypeError("CSV import must be text.");
  if (text.length > MAX_IMPORT_CHARS) throw new RangeError("CSV import exceeds the supported input size.");
  const source = text.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;
  let fieldStarted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (closedQuote && character !== "," && character !== "\r" && character !== "\n") {
      throw new SyntaxError("CSV has characters after a closing quote.");
    }
    if (character === '"') {
      if (fieldStarted) throw new SyntaxError("CSV has a quote inside an unquoted field.");
      quoted = true;
      fieldStarted = true;
      closedQuote = false;
    } else if (character === ",") {
      row.push(field);
      field = "";
      fieldStarted = false;
      closedQuote = false;
    } else if (character === "\r" || character === "\n") {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      if (rows.length > MAX_IMPORT_RECORDS + 1) throw new RangeError("CSV import exceeds the supported row count.");
      row = [];
      field = "";
      fieldStarted = false;
      closedQuote = false;
    } else {
      field += character;
      fieldStarted = true;
    }
  }
  if (quoted) throw new SyntaxError("CSV contains an unterminated quoted field.");
  if (fieldStarted || row.length || source.endsWith(",")) {
    row.push(field);
    rows.push(row);
    if (rows.length > MAX_IMPORT_RECORDS + 1) throw new RangeError("CSV import exceeds the supported row count.");
  }
  return rows;
}

function csvField(value) {
  let text = String(value ?? "");
  // CSV quoting does not neutralize spreadsheet formulas. Prefix formula-
  // leading values with an apostrophe. Escape literal leading apostrophes as
  // well, so csvInput can distinguish export markers from user text.
  if (text.startsWith("'") || /^[=+\-@]/u.test(text.trimStart())) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function unescapeSpreadsheetCell(value) {
  const text = String(value ?? "");
  if (text.startsWith("''")) return text.slice(1);
  if (text.startsWith("'") && /^[=+\-@]/u.test(text.slice(1).trimStart())) return text.slice(1);
  return value;
}

function headerMap(row) {
  const values = row.map((value) => String(value).trim().toLowerCase());
  const hasMetadata = values.some((value) => ["type", "status", "translation", "note"].includes(value));
  // Any first-column spelling can also be a real English term (including
  // "term", "key", and "word"), so require a second recognized column
  // before dropping the first row as a header.
  if (!hasMetadata) return null;
  const termIndex = values.findIndex((value) => ["term", "surface", "word", "phrase", "key"].includes(value));
  if (termIndex < 0) return null;
  return {
    term: termIndex,
    type: values.indexOf("type"),
    status: values.indexOf("status"),
    translation: values.indexOf("translation"),
    note: values.indexOf("note"),
  };
}

function csvInput(row, columns, defaultStatus) {
  const read = (index) => index >= 0 ? row[index] : undefined;
  const surface = columns ? read(columns.term) : row[0];
  const typeValue = columns ? read(columns.type) : undefined;
  const statusValue = columns ? read(columns.status) : row[1];
  const translation = unescapeSpreadsheetCell(columns ? read(columns.translation) : row[2]);
  const note = unescapeSpreadsheetCell(columns ? read(columns.note) : row[3]);
  const key = normalizeTermKey(surface);
  if (!key) return null;
  const parsedStatus = statusValue == null || String(statusValue).trim() === ""
    ? defaultStatus
    : Number(statusValue);
  if (!STATUSES.has(parsedStatus)) return null;
  const type = String(typeValue || (key.includes(" ") ? "phrase" : "word")).trim().toLowerCase();
  if (type !== "word" && type !== "phrase") return null;
  return { key, surface: String(surface).trim(), type, status: parsedStatus, translation, note, source: "import" };
}

class VocabularyService {
  constructor({ adapter, path = SNAPSHOT_PATH, makeId = makeToken, now = () => Date.now() } = {}) {
    if (!adapter || typeof adapter !== "object") throw new TypeError("VocabularyService requires a Vault DataAdapter.");
    const normalizedPath = String(path).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!normalizedPath || normalizedPath.split("/").includes("..")) {
      throw new TypeError("Vocabulary path must stay within the Vault.");
    }
    PRIVATE.set(this, {
      adapter,
      path: normalizedPath,
      backupPath: `${normalizedPath}.previous`,
      makeToken: makeId,
      now,
      records: new Map(),
      revision: 0,
      diskRaw: null,
      recoveredBackup: false,
      loaded: false,
      loadPromise: null,
      loadError: null,
      poisoned: null,
      disposed: false,
      serial: Promise.resolve(),
      listeners: new Set(),
    });
  }

  load() {
    return loadState(this);
  }

  async flush() {
    await loadState(this);
    const state = stateOf(this);
    await state.serial;
    assertWritable(state);
    return state.revision;
  }

  async queryTerms(keys) {
    await loadState(this);
    const state = stateOf(this);
    assertWritable(state);
    const result = Object.create(null);
    for (const value of Array.isArray(keys) ? keys : []) {
      const key = normalizeTermKey(value);
      if (!key) continue;
      const record = state.records.get(key);
      if (record) result[key] = recordCopy(record);
    }
    return result;
  }

  async getTerm(keyValue) {
    await loadState(this);
    const state = stateOf(this);
    assertWritable(state);
    const key = normalizeTermKey(keyValue);
    return key ? recordCopy(state.records.get(key)) : undefined;
  }

  async _mutate(keyValue, update, typeHint = null) {
    await loadState(this);
    const state = stateOf(this);
    const key = normalizeTermKey(keyValue);
    if (!key) throw new TypeError("Vocabulary term is not a valid English surface form.");
    return enqueue(state, async () => {
      assertWritable(state);
      const previous = state.records.get(key);
      if (!previous && state.records.size >= MAX_STORE_RECORDS) {
        throw new RangeError("Vocabulary store exceeds the supported record limit.");
      }
      const now = state.now();
      const base = previous || makeRecord({
        key,
        type: typeHint || (key.includes(" ") ? "phrase" : "word"),
        surface: String(keyValue).trim(),
        status: 1,
        source: "user",
        createdAt: now,
        updatedAt: now,
      });
      const nextRecord = update({ ...base, updatedAt: now, source: "user" });
      const clean = cleanRecord(nextRecord, now, "user");
      if (!clean) throw new TypeError("Vocabulary mutation produced an invalid record.");
      const next = new Map(state.records);
      next.set(key, clean);
      const nextRevision = state.revision + 1;
      const text = snapshotText(next, nextRevision);
      await writeSnapshot(state, text, state.diskRaw);
      state.records = next;
      state.revision = nextRevision;
      state.diskRaw = text;
      state.recoveredBackup = false;
      notifySubscribers(state, { revision: nextRevision, type: "mutation", changedKeys: [key] });
      return recordCopy(clean);
    });
  }

  setStatus(key, status) {
    validateStatus(status);
    return this._mutate(key, (record) => ({ ...record, status }));
  }

  setTranslation(key, translation) {
    if (typeof translation !== "string") throw new TypeError("Translation must be text.");
    if (translation.length > MAX_RECORD_FIELD_CHARS) throw new RangeError("Translation exceeds the supported field size.");
    return this._mutate(key, (record) => ({ ...record, translation }));
  }

  setNote(key, note) {
    if (typeof note !== "string") throw new TypeError("Note must be text.");
    if (note.length > MAX_RECORD_FIELD_CHARS) throw new RangeError("Note exceeds the supported field size.");
    return this._mutate(key, (record) => ({ ...record, note }));
  }

  async upsertTerm(surface, fields = {}) {
    const key = normalizeTermKey(surface);
    if (!key) throw new TypeError("Vocabulary term is not a valid English surface form.");
    const type = fields.type || (key.includes(" ") ? "phrase" : "word");
    if (type !== "word" && type !== "phrase") throw new TypeError("Vocabulary type must be word or phrase.");
    if ((type === "word") === key.includes(" ")) throw new TypeError("Vocabulary type does not match the selected surface.");
    if (type === "phrase" && (key.split(" ").length < 2 || key.split(" ").length > TOKEN_LIMIT)) {
      throw new RangeError("A phrase must contain 2 to 12 tokens from one page.");
    }
    if (fields.status != null) validateStatus(fields.status);
    for (const name of ["translation", "note"]) {
      if (fields[name] != null && typeof fields[name] !== "string") {
        throw new TypeError(`${name} must be text.`);
      }
      if (typeof fields[name] === "string" && fields[name].length > MAX_RECORD_FIELD_CHARS) {
        throw new RangeError(`${name} exceeds the supported field size.`);
      }
    }
    return this._mutate(key, (record) => ({
      ...record,
      type,
      surface: String(surface).trim(),
      status: fields.status == null ? record.status : fields.status,
      ...(fields.translation == null ? {} : { translation: fields.translation }),
      ...(fields.note == null ? {} : { note: fields.note }),
    }), type);
  }

  async savePhrase(tokens, options = {}) {
    if (!Array.isArray(tokens) || tokens.length < 2 || tokens.length > TOKEN_LIMIT) {
      throw new RangeError("A phrase must contain 2 to 12 tokens from one page.");
    }
    const surfaces = tokens.map((token) => typeof token === "string" ? token : token?.surfaceKey);
    if (surfaces.some((surface) => typeof surface !== "string" || !normalizeTermKey(surface) || normalizeTermKey(surface).includes(" "))) {
      throw new TypeError("Phrase tokens must be individual English surface keys.");
    }
    const surface = surfaces.join(" ");
    const key = normalizeTermKey(surface);
    const status = options.status == null ? 1 : validateStatus(options.status);
    const translation = typeof options.translation === "string" ? options.translation : undefined;
    const note = typeof options.note === "string" ? options.note : undefined;
    return this._mutate(key, (record) => ({
      ...record,
      type: "phrase",
      surface,
      status: record.status || status,
      ...(translation === undefined ? {} : { translation }),
      ...(note === undefined ? {} : { note }),
    }), "phrase");
  }

  async queryLearningTerms(options = {}) {
    await loadState(this);
    const state = stateOf(this);
    assertWritable(state);
    const requestedStatuses = Array.isArray(options.statuses)
      ? new Set(options.statuses.filter((status) => STATUSES.has(status)))
      : new Set([1, 2, 3, 4]);
    let records = [...state.records.values()].filter((record) => requestedStatuses.has(record.status));
    if (options.type === "word" || options.type === "phrase") {
      records = records.filter((record) => record.type === options.type);
    }
    if (Number.isInteger(options.limit) && options.limit >= 0) records = records.slice(0, options.limit);
    return records.map(recordCopy);
  }

  async importCsv(text, policy = {}) {
    let rows;
    try {
      rows = parseCsvRows(text);
    } catch {
      const stats = emptyStats();
      stats.total = 1;
      stats.invalid = 1;
      return stats;
    }
    let columns = rows.length ? headerMap(rows[0]) : null;
    if (columns) rows = rows.slice(1);
    const defaultStatus = policy.defaultStatus == null ? 1 : Number(policy.defaultStatus);
    if (!STATUSES.has(defaultStatus)) throw new RangeError("defaultStatus must be an integer from 1 to 5.");
    const nonempty = rows.filter((row) => row.some((field) => String(field).trim() !== ""));
    const inputs = nonempty.map((row) => csvInput(row, columns, defaultStatus));
    return applyImport(this, inputs, policy);
  }

  async importJson(value, policy = {}) {
    let parsed = value;
    if (typeof value === "string" && value.length > MAX_IMPORT_CHARS) {
      throw new RangeError("JSON import exceeds the supported input size.");
    }
    try {
      if (typeof value === "string") parsed = JSON.parse(value);
    } catch {
      const stats = emptyStats();
      stats.total = 1;
      stats.invalid = 1;
      return stats;
    }
    const records = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray(parsed.records)
        ? parsed.records
        : [];
    if (records.length > MAX_IMPORT_RECORDS) throw new RangeError("JSON import exceeds the supported record count.");
    const defaultStatus = policy.defaultStatus == null ? 1 : Number(policy.defaultStatus);
    if (!STATUSES.has(defaultStatus)) throw new RangeError("defaultStatus must be an integer from 1 to 5.");
    const inputs = records.map((record) => {
      if (!record || typeof record !== "object") return null;
      return { ...record, status: record.status == null ? defaultStatus : Number(record.status) };
    });
    return applyImport(this, inputs, policy);
  }

  async exportJson() {
    await loadState(this);
    const state = stateOf(this);
    assertWritable(state);
    return snapshotText(state.records, state.revision);
  }

  async exportCsv() {
    await loadState(this);
    const state = stateOf(this);
    assertWritable(state);
    const rows = [["term", "type", "status", "translation", "note"]];
    for (const record of [...state.records.values()].sort((left, right) => left.key.localeCompare(right.key, "en"))) {
      rows.push([record.surface, record.type, record.status, record.translation || "", record.note || ""]);
    }
    return `${rows.map((row) => row.map(csvField).join(",")).join("\r\n")}\r\n`;
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("Vocabulary subscriber must be a function.");
    const state = stateOf(this);
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  }

  getRevision() {
    return stateOf(this).revision;
  }

  async dispose() {
    const state = stateOf(this);
    await this.flush();
    state.disposed = true;
    state.listeners.clear();
  }
}

module.exports = {
  VocabularyService,
  VocabularyStoreError,
  normalizeTermKey,
  parseCsvRows,
  VOCABULARY_DIRECTORY: DIRECTORY,
  VOCABULARY_PATH: SNAPSHOT_PATH,
};
