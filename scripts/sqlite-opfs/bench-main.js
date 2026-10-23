/* Benchmark-only client for the isolated normal-Chromium harness. */
"use strict";

const params = new URL(location.href).searchParams;
const variant = params.get("variant");
const runId = params.get("runId");
const mode = params.get("mode") || "primary";
const sampleKeys = ["on", "mostly", "subscription", "details", "about"];
const missingKey = "__sqlite_opfs_benchmark_missing_key__";
const endpoint = `/bench-worker.js?variant=${encodeURIComponent(variant)}&runId=${encodeURIComponent(runId)}`;

function snapshotMemory() {
  const memory = performance.memory;
  return memory ? {
    usedJSHeapSize: memory.usedJSHeapSize,
    totalJSHeapSize: memory.totalJSHeapSize,
    jsHeapSizeLimit: memory.jsHeapSizeLimit,
  } : null;
}

function observeLongTasks() {
  const entries = [];
  if (typeof PerformanceObserver === "function" &&
      PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
    const observer = new PerformanceObserver(list => entries.push(...list.getEntries().map(entry => ({
      startTime: entry.startTime,
      duration: entry.duration,
      name: entry.name,
    }))));
    observer.observe({ type: "longtask", buffered: true });
    return { entries, stop: () => observer.disconnect() };
  }
  return { entries: null, stop: () => {} };
}

function createWorkerClient() {
  const worker = new Worker(endpoint);
  const pending = new Map();
  let sequence = 0;
  worker.onmessage = event => {
    const response = event.data || {};
    const pendingRequest = pending.get(response.id);
    if (!pendingRequest) return;
    pending.delete(response.id);
    if (response.ok) pendingRequest.resolve(response.result);
    else pendingRequest.reject(Object.assign(new Error(response.error?.message || "Worker action failed"), {
      name: response.error?.name || "Error",
      stack: response.error?.stack || null,
    }));
  };
  worker.onerror = event => {
    const error = new Error(event.message || "SQLite benchmark worker failed");
    error.filename = event.filename || null;
    error.lineno = event.lineno || null;
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  };
  return {
    worker,
    call(action, payload = {}, transfer = []) {
      const id = `${action}-${++sequence}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, action, payload }, transfer);
      });
    },
    close() { worker.terminate(); },
  };
}

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
}

async function runSecondary() {
  const client = createWorkerClient();
  try {
    const workerFacts = await client.call("init");
    const startedAt = performance.now();
    const result = await client.call("open-secondary", { key: sampleKeys[0] });
    if (!result.opened || result.query?.row?.key !== sampleKeys[0]) {
      throw new Error(`Secondary reader returned the wrong query result: ${JSON.stringify(result)}`);
    }
    return { status: "PASS", initMs: workerFacts.initMs, elapsedMs: performance.now() - startedAt, ...result };
  } catch (error) {
    return { status: "FAIL", error: `${error.name || "Error"}: ${error.message || String(error)}` };
  } finally {
    client.close();
  }
}

if (mode === "secondary") {
  window.__openSecondary = runSecondary;
  window.__secondaryReady = true;
} else {
  window.__benchState = { phase: "starting", status: "RUNNING" };
  const longTasks = observeLongTasks();
  const client = createWorkerClient();
  let resumeAfterSecondary;
  window.__resumeAfterSecondary = () => resumeAfterSecondary?.();

  (async () => {
    const fixture = await fetch("/fixture-report.json", { cache: "no-store" }).then(response => {
      if (!response.ok) throw new Error(`Fixture report HTTP ${response.status}`);
      return response.json();
    });
    if (fixture.databaseSha256 !== "9d6f24efe39fb34e8911c5ea0c9a17a253081b78ce5e644ed593479759a8460e" ||
        fixture.databaseBytes !== 151461888 || fixture.entryCount !== 770611) {
      throw new Error("Frozen SQLite fixture report does not match expected database identity.");
    }
    const beforeStorage = await navigator.storage.estimate();
    const beforeMemory = snapshotMemory();
    const runtimeStartedAt = performance.now();
    const workerFacts = await client.call("init");
    const runtimeInitRoundTripMs = performance.now() - runtimeStartedAt;

    const fetchStartedAt = performance.now();
    const response = await fetch(`/ecdict-v2.sqlite?run=${encodeURIComponent(runId)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Database fixture HTTP ${response.status}`);
    const databaseBytes = await response.arrayBuffer();
    const databaseByteLength = databaseBytes.byteLength;
    const databaseFetchMs = performance.now() - fetchStartedAt;
    const hashStartedAt = performance.now();
    const digest = await crypto.subtle.digest("SHA-256", databaseBytes.slice(0));
    const databaseSha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const databaseHashMs = performance.now() - hashStartedAt;
    if (databaseBytes.byteLength !== fixture.databaseBytes || databaseSha256 !== fixture.databaseSha256) {
      throw new Error(`Prebuilt database identity mismatch: bytes=${databaseBytes.byteLength}, sha256=${databaseSha256}`);
    }

    const installStartedAt = performance.now();
    const install = await client.call("install", { bytes: databaseBytes, sampleKeys }, [databaseBytes]);
    const importAndInitialOpenRoundTripMs = performance.now() - installStartedAt;
    const firstStartedAt = performance.now();
    const firstQuery = await client.call("query", { key: sampleKeys[0] });
    const firstExactQueryRoundTripMs = performance.now() - firstStartedAt;
    const firstExpected = fixture.sampleQueries[0];
    if (firstQuery.row?.key !== firstExpected.key || firstQuery.row?.translation !== firstExpected.translation ||
        firstQuery.row?.phonetic !== firstExpected.phonetic) {
      throw new Error("First exact query returned a row that differs from the fixture report.");
    }
    const validation = await client.call("validate", { sampleKeys });
    if (validation.integrity !== "ok" || validation.entryCount !== fixture.entryCount) {
      throw new Error(`Imported DB validation failed: integrity=${validation.integrity}; rows=${validation.entryCount}`);
    }
    for (let index = 0; index < sampleKeys.length; index += 1) {
      const expected = fixture.sampleQueries[index];
      const observed = validation.samples[index];
      if (expected.key !== observed.key || expected.translation !== observed.translation || expected.phonetic !== observed.phonetic) {
        throw new Error(`Imported DB sample mismatch for ${sampleKeys[index]}`);
      }
    }
    const missingQuery = await client.call("query", { key: missingKey });
    if (missingQuery.row !== null) throw new Error("The missing-key query unexpectedly returned a row.");

    window.__benchState = { phase: "primary-open", status: "RUNNING", workerFacts, dbFilename: install.dbFilename };
    await new Promise(resolve => { resumeAfterSecondary = resolve; });

    const warmQueryTimesMs = [];
    for (let index = 0; index < 20; index += 1) {
      const startedAt = performance.now();
      const result = await client.call("query", { key: sampleKeys[index % sampleKeys.length] });
      const elapsedMs = performance.now() - startedAt;
      if (!result.row || result.row.key !== sampleKeys[index % sampleKeys.length]) {
        throw new Error(`Warm query ${index + 1} returned the wrong row.`);
      }
      warmQueryTimesMs.push(elapsedMs);
    }

    const close = await client.call("close");
    const reopenStartedAt = performance.now();
    const reopened = await client.call("open-existing", { key: sampleKeys[0] });
    const reopenRoundTripMs = performance.now() - reopenStartedAt;
    if (!reopened.firstQuery.row || reopened.firstQuery.row.key !== sampleKeys[0]) {
      throw new Error("Close/reopen first query returned the wrong row.");
    }

    const corruptionFetchStartedAt = performance.now();
    const corruptionBytes = await fetch(`/ecdict-v2.sqlite?corruption=${encodeURIComponent(runId)}`, { cache: "no-store" })
      .then(response => {
        if (!response.ok) throw new Error(`Corruption fixture HTTP ${response.status}`);
        return response.arrayBuffer();
      });
    const corruptionFetchMs = performance.now() - corruptionFetchStartedAt;
    const corruptRebuild = await client.call("corrupt-rebuild", { bytes: corruptionBytes, sampleKeys }, [corruptionBytes]);
    if (!corruptRebuild.corruptionDetected || corruptRebuild.rebuiltIntegrity !== "ok" ||
        corruptRebuild.rebuiltEntryCount !== fixture.entryCount ||
        corruptRebuild.rebuiltSample?.key !== sampleKeys[0]) {
      throw new Error(`Corrupt/rebuild verification failed: ${JSON.stringify(corruptRebuild)}`);
    }

    const afterStorage = await navigator.storage.estimate();
    const afterMemory = snapshotMemory();
    longTasks.stop();
    client.close();
    window.__benchmarkResult = {
      status: "PASS",
      variant,
      runId,
      userAgent: navigator.userAgent,
      isSecureContext,
      crossOriginIsolated,
      beforeStorage,
      afterStorage,
      storageUsageDeltaBytes: Number.isFinite(beforeStorage.usage) && Number.isFinite(afterStorage.usage)
        ? afterStorage.usage - beforeStorage.usage : null,
      beforeMemory,
      afterMemory,
      workerFacts,
      database: {
        sha256: databaseSha256,
        bytes: databaseByteLength,
        fetchMs: databaseFetchMs,
        hashMs: databaseHashMs,
        importMs: install.importMs,
        initialOpenMs: install.openMs,
        installRoundTripMs: importAndInitialOpenRoundTripMs,
        firstExactRow: firstQuery.row,
        integrityCheck: validation.integrity,
        entryCount: validation.entryCount,
        sampleRowsVerified: sampleKeys.length,
        missingQuery: missingQuery.row === null,
      },
      timings: {
        sqliteRuntimeInitMs: workerFacts.initMs,
        workerInitRoundTripMs: runtimeInitRoundTripMs,
        firstExactQueryWorkerMs: firstQuery.elapsedMs,
        firstExactQueryRoundTripMs,
        warmQueryTimesMs,
        warmP50Ms: quantile(warmQueryTimesMs, 0.50),
        warmP95Ms: quantile(warmQueryTimesMs, 0.95),
        warmMaxMs: Math.max(...warmQueryTimesMs),
        closeWasOpen: close.wasOpen,
        reopenMs: reopened.openMs,
        reopenRoundTripMs,
        reopenedFirstQueryWorkerMs: reopened.firstQuery.elapsedMs,
        corruptionFixtureFetchMs: corruptionFetchMs,
      },
      secondaryConnection: window.__secondaryResult || { status: "NOT_RUN" },
      corruptionRebuild: corruptRebuild,
      mainThreadLongTasks: longTasks.entries,
      mainThreadLongTaskTotalMs: longTasks.entries?.reduce((sum, entry) => sum + entry.duration, 0) ?? null,
      mainPageRuntimeResourceBytes: performance.getEntriesByType("resource")
        .filter(entry => entry.name.includes("/runtime/"))
        .reduce((sum, entry) => sum + (entry.transferSize || entry.encodedBodySize || 0), 0),
      profileBytes: null,
    };
    window.__benchState = { phase: "done", status: "PASS" };
  })().catch(error => {
    longTasks.stop();
    client.close();
    window.__benchmarkResult = {
      status: "FAIL",
      variant,
      runId,
      error: `${error.name || "Error"}: ${error.message || String(error)}`,
      stack: error.stack || null,
      userAgent: navigator.userAgent,
      isSecureContext,
      crossOriginIsolated,
    };
    window.__benchState = { phase: "done", status: "FAIL" };
  });
}
