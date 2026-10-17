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
// Vocabulary lookups are page-batched: one visible page can ask for several
// thousand word and phrase keys. Scanning every persisted record for every
// requested surface made initial LingQ hydration O(pageKeys * vocabulary).
// Records maps are replaced atomically on mutation/import, so a WeakMap keyed
// by the immutable map gives each snapshot one reusable lemma index and lets
// obsolete indexes be collected without explicit cache invalidation.
const MATCH_INDEX_CACHE = new WeakMap();

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

// Matching identity is intentionally separate from the persisted surface key.
// Keep this table and algorithm in lockstep with the viewer-side normalizer;
// this is a matching key only and never rewrites stored vocabulary keys.
const IRREGULAR_LEMMA_ENTRIES = [
  ["be", ["am", "is", "are", "was", "were", "been", "being"]],
  ["have", ["has", "had", "having"]], ["do", ["does", "did", "done", "doing"]],
  ["go", ["goes", "went", "gone", "going"]], ["get", ["got", "gotten", "getting"]],
  ["make", ["made", "making"]], ["take", ["took", "taken", "taking"]],
  ["come", ["came", "coming"]], ["run", ["ran", "running"]],
  ["write", ["wrote", "written", "writing"]], ["buy", ["bought", "buying"]],
  ["give", ["gave", "given", "giving"]], ["lie", ["lies", "lain", "lying", "lay"]],
  ["lay", ["lays", "laid", "laying"]], ["say", ["said", "saying"]],
  ["tell", ["told", "telling"]], ["speak", ["spoke", "spoken", "speaking"]],
  ["think", ["thought", "thinking"]], ["bring", ["brought", "bringing"]],
  ["catch", ["caught", "catching"]], ["teach", ["taught", "teaching"]],
  ["feel", ["felt", "feeling"]], ["keep", ["kept", "keeping"]],
  ["leave", ["left", "leaving"]], ["meet", ["met", "meeting"]],
  ["find", ["found", "finding"]], ["lose", ["lost", "losing"]],
  ["pay", ["paid", "paying"]], ["sell", ["sold", "selling"]],
  ["send", ["sent", "sending"]], ["sit", ["sat", "sitting"]],
  ["stand", ["stood", "standing"]], ["understand", ["understood", "understanding"]],
  ["win", ["won", "winning"]], ["sleep", ["slept", "sleeping"]],
  ["spend", ["spent", "spending"]], ["build", ["built", "building"]],
  ["hold", ["held", "holding"]], ["hear", ["heard", "hearing"]],
  ["wear", ["wore", "worn", "wearing"]], ["break", ["broke", "broken", "breaking"]],
  ["choose", ["chose", "chosen", "choosing"]], ["drive", ["drove", "driven", "driving"]],
  ["eat", ["ate", "eaten", "eating"]], ["fall", ["fell", "fallen", "falling"]],
  ["fly", ["flew", "flown", "flying"]], ["forget", ["forgot", "forgotten", "forgetting"]],
  ["grow", ["grew", "grown", "growing"]], ["know", ["knew", "known", "knowing"]],
  ["ride", ["rode", "ridden", "riding"]], ["rise", ["rose", "risen", "rising"]],
  ["throw", ["threw", "thrown", "throwing"]], ["draw", ["drew", "drawn", "drawing"]],
  ["show", ["showed", "shown", "showing"]], ["become", ["became", "becoming"]],
  ["begin", ["began", "begun", "beginning"]], ["drink", ["drank", "drunk", "drinking"]],
  ["sing", ["sang", "sung", "singing"]], ["swim", ["swam", "swum", "swimming"]],
  ["ring", ["rang", "rung", "ringing"]], ["cost", ["costing"]], ["let", ["letting"]],
  ["put", ["putting"]], ["cut", ["cutting"]], ["set", ["setting"]],
  ["hit", ["hitting"]], ["hurt", ["hurting"]], ["shut", ["shutting"]],
  ["carry", ["carried", "carrying"]], ["study", ["studies", "studied", "studying"]],
  ["stop", ["stopped", "stopping"]], ["box", ["boxed", "boxes", "boxing"]],
  ["bus", ["buses"]], ["gas", ["gases"]], ["quiz", ["quizzes"]],
  ["hero", ["heroes"]], ["potato", ["potatoes"]], ["tomato", ["tomatoes"]],
  ["echo", ["echoes"]], ["veto", ["vetoes"]], ["analysis", ["analyses"]],
  ["crisis", ["crises"]], ["thesis", ["theses"]], ["diagnosis", ["diagnoses"]],
  ["walk", ["walked", "walking"]],
];

const IRREGULAR_LEMMA_MAP = new Map();
for (const [lemma, forms] of IRREGULAR_LEMMA_ENTRIES) {
  for (const form of forms) IRREGULAR_LEMMA_MAP.set(form, lemma);
}

const SILENT_E_FORMS = new Map(Object.entries({
  baking: "bake", baked: "bake", closing: "close", closed: "close",
  dancing: "dance", danced: "dance", changing: "change", changed: "change",
  charging: "charge", charged: "charge", managing: "manage", managed: "manage",
  judging: "judge", judged: "judge", hoping: "hope", hoped: "hope",
  liking: "like", liked: "like", joking: "joke", joked: "joke",
  moving: "move", moved: "move", loving: "love", loved: "love",
  living: "live", lived: "live", giving: "give", given: "give",
  saving: "save", saved: "save", using: "use", used: "use",
  sizing: "size", sized: "size", tying: "tie", tied: "tie",
  dying: "die", died: "die", lying: "lie", lied: "lie", vied: "vie",
}));
const UNCHANGING_FINAL_S = new Set([
  "alias", "always", "analysis", "atlas", "basis", "business", "canvas", "chaos",
  "economics", "ethics", "gas", "bus", "his", "lens", "yes", "mathematics", "means",
  "news", "physics", "politics", "series", "species", "status", "this", "thus",
]);
const AMBIGUOUS_ENGLISH_SURFACES = new Set(["lay"]);
const LAY_VERB_INFLECTIONS = new Set(["lays", "laid", "laying"]);

function normalizeEnglishLemmaToken(word) {
  if (!/^[a-z]+$/.test(word)) return word;
  if (UNCHANGING_FINAL_S.has(word)) return word;
  const irregular = IRREGULAR_LEMMA_MAP.get(word);
  if (irregular) return irregular;
  const silentE = SILENT_E_FORMS.get(word);
  if (silentE) return silentE;
  if (word.length > 4 && word.endsWith("ied")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith("ed")) {
    let stem = word.slice(0, -2);
    if (/([^aeiou])\1$/.test(stem)) stem = stem.slice(0, -1);
    if (stem.endsWith("c") || stem.endsWith("v") || stem.endsWith("z")) return `${stem}e`;
    if (/^[^aeiou][aeiou][kp]$/.test(stem)) return `${stem}e`;
    return stem;
  }
  if (word.length > 5 && word.endsWith("ing")) {
    let stem = word.slice(0, -3);
    if (/([^aeiou])\1$/.test(stem)) stem = stem.slice(0, -1);
    if (stem.endsWith("c") || stem.endsWith("v") || stem.endsWith("z")) return `${stem}e`;
    if (/^[^aeiou][aeiou][kp]$/.test(stem)) return `${stem}e`;
    return stem;
  }
  if (word.length > 4 && /(?:ch|sh|ss|x|z)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("es") && word.slice(0, -1).endsWith("e")) {
    return word.slice(0, -1);
  }
  if (!UNCHANGING_FINAL_S.has(word) && word.length > 3 && word.endsWith("s")) {
    if (word.endsWith("ss") || word.endsWith("us") || word.endsWith("is")) return word;
    if (word.endsWith("ys")) return `${word.slice(0, -2)}y`;
    return word.slice(0, -1);
  }
  return word;
}

function normalizeEnglishMatchKey(value) {
  const key = normalizeTermKey(value);
  if (!key) return "";
  return key.split(" ").map(normalizeEnglishLemmaToken).join(" ");
}

function isAmbiguousEnglishSurface(value) {
  const key = normalizeTermKey(value);
  return AMBIGUOUS_ENGLISH_SURFACES.has(key);
}

function isLayVerbInflectionSurface(value) {
  const key = normalizeTermKey(value);
  return LAY_VERB_INFLECTIONS.has(key);
}

function recordTypeForKey(key) {
  return key.includes(" ") ? "phrase" : "word";
}

function matchIndexFor(records) {
  const cached = MATCH_INDEX_CACHE.get(records);
  if (cached) return cached;

  const buildStartedAt = globalThis.performance?.now?.() ?? Date.now();

  const byType = new Map([
    ["word", new Map()],
    ["phrase", new Map()],
  ]);
  const bareLayByType = new Map([
    ["word", []],
    ["phrase", []],
  ]);
  const matchKeyByRecordKey = new Map();
  const bareLayKeys = new Set();
  const phraseRoot = { children: new Map(), records: [] };
  let phraseRecordCount = 0;

  const addPhrasePath = (record, path) => {
    let node = phraseRoot;
    for (const token of path) {
      if (!node.children.has(token)) node.children.set(token, { children: new Map(), records: [] });
      node = node.children.get(token);
    }
    if (!node.records.includes(record)) node.records.push(record);
  };

  for (const record of records.values()) {
    const typeIndex = byType.get(record.type);
    if (!typeIndex) continue;
    const matchKey = normalizeEnglishMatchKey(record.key);
    const surfaceTokens = record.key.split(" ");
    const paths = [surfaceTokens.map(normalizeEnglishLemmaToken)];
    if (record.type === "phrase") {
      phraseRecordCount += 1;
      // `lay` is ambiguous: keep its ordinary `lie` lemma path and an
      // alternate `lay` path so lays/laid/laying phrases remain matchable.
      surfaceTokens.forEach((surface, index) => {
        if (surface !== "lay") return;
        const alternate = [...paths[0]];
        alternate[index] = "lay";
        paths.push(alternate);
      });
      for (const path of paths) addPhrasePath(record, path);
    }
    for (const path of paths) {
      const candidateKey = path.join(" ");
      const candidates = typeIndex.get(candidateKey) || [];
      if (!candidates.includes(record)) candidates.push(record);
      typeIndex.set(candidateKey, candidates);
    }
    matchKeyByRecordKey.set(record.key, matchKey);
    if (record.key.split(" ").includes("lay")) {
      bareLayKeys.add(record.key);
      bareLayByType.get(record.type)?.push(record);
    }
  }

  const index = {
    byType, bareLayByType, matchKeyByRecordKey, bareLayKeys, phraseRoot,
    phraseRecordCount,
    recordCount: records.size,
    buildMs: Math.max(0, (globalThis.performance?.now?.() ?? Date.now()) - buildStartedAt),
  };
  MATCH_INDEX_CACHE.set(records, index);
  return index;
}

function recordsForMatch(records, key, precomputed = null) {
  const exact = records.get(key);
  const type = precomputed?.type || recordTypeForKey(key);
  const matchKey = precomputed?.matchKey || normalizeEnglishMatchKey(key);
  if (!matchKey) return exact ? [exact] : [];
  const exactLayRequested = Boolean(exact) && key.split(" ").includes("lay");
  const requestedLayFamily = exactLayRequested || matchKey.split(" ").includes("lay") ||
    (precomputed?.layInflection ?? key.split(" ").some(isLayVerbInflectionSurface));
  const familyMatchKey = exactLayRequested
    ? key.split(" ").map((token) => token === "lay" ? "lay" : normalizeEnglishLemmaToken(token)).join(" ")
    : matchKey;

  const index = matchIndexFor(records);
  const familyRecords = index.byType.get(type)?.get(familyMatchKey) || [];
  const matches = [];
  for (const record of familyRecords) {
    // A stored bare `lay` row belongs to the `lay` family only when the
    // request resolves to that family; it must not leak into `lie` aliases.
    if (!requestedLayFamily && index.bareLayKeys.has(record.key)) continue;
    matches.push(record);
  }

  // The standalone `lay` surface is the base spelling for its unambiguous
  // forms, even though the general lemma table resolves it to `lie`.
  if (requestedLayFamily) {
    for (const record of index.bareLayByType.get(type) || []) {
      if (index.matchKeyByRecordKey.get(record.key) !== familyMatchKey && !matches.includes(record)) {
        matches.push(record);
      }
    }
  }
  return matches;
}

function selectMatchRecord(records, requestedKey) {
  const exact = records.find((record) => record.key === requestedKey);
  if (exact) return exact;
  return [...records].sort((left, right) => {
    const leftRichness = Number(Boolean(left.translation)) + Number(Boolean(left.phonetic));
    const rightRichness = Number(Boolean(right.translation)) + Number(Boolean(right.phonetic));
    return rightRichness - leftRichness || right.status - left.status ||
      (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  })[0];
}

function effectiveMatchRecord(records, requestedKey) {
  const selected = selectMatchRecord(records, requestedKey);
  if (!selected) return undefined;
  return { ...selected, status: Math.max(...records.map((record) => record.status)) };
}

function phraseRecordEligible(record, matchedSurfaces) {
  const canonicalTokens = record.key.split(" ");
  return !canonicalTokens.some((key, index) => isAmbiguousEnglishSurface(key) &&
    key !== matchedSurfaces[index] && !LAY_VERB_INFLECTIONS.has(matchedSurfaces[index]));
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
  const phonetic = raw.phonetic ?? raw.ipa ?? raw.pronunciation;
  if (typeof phonetic === "string") result.phonetic = phonetic;
  if ([result.translation, result.note, result.phonetic].some((field) => typeof field === "string" && field.length > MAX_RECORD_FIELD_CHARS)) return null;
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
    textChars += record.key.length + record.surface.length + (record.translation?.length || 0) +
      (record.note?.length || 0) + (record.phonetic?.length || 0);
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

function makeRecord({ key, type, surface, status, translation, note, phonetic, source, createdAt, updatedAt }) {
  const record = { key, type, surface, status, createdAt, updatedAt, source };
  if (typeof translation === "string") record.translation = translation;
  if (typeof note === "string") record.note = note;
  if (typeof phonetic === "string") record.phonetic = phonetic;
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
  const hasMetadata = values.some((value) => ["type", "status", "translation", "note", "phonetic", "ipa", "pronunciation"].includes(value));
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
    phonetic: values.findIndex((value) => ["phonetic", "ipa", "pronunciation"].includes(value)),
  };
}

function csvInput(row, columns, defaultStatus) {
  const read = (index) => index >= 0 ? row[index] : undefined;
  const surface = columns ? read(columns.term) : row[0];
  const typeValue = columns ? read(columns.type) : undefined;
  const statusValue = columns ? read(columns.status) : row[1];
  const translation = unescapeSpreadsheetCell(columns ? read(columns.translation) : row[2]);
  const note = unescapeSpreadsheetCell(columns ? read(columns.note) : row[3]);
  const phonetic = unescapeSpreadsheetCell(columns ? read(columns.phonetic) : row[4]);
  const key = normalizeTermKey(surface);
  if (!key) return null;
  const parsedStatus = statusValue == null || String(statusValue).trim() === ""
    ? defaultStatus
    : Number(statusValue);
  if (!STATUSES.has(parsedStatus)) return null;
  const type = String(typeValue || (key.includes(" ") ? "phrase" : "word")).trim().toLowerCase();
  if (type !== "word" && type !== "phrase") return null;
  return { key, surface: String(surface).trim(), type, status: parsedStatus, translation, note, phonetic, source: "import" };
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
      const record = effectiveMatchRecord(recordsForMatch(state.records, key), key);
      if (record) result[key] = recordCopy(record);
    }
    return result;
  }

  async matchPageTokens(tokens) {
    await loadState(this);
    const state = stateOf(this);
    assertWritable(state);
    if (!Array.isArray(tokens) || tokens.length > 6000) {
      throw new RangeError("PDF vocabulary token batch exceeds the supported limit.");
    }
    let totalChars = 0;
    const tokenNormalizeStartedAt = globalThis.performance?.now?.() ?? Date.now();
    const surfaces = tokens.map((value) => {
      if (typeof value !== "string" || value.length > 160 || value.includes(" ")) {
        throw new TypeError("PDF vocabulary tokens must be single normalized surfaces.");
      }
      totalChars += value.length + 1;
      if (totalChars > 131072) throw new RangeError("PDF vocabulary token text exceeds the supported limit.");
      const surface = normalizeTermKey(value);
      if (!surface || surface !== value || surface.includes(" ")) {
        throw new TypeError("PDF vocabulary tokens must be canonical English surfaces.");
      }
      return surface;
    });
    const tokenNormalizeMs = Math.max(0,
      (globalThis.performance?.now?.() ?? Date.now()) - tokenNormalizeStartedAt);

    const startedAt = globalThis.performance?.now?.() ?? Date.now();
    const previousIndex = MATCH_INDEX_CACHE.get(state.records);
    const index = matchIndexFor(state.records);
    const tokenLemmaKeys = surfaces.map(normalizeEnglishLemmaToken);
    const wordMatches = [];
    for (let indexInPage = 0; indexInPage < surfaces.length; indexInPage += 1) {
      const surface = surfaces[indexInPage];
      const record = effectiveMatchRecord(recordsForMatch(state.records, surface, {
        type: "word",
        matchKey: tokenLemmaKeys[indexInPage],
        layInflection: LAY_VERB_INFLECTIONS.has(surface),
      }), surface);
      if (!record) continue;
      wordMatches.push({
        index: indexInPage,
        key: surface,
        storageKey: record.key,
        type: "word",
        status: record.status,
      });
    }

    const phraseMatches = [];
    let trieSteps = 0;
    let startIndex = 0;
    while (startIndex < surfaces.length) {
      let node = index.phraseRoot;
      let best = null;
      for (let offset = 0; offset < 12 && startIndex + offset < surfaces.length; offset += 1) {
        const tokenIndex = startIndex + offset;
        const lemmaKey = tokenLemmaKeys[tokenIndex];
        if (!lemmaKey) break;
        trieSteps += 1;
        node = node.children.get(lemmaKey);
        if (!node) break;
        if (!node.records.length) continue;
        const matchedSurfaces = surfaces.slice(startIndex, tokenIndex + 1);
        const eligible = node.records.filter((record) => phraseRecordEligible(record, matchedSurfaces));
        const record = effectiveMatchRecord(eligible, matchedSurfaces.join(" "));
        if (record) best = { record, endIndex: tokenIndex + 1 };
      }
      if (best) {
        const matchedSurface = surfaces.slice(startIndex, best.endIndex).join(" ");
        phraseMatches.push({
          startIndex,
          endIndex: best.endIndex,
          key: matchedSurface,
          storageKey: best.record.key,
          type: "phrase",
          status: best.record.status,
        });
        startIndex = best.endIndex;
      } else {
        startIndex += 1;
      }
    }

    const endedAt = globalThis.performance?.now?.() ?? Date.now();
    return {
      wordMatches,
      phraseMatches,
      metrics: {
        indexCacheHit: Boolean(previousIndex),
        indexBuildMs: previousIndex ? 0 : index.buildMs,
        vocabularyRecordCount: index.recordCount,
        phraseRecordCount: index.phraseRecordCount,
        pageTokenCount: surfaces.length,
        pageTokenNormalizeCount: surfaces.length,
        pageTokenNormalizeMs: tokenNormalizeMs,
        trieSteps,
        hitCount: wordMatches.length + phraseMatches.length,
        matchMs: Math.max(0, endedAt - startedAt - (previousIndex ? 0 : index.buildMs)),
        vocabularyFullScanCount: 0,
        perTokenVocabularyNormalizeCount: 0,
      },
    };
  }

  async getTerm(keyValue) {
    await loadState(this);
    const state = stateOf(this);
    assertWritable(state);
    const key = normalizeTermKey(keyValue);
    return key ? recordCopy(effectiveMatchRecord(recordsForMatch(state.records, key), key)) : undefined;
  }

  async _mutate(keyValue, update, typeHint = null, { propagateStatus = false } = {}) {
    await loadState(this);
    const state = stateOf(this);
    const key = normalizeTermKey(keyValue);
    if (!key) throw new TypeError("Vocabulary term is not a valid English surface form.");
    return enqueue(state, async () => {
      assertWritable(state);
      const matchingRecords = recordsForMatch(state.records, key);
      const previous = effectiveMatchRecord(matchingRecords, key);
      const targetKey = previous?.key || key;
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
      const changedKeys = [];
      if (propagateStatus && matchingRecords.length > 0) {
        // A status is shared by all stored inflection variants. Keep each
        // variant's own surface and dictionary metadata, but prevent an older
        // sibling status from making the family appear to move backwards.
        for (const record of matchingRecords) {
          const updated = cleanRecord({ ...record, status: clean.status, updatedAt: now, source: "user" }, now, "user");
          if (!updated) throw new TypeError("Vocabulary family mutation produced an invalid record.");
          next.set(record.key, updated);
          changedKeys.push(record.key);
        }
        // Apply any requested fields to the selected record after synchronizing
        // the family's status, without copying one variant's definition onto
        // every other spelling.
        next.set(targetKey, clean);
        if (!changedKeys.includes(targetKey)) changedKeys.push(targetKey);
      } else {
        next.set(targetKey, clean);
        changedKeys.push(targetKey);
      }
      const nextRevision = state.revision + 1;
      const text = snapshotText(next, nextRevision);
      await writeSnapshot(state, text, state.diskRaw);
      state.records = next;
      state.revision = nextRevision;
      state.diskRaw = text;
      state.recoveredBackup = false;
      notifySubscribers(state, { revision: nextRevision, type: "mutation", changedKeys });
      return recordCopy(next.get(targetKey));
    });
  }

  setStatus(key, status) {
    validateStatus(status);
    return this._mutate(key, (record) => ({ ...record, status }), null, { propagateStatus: true });
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

  setPhonetic(key, phonetic) {
    if (typeof phonetic !== "string") throw new TypeError("Pronunciation must be text.");
    if (phonetic.length > MAX_RECORD_FIELD_CHARS) throw new RangeError("Pronunciation exceeds the supported field size.");
    return this._mutate(key, (record) => ({ ...record, phonetic }));
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
    for (const name of ["translation", "note", "phonetic"]) {
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
      // If a different inflection already owns this family, edit that record
      // in place instead of creating a parallel stored key for the clicked
      // surface. Exact-key entries may still preserve the user's casing.
      surface: record.key === key ? String(surface).trim() : record.surface,
      status: fields.status == null ? record.status : fields.status,
      ...(fields.translation == null ? {} : { translation: fields.translation }),
      ...(fields.note == null ? {} : { note: fields.note }),
      ...(fields.phonetic == null ? {} : { phonetic: fields.phonetic }),
    }), type, { propagateStatus: fields.status != null });
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
    const rows = [["term", "type", "status", "translation", "note", "phonetic"]];
    for (const record of [...state.records.values()].sort((left, right) => left.key.localeCompare(right.key, "en"))) {
      rows.push([record.surface, record.type, record.status, record.translation || "", record.note || "", record.phonetic || ""]);
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
  normalizeEnglishMatchKey,
  isAmbiguousEnglishSurface,
  isLayVerbInflectionSurface,
  parseCsvRows,
  VOCABULARY_DIRECTORY: DIRECTORY,
  VOCABULARY_PATH: SNAPSHOT_PATH,
};
