"use strict";

const now = () => globalThis.performance?.now?.() ?? Date.now();
const MAX_DIAGNOSTIC_JSON_BYTES = 19_990_000;
const utf8Length = value => {
  const text = String(value);
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length &&
      text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
};
const errorInfo = error => { try { return {
  name: String(error?.name || "Error").slice(0, 128),
  message: String(error?.message ?? error).slice(0, 4096),
  stack: String(error?.stack || "").slice(0, 16384),
  ...(typeof error?.workerName === "string" ? { workerName: error.workerName.slice(0, 128) } : {}),
  ...(typeof error?.workerCode === "string" ? { workerCode: error.workerCode.slice(0, 128) } : {}),
  ...(typeof error?.workerMethod === "string" ? { workerMethod: error.workerMethod.slice(0, 128) } : {}),
  ...(typeof error?.workerPhase === "string" ? { workerPhase: error.workerPhase.slice(0, 128) } : {}),
  ...(typeof error?.workerStack === "string" ? { workerStack: error.workerStack.slice(0, 16384) } : {}),
}; } catch { return { name: "Error", message: "Unreadable thrown value", stack: "" }; } };

// Only diagnostic metadata enters this writer: never arguments, return values,
// editor text, message payloads, ArrayBuffers or DOM objects.
function createSessionLog({ adapter, directory, version, maxBuffered = 1024 * 1024, partLimit = 8 * 1024 * 1024, interval = 1000 }) {
  const started = now(), session = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 10)}`;
  let lines = [], size = 0, sequence = 0, callSequence = 0, dropped = 0;
  let part = 0, partSize = 0, ready = false, closed = false, timer, flushing = null, lastWriteError = null;
  const cleanups = [];
  const path = () => `${directory}/${session}-${String(part).padStart(3, "0")}.log`;
  function record(kind, fields = {}) {
    if (closed) return;
    try {
      const line = JSON.stringify({ time: new Date().toISOString(), elapsedMs: +(now() - started).toFixed(3), seq: ++sequence, kind, ...fields }) + "\n";
      if (size + line.length > maxBuffered) { dropped++; return; }
      lines.push(line); size += line.length;
    } catch { dropped++; }
  }
  async function ensureDirectory() {
    if (ready) return;
    let current = "";
    for (const name of directory.split("/")) {
      current = current ? `${current}/${name}` : name;
      if (!await adapter.exists(current)) await adapter.mkdir(current);
    }
    ready = true;
  }
  function flush() {
    if (flushing) return flushing;
    flushing = Promise.resolve().then(async () => {
      if (!lines.length && !dropped) return lastWriteError === null;
      const batch = lines; lines = []; size = 0;
      const lost = dropped; dropped = 0;
      if (lost) batch.push(JSON.stringify({ time: new Date().toISOString(), kind: "log-loss", dropped: lost, reason: "buffer-limit-or-serialization" }) + "\n");
      const text = batch.join("");
      try {
        await ensureDirectory();
        if (partSize && (partSize + text.length > partLimit || typeof adapter.append !== "function")) { part++; partSize = 0; }
        if (!partSize) await adapter.write(path(), text);
        else await adapter.append(path(), text);
        partSize += text.length;
        lastWriteError = null;
        return true;
      } catch (error) {
        // Do not retry an ambiguous append: that could duplicate a whole batch.
        // Preserve an explicit loss marker on the next successful write instead.
        dropped += batch.length;
        part++; partSize = 0; ready = false;
        lastWriteError = errorInfo(error);
        console.warn("PDF Reader local log write failed", error);
        return false;
      }
    }).finally(() => { flushing = null; });
    return flushing;
  }
  function begin(fn) { const id = ++callSequence; record("function.begin", { fn, call: id }); return { id, start: now(), fn }; }
  function end(call, error) { record(error ? "function.error" : "function.end", { fn: call.fn, call: call.id, durationMs: +(now() - call.start).toFixed(3), ...(error ? { error: errorInfo(error) } : {}) }); }
  function observe(target, scope, accept = () => true) {
    if (!target?.addEventListener) return;
    const listeners = [];
    const on = (type, handler) => { target.addEventListener(type, handler, true); listeners.push([type, handler]); };
    for (const type of ["click", "dblclick", "contextmenu", "pointerdown", "pointermove", "pointerup", "pointercancel", "wheel", "keydown", "input", "change", "compositionstart", "compositionend", "scroll"]) {
      on(type, event => {
        if (!accept(event)) return;
        const element = event.target;
        record("user", { scope, event: type, trusted: event.isTrusted === true, target: element?.id || element?.tagName || "window", pointerType: event.pointerType, pointerId: event.pointerId, button: event.button, buttons: event.buttons, x: event.clientX, y: event.clientY, deltaX: event.deltaX, deltaY: event.deltaY, key: type === "keydown" ? (/^(Enter|Escape|Tab|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Shift|Control|Alt|Meta|CapsLock|Dead|Process|Unidentified|F[0-9]{1,2})$/.test(event.key || "") ? event.key : "character") : undefined, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey, scrollTop: type === "scroll" ? element?.scrollTop : undefined });
      });
    }
    on("error", event => record("error", { scope, error: errorInfo(event.error || event.message), source: event.filename, line: event.lineno, column: event.colno }));
    on("unhandledrejection", event => record("unhandledrejection", { scope, error: errorInfo(event.reason) }));
    const cleanup = () => { for (const [type, fn] of listeners) target.removeEventListener(type, fn, true); };
    cleanups.push(cleanup);
    return cleanup;
  }
  function close() {
    globalThis.clearInterval(timer);
    for (const cleanup of cleanups.splice(0)) cleanup();
    // Allow the enclosing onunload wrapper to record its final return first.
    return Promise.resolve().then(async () => { record("session.end"); closed = true; await flush(); if (lines.length || dropped) await flush(); });
  }
  async function exportDiagnostic(diagnostic, outputPath, writeText, chunkLimit = 256 * 1024, requestedMaxBytes = MAX_DIAGNOSTIC_JSON_BYTES) {
    const maxBytes = Number.isSafeInteger(requestedMaxBytes) && requestedMaxBytes > 0
      ? Math.min(requestedMaxBytes, MAX_DIAGNOSTIC_JSON_BYTES)
      : MAX_DIAGNOSTIC_JSON_BYTES;
    // An explicit cutoff keeps ongoing user activity from extending the export.
    // Two flushes cover a pre-existing in-flight batch and all rows buffered
    // at entry. Rows arriving after this cutoff belong to the next export.
    const cutoffSequence = sequence, capturedAt = new Date().toISOString();
    let flushSucceeded = await flush();
    if (lines.length || dropped) flushSucceeded = (await flush()) && flushSucceeded;
    // Seal the active part before reading. Subsequent events go to another
    // part, so an export cannot chase a file that it is itself extending.
    const lastPart = part;
    if (partSize) { part++; partSize = 0; }
    const metadata = { schema: 1, currentSession: session, capturedAt, cutoffSequence, flushSucceeded, lastWriteError };
    const fullDiagnosticText = JSON.stringify(diagnostic);
    const metadataBudget = Math.min(1024 * 1024, Math.floor(maxBytes / 4));
    let diagnosticText = fullDiagnosticText;
    if (utf8Length(diagnosticText) > metadataBudget) {
      const compact = {
        schema: diagnostic?.schema ?? 1,
        exportedAt: diagnostic?.exportedAt || capturedAt,
        pluginVersion: diagnostic?.pluginVersion || diagnostic?.version || null,
        appVersion: diagnostic?.appVersion || null,
        mobile: diagnostic?.mobile ?? null,
        activeReaderCount: diagnostic?.activeReaderCount ?? null,
        readers: Array.isArray(diagnostic?.readers) ? diagnostic.readers.slice(0, 32).map(reader => ({
          documentId: reader?.documentId || null,
          openRequest: reader?.openRequest ?? null,
          revision: reader?.revision ?? null,
          confirmedRevision: reader?.confirmedRevision ?? null,
          dirty: reader?.dirty ?? null,
          readOnly: reader?.readOnly ?? null,
          startupTimings: reader?.startupTimings || null,
        })) : [],
        diagnosticTruncated: true,
        originalDiagnosticBytes: utf8Length(fullDiagnosticText),
      };
      diagnosticText = JSON.stringify(compact);
    }
    const prefix = `${diagnosticText.slice(0, -1)},"runtimeLog":${JSON.stringify(metadata).slice(0, -1)},"records":[`;
    const prefixBytes = utf8Length(prefix);
    const footerReserveBytes = Math.min(1024 * 1024, Math.max(256, Math.floor(maxBytes / 8)));
    const recordBudgetBytes = Math.max(0, maxBytes - prefixBytes - footerReserveBytes);
    let recordBytes = 0;
    const sources = [], readErrors = [];
    const sessions = new Map();
    let count = 0, rawRecordCount = 0, filteredRecordCount = 0, sizeOmittedRecordCount = 0;
    let loss = 0, readErrorCount = 0, sourceCount = 0, omittedSources = 0;
    const errorCounts = new Map(), recentContextBySession = new Map(), latestOverflowBySession = new Map();
    const overflowEvents = [];
    let overflowEventCount = 0;
    const addReadError = error => {
      readErrorCount++;
      if (readErrors.length < 64) {
        const raw = error?.error;
        readErrors.push({
          ...error,
          ...(raw && typeof raw === "object" ? { error: {
            name: String(raw.name || "Error").slice(0, 128),
            message: String(raw.message || "").slice(0, 512),
            ...(raw.stack ? { stack: String(raw.stack).slice(0, 1024) } : {}),
          } } : {}),
        });
      }
    };
    const compactContext = (record, scope = "host") => {
      const item = {
        time: typeof record?.time === "string" ? record.time : null,
        scope,
        kind: typeof record?.kind === "string" ? record.kind : null,
      };
      for (const key of ["fn", "call", "revision", "type", "method", "saveTransactionId", "status", "errorCode", "errorName", "workerRequestCount", "prepareLocalTotalMs", "saveTotalMs", "durationMs"]) {
        if (typeof record?.[key] === "string" || (typeof record?.[key] === "number" && Number.isFinite(record[key]))) item[key] = record[key];
      }
      const error = record?.error;
      if (error && typeof error === "object") {
        if (typeof error.name === "string") item.errorName = error.name.slice(0, 128);
        if (typeof error.code === "string") item.errorCode = error.code.slice(0, 128);
        if (typeof error.message === "string") item.errorMessage = error.message.slice(0, 512);
      } else if (typeof error === "string") item.errorMessage = error.slice(0, 512);
      return item;
    };
    const isRelevantContext = record => record?.kind === "performance" ||
      (record?.kind === "protocol" && /^(save|sync|heavy-acquire|heavy-release)$/.test(record.type || "")) ||
      (/^(function\.begin|function\.end|function\.error)$/.test(record?.kind || "") && /save|prepareLocal|merge|fingerprint|checkpoint|recover|write/i.test(record.fn || "")) ||
      /^(error|unhandledrejection)$/.test(record?.kind || "");
    function observeDiagnosticRecord(record, sourceSession, scope = "host") {
      if (!record || typeof record !== "object") return;
      const isError = /^(error|function\.error|unhandledrejection|console\.error)$/.test(record.kind || "");
      const error = record.error && typeof record.error === "object" ? record.error : null;
      const message = String(error?.message ?? (typeof record.error === "string" ? record.error : record.message ?? ""));
      const errorName = String(error?.name || record.errorName || (record.kind === "unhandledrejection" ? "UnhandledRejection" : "Error"));
      if (isError) {
        const key = `${errorName}\u0000${message.slice(0, 512)}`;
        if (errorCounts.has(key)) errorCounts.set(key, errorCounts.get(key) + 1);
        else if (errorCounts.size < 2000) errorCounts.set(key, 1);
      }
      const relevant = isRelevantContext(record);
      const compact = relevant ? compactContext(record, scope) : null;
      if (/maximum call stack size exceeded|too much recursion/i.test(message)) {
        overflowEventCount++;
        const prior = recentContextBySession.get(sourceSession) || [];
        const incident = {
          time: typeof record.time === "string" ? record.time : null,
          sourceSession,
          scope,
          fn: typeof record.fn === "string" ? record.fn : null,
          call: Number.isSafeInteger(record.call) ? record.call : null,
          revision: Number.isFinite(record.revision) ? record.revision : null,
          documentId: typeof record.documentId === "string" ? record.documentId.slice(0, 80) : null,
          rendererGeneration: typeof record.rendererGeneration === "string" ? record.rendererGeneration.slice(0, 80) : null,
          saveTransactionId: typeof record.saveTransactionId === "string" ? record.saveTransactionId.slice(0, 80) : null,
          error: {
            name: errorName.slice(0, 128),
            message: message.slice(0, 512),
            ...(typeof error?.code === "string" ? { code: error.code.slice(0, 128) } : {}),
            ...(typeof error?.workerMethod === "string" ? { workerMethod: error.workerMethod.slice(0, 128) } : {}),
            ...(typeof error?.workerPhase === "string" ? { workerPhase: error.workerPhase.slice(0, 128) } : {}),
            ...(typeof error?.stack === "string" ? { stack: error.stack.slice(0, 4096) } : {}),
            ...(typeof error?.workerStack === "string" ? { workerStack: error.workerStack.slice(0, 8192) } : {}),
          },
          context: prior.slice(-10),
        };
        if (compact && incident.context.length < 12) incident.context.push(compact);
        if (overflowEvents.length < 20) {
          overflowEvents.push(incident);
          latestOverflowBySession.set(sourceSession, { incident, at: Date.parse(incident.time || "") || 0 });
        }
      } else if (relevant) {
        const recent = recentContextBySession.get(sourceSession) || [];
        recent.push(compact);
        if (recent.length > 16) recent.shift();
        recentContextBySession.set(sourceSession, recent);
        const active = latestOverflowBySession.get(sourceSession);
        const at = Date.parse(record.time || "") || 0;
        if (active && at >= active.at && at - active.at <= 5000 && active.incident.context.length < 20) {
          active.incident.context.push(compact);
          if (record.saveTransactionId && !active.incident.saveTransactionId) active.incident.saveTransactionId = String(record.saveTransactionId).slice(0, 80);
        } else if (active && at - active.at > 5000) latestOverflowBySession.delete(sourceSession);
      }
    }
    const errorAnalysis = () => ({
      schema: 1,
      observedErrorEvents: [...errorCounts.values()].reduce((sum, value) => sum + value, 0),
      grouped: [...errorCounts.entries()].map(([key, count]) => {
        const [name, message] = key.split("\u0000");
        return { name, message, count };
      }).sort((a, b) => b.count - a.count).slice(0, 30),
      stackOverflow: { eventCount: overflowEventCount, omittedEvents: Math.max(0, overflowEventCount - overflowEvents.length), events: overflowEvents },
    });
    const recordForSelection = record => {
      if (record?.kind !== "viewer" || typeof record.row !== "string") return record;
      try {
        return { ...JSON.parse(record.row), documentId: record.documentId, rendererGeneration: record.rendererGeneration };
      } catch { return record; }
    };
    const shouldIncludeRecord = sourceRecord => {
      const record = recordForSelection(sourceRecord);
      const kind = String(record?.kind || "");
      if (/^(error|function\.error|unhandledrejection|console\.error|log-loss|log-parse-error|session\.start|session\.end|performance|annotationStore)$/.test(kind)) return true;
      if (kind === "protocol") return /^(save|sync|recover|heavy-acquire|heavy-release|close|checkpoint)$/.test(record.type || "");
      if (/^(function\.begin|function\.end)$/.test(kind)) return /save|sync|recover|checkpoint|operation|snapshot|close|commit|hydrate|persist|flush|diagnostic/i.test(record.fn || "");
      if (kind === "user") {
        const event = String(record.event || "");
        if (event === "pointermove" || event === "mousemove") return Number(record.seq || 0) % 256 === 0;
        if (event === "wheel" || event === "scroll" || event === "touchmove") return Number(record.seq || 0) % 64 === 0;
        return /^(click|dblclick|contextmenu|pointerdown|pointerup|pointercancel|keydown|input|change|compositionstart|compositionend)$/.test(event);
      }
      return /^(annotation-|external-annotation\.|save\.|sync\.|recover\.|close\.|pdf\.export)/.test(kind);
    };
    const listing = await adapter.list(directory).catch(error => { addReadError({ file: "log-directory", error: errorInfo(error) }); return { files: [] }; });
    const files = (listing.files || []).filter(file => {
      const name = file.slice(file.lastIndexOf("/") + 1);
      if (!/^\d{4}-\d{2}-\d{2}T[\w-]+-\d{3,}\.log$/.test(name)) return false;
      return !name.startsWith(`${session}-`) || Number(name.slice(session.length + 1, -4)) <= lastPart;
    }).sort((a, b) => {
      const split = file => /^(.*)-(\d+)\.log$/.exec(file);
      const left = split(a), right = split(b);
      return left[1].localeCompare(right[1]) || Number(left[2]) - Number(right[2]);
    });
    async function* chunks() {
      let chunk = "";
      for (const file of files) {
      const source = { file: file.slice(file.lastIndexOf("/") + 1), recordOffset: count, recordCount: 0, rawRecordCount: 0 };
        const sourceSession = source.file.replace(/-\d+\.log$/, "");
        if (!sessions.has(sourceSession)) sessions.set(sourceSession, { ended: false });
        sourceCount++;
        if (sources.length < 2000) sources.push(source); else omittedSources++;
        let text;
        try { text = await adapter.read(file); } catch (error) { addReadError({ file: source.file, error: errorInfo(error) }); continue; }
        // Read only one persisted part at a time and emit bounded JSON chunks;
        // never collect all sessions or parsed records in memory.
        let offset = 0, lineNumber = 0;
        while (offset < text.length) {
          const end = text.indexOf("\n", offset);
          let row = text.slice(offset, end < 0 ? text.length : end);
          offset = end < 0 ? text.length : end + 1; lineNumber++;
          if (!row.trim()) continue;
          let record;
          try {
            record = JSON.parse(row);
            if (sourceSession === session && Number(record?.seq) > cutoffSequence) continue;
            rawRecordCount++;
            source.rawRecordCount++;
            if (record?.kind === "session.end") sessions.get(sourceSession).ended = true;
            if (record?.kind === "log-loss") loss += Number(record.dropped) || 0;
            let observedRecord = record;
            if (record?.kind === "viewer" && typeof record.row === "string") {
              const viewer = JSON.parse(record.row);
              if (viewer.kind === "log-loss") loss += Number(viewer.dropped) || 0;
              observedRecord = { ...viewer, documentId: record.documentId, rendererGeneration: record.rendererGeneration };
              observeDiagnosticRecord(observedRecord, sourceSession, "viewer");
            } else {
              observeDiagnosticRecord(record, sourceSession, "host");
            }
          } catch {
            addReadError({ file: source.file, line: lineNumber, error: { message: "Invalid JSON log record" } });
            row = JSON.stringify({ kind: "log-parse-error", file: source.file, line: lineNumber, raw: row.slice(0, 20000) });
            record = { kind: "log-parse-error" };
          }
          if (!shouldIncludeRecord(record)) { filteredRecordCount++; continue; }
          const rowBytes = utf8Length(row) + (count ? 1 : 0);
          if (recordBytes + rowBytes > recordBudgetBytes) { sizeOmittedRecordCount++; continue; }
          if (chunk && chunk.length + row.length > chunkLimit) { yield chunk; chunk = ""; }
          chunk += (chunk ? "," : "") + row;
          recordBytes += rowBytes;
          count++; source.recordCount++;
        }
      }
      if (chunk) yield chunk;
    }
    const interruptedSessionIds = () => [...sessions].filter(([id, status]) => id !== session && !status.ended).map(([id]) => id);
    const interruptedSessions = () => interruptedSessionIds().slice(0, 1000);
    const complete = () => flushSucceeded && readErrorCount === 0 && loss === 0 &&
      interruptedSessionIds().length === 0 && filteredRecordCount === 0 && sizeOmittedRecordCount === 0 && omittedSources === 0;
    const footer = () => `],"errorAnalysis":${JSON.stringify(errorAnalysis())},"sources":${JSON.stringify(sources)},"sourceCount":${sourceCount},"omittedSources":${omittedSources},"recordCount":${count},"rawRecordCount":${rawRecordCount},"filteredRecordCount":${filteredRecordCount},"sizeOmittedRecordCount":${sizeOmittedRecordCount},"droppedRecords":${loss},"readErrors":${JSON.stringify(readErrors)},"readErrorCount":${readErrorCount},"interruptedSessions":${JSON.stringify(interruptedSessions())},"interruptedSessionCount":${interruptedSessionIds().length},"maxBytes":${maxBytes},"complete":${complete()}}}\n`;
    let outputBytes = 0;
    if (typeof adapter.append === "function" && typeof adapter.rename === "function") {
      const temporary = `${outputPath}.partial`;
      await writeText(temporary, prefix);
      let first = true;
      for await (const chunk of chunks()) { await adapter.append(temporary, (first ? "" : ",") + chunk); first = false; }
      const ending = footer();
      outputBytes = prefixBytes + recordBytes + utf8Length(ending);
      if (outputBytes > maxBytes) {
        await adapter.remove?.(temporary);
        throw new Error(`Compacted diagnostic exceeds the ${maxBytes}-byte export limit.`);
      }
      await adapter.append(temporary, ending);
      await adapter.rename(temporary, outputPath);
    } else {
      // Keep a single inspectable JSON file on adapters without append support.
      // chunks() has already enforced a strict UTF-8 byte budget.
      const recordChunks = [];
      for await (const chunk of chunks()) recordChunks.push(chunk);
      const ending = footer();
      outputBytes = prefixBytes + recordBytes + utf8Length(ending);
      if (outputBytes > maxBytes) throw new Error(`Compacted diagnostic exceeds the ${maxBytes}-byte export limit.`);
      await writeText(outputPath, prefix + recordChunks.join(recordChunks.length ? "," : "") + ending);
    }
    return { outputPath, recordCount: count, rawRecordCount, omittedRecords: filteredRecordCount + sizeOmittedRecordCount, complete: complete(), sources: sourceCount, bytes: outputBytes, maxBytes };
  }
  record("session.start", { version, directory, session });
  timer = globalThis.setInterval(() => { void flush(); }, interval);
  timer?.unref?.();
  return { record, begin, end, flush, close, observe, exportDiagnostic, errorInfo, get path() { return path(); }, get lastWriteError() { return lastWriteError; } };
}

function traceFunction(original, fn, getLog) {
  return function (...args) {
    let log, call;
    try { log = getLog(this); call = log?.begin(fn); } catch { /* Logging never blocks the original call. */ }
    const finish = error => { try { if (call) log.end(call, error); } catch { /* Keep the original result. */ } };
    let value;
    try { value = original.apply(this, args); } catch (error) { finish(error); throw error; }
    try {
      if (value && Object.prototype.toString.call(value) === "[object Promise]") {
        Promise.prototype.then.call(value, () => finish(), error => finish(error));
        return value;
      }
    } catch { /* An observer must not replace a result or throw. */ }
    finish();
    return value;
  };
}

function traceMethods(object, scope, getLog) {
  for (const name of Object.getOwnPropertyNames(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    if (name === "constructor" || typeof descriptor.value !== "function") continue;
    Object.defineProperty(object, name, { ...descriptor, value: traceFunction(descriptor.value, `${scope}.${name}`, getLog) });
  }
  return object;
}

module.exports = { createSessionLog, traceFunction, traceMethods };
