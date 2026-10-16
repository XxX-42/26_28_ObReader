import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const launchMetadataByBrowser = new WeakMap();
const processIdentityByBrowser = new WeakMap();
const DEFAULT_ARTIFACTS_DIRECTORY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "artifacts",
);

function safeTestName(value) {
  const slug = String(value || "browser-test")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "browser-test";
}

function errorSummary(error) {
  return {
    name: String(error?.name || "Error").slice(0, 100),
    message: String(error?.message || error || "").slice(0, 500),
  };
}

function metadataSnapshot(metadata) {
  return {
    launchId: metadata.launchId,
    testName: metadata.testName,
    state: metadata.state,
    cleanupState: metadata.cleanupState,
    crashpadDirectory: metadata.crashpadDirectory,
    recordPath: metadata.recordPath,
    ownerMarkerPath: metadata.ownerMarkerPath,
    browserPid: metadata.browserPid,
    browserExecutable: metadata.browserExecutable,
    recordErrors: metadata.recordErrors.map((entry) => ({ ...entry })),
  };
}

async function writeOwnerMarker(metadata) {
  const handle = await open(metadata.ownerMarkerPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({
      schemaVersion: 1,
      launchId: metadata.launchId,
      testName: metadata.testName,
      createdAt: metadata.createdAt,
      ownerPid: process.pid,
      crashpadDirectory: metadata.crashpadDirectory,
    }, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function appendLaunchRecord(metadata, fields) {
  const record = {
    schemaVersion: 1,
    launchId: metadata.launchId,
    testName: metadata.testName,
    crashpadDirectory: metadata.crashpadDirectory,
    ownerMarkerPath: metadata.ownerMarkerPath,
    recordedAt: new Date().toISOString(),
    ...fields,
  };
  const flags = metadata.recordCreated ? "a" : "ax";
  const handle = await open(metadata.recordPath, flags, 0o600);
  metadata.recordCreated = true;
  try {
    await handle.appendFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function addRecordError(metadata, stage, error) {
  metadata.recordErrors.push({ stage, ...errorSummary(error) });
  metadata.state = "record-write-failed";
}

async function recordState(metadata, state, extra = {}) {
  metadata.state = state;
  try {
    await appendLaunchRecord(metadata, {
      state,
      cleanupState: metadata.cleanupState,
      browserPid: metadata.browserPid,
      browserExecutable: metadata.browserExecutable,
      recordErrors: metadata.recordErrors,
      ...extra,
    });
  } catch (error) {
    addRecordError(metadata, `record-${state}`, error);
  }
}

/**
 * Launch a test-owned browser with a unique, retained Crashpad database.
 * The launch record contains ownership and outcome metadata, never the full
 * child environment or arbitrary launch options.
 */
export async function launchTestBrowser(
  puppeteer,
  launchOptions = {},
  {
    testName = "browser-test",
    artifactsDir = DEFAULT_ARTIFACTS_DIRECTORY,
    crashpadRoot = tmpdir(),
  } = {},
) {
  if (typeof puppeteer?.launch !== "function") {
    throw new TypeError("A Puppeteer-compatible launcher is required");
  }
  if (!launchOptions || typeof launchOptions !== "object" || Array.isArray(launchOptions)) {
    throw new TypeError("Browser launch options must be an object");
  }
  if (
    launchOptions.env !== undefined &&
    launchOptions.env !== null &&
    (typeof launchOptions.env !== "object" || Array.isArray(launchOptions.env))
  ) {
    throw new TypeError("Browser launch env must be an object");
  }

  const displayTestName = String(testName || "browser-test").trim().slice(0, 160) || "browser-test";
  const testNameSlug = safeTestName(displayTestName);
  const artifactRoot = path.resolve(artifactsDir);
  await mkdir(artifactRoot, { recursive: true });
  const launchDirectory = await mkdtemp(
    path.join(
      artifactRoot,
      `browser-launch-${testNameSlug}-${Date.now()}-${process.pid}-`,
    ),
  );
  const resolvedCrashpadRoot = path.resolve(crashpadRoot);
  const metadata = {
    launchId: randomUUID(),
    testName: displayTestName,
    state: "launching",
    cleanupState: null,
    createdAt: new Date().toISOString(),
    crashpadDirectory: null,
    recordPath: path.join(launchDirectory, "launch-record.jsonl"),
    ownerMarkerPath: path.join(launchDirectory, "owner.json"),
    browserPid: null,
    browserExecutable: null,
    recordCreated: false,
    recordErrors: [],
  };

  try {
    await mkdir(resolvedCrashpadRoot, { recursive: true, mode: 0o700 });
    metadata.crashpadDirectory = await mkdtemp(
      path.join(resolvedCrashpadRoot, "pdf-reader-crashpad-"),
    );
  } catch (error) {
    metadata.state = "launch-failed";
    try {
      await writeOwnerMarker(metadata);
    } catch (recordError) {
      addRecordError(metadata, "owner-crashpad-directory-setup-failure", recordError);
    }
    try {
      await appendLaunchRecord(metadata, {
        state: "launch-failed",
        failureStage: "prepare-crashpad-directory",
        error: errorSummary(error),
      });
      metadata.recordCreated = true;
    } catch (recordError) {
      addRecordError(metadata, "record-crashpad-directory-setup-failure", recordError);
    }
    try {
      Object.defineProperty(error, "testBrowserLaunchMetadata", {
        configurable: true,
        value: metadataSnapshot(metadata),
      });
    } catch {
      // Preserve the original Crashpad-directory setup error.
    }
    throw error;
  }

  try {
    await writeOwnerMarker(metadata);
    await appendLaunchRecord(metadata, {
      state: "launching",
      ownerPid: process.pid,
    });
    metadata.recordCreated = true;
  } catch (error) {
    metadata.state = "launch-failed";
    try {
      await appendLaunchRecord(metadata, {
        state: "launch-failed",
        failureStage: "prepare-launch-artifacts",
        error: errorSummary(error),
      });
      metadata.recordCreated = true;
    } catch (recordError) {
      addRecordError(metadata, "record-prepare-launch-failure", recordError);
    }
    try {
      Object.defineProperty(error, "testBrowserLaunchMetadata", {
        configurable: true,
        value: metadataSnapshot(metadata),
      });
    } catch {
      // Preserve the original launch-artifact preparation error.
    }
    throw error;
  }

  // Windows environment keys are case-insensitive, ordinary JS objects are
  // not. Canonicalize before merging so Path/PATH cannot shadow one another.
  const normalizeEnvironment = (environment) => Object.fromEntries(
    Object.entries(environment).map(([key, value]) => [process.platform === "win32" ? key.toUpperCase() : key, value]),
  );
  const childEnvironment = {
    ...normalizeEnvironment(process.env),
    ...normalizeEnvironment(launchOptions.env || {}),
    BREAKPAD_DUMP_LOCATION: metadata.crashpadDirectory,
  };
  let browser;
  try {
    const launchArgs = [...(launchOptions.args || [])];
    for (const flag of [
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--no-first-run",
    ]) {
      if (!launchArgs.includes(flag)) launchArgs.push(flag);
    }
    browser = await puppeteer.launch({ ...launchOptions, args: launchArgs, env: childEnvironment });
  } catch (error) {
    metadata.state = "launch-failed";
    try {
      await appendLaunchRecord(metadata, {
        state: "launch-failed",
        failureStage: "puppeteer-launch",
        error: errorSummary(error),
      });
    } catch (recordError) {
      addRecordError(metadata, "record-launch-failure", recordError);
    }
    try {
      Object.defineProperty(error, "testBrowserLaunchMetadata", {
        configurable: true,
        value: metadataSnapshot(metadata),
      });
    } catch {
      // Preserve the original Puppeteer launch error.
    }
    throw error;
  }

  let childProcess = null;
  try {
    childProcess = browser?.process?.() || null;
  } catch {
    // Cleanup performs its own process lookup and records identity failures.
  }
  metadata.browserPid = Number.isInteger(childProcess?.pid) ? childProcess.pid : null;
  const executable = childProcess?.spawnfile || launchOptions.executablePath;
  metadata.browserExecutable = executable ? path.basename(String(executable)) : null;
  if (childProcess && Number.isInteger(childProcess.pid)) {
    processIdentityByBrowser.set(browser, {
      child: childProcess,
      pid: childProcess.pid,
      spawnfile: childProcess.spawnfile || null,
      spawnargs: Array.isArray(childProcess.spawnargs) ? [...childProcess.spawnargs] : [],
    });
  }
  launchMetadataByBrowser.set(browser, metadata);
  await recordState(metadata, "launched");
  return browser;
}

/** Return a copy of the launch owner record for a browser launched above. */
export function getTestBrowserLaunchMetadata(browser) {
  const metadata = launchMetadataByBrowser.get(browser);
  return metadata ? metadataSnapshot(metadata) : null;
}

/**
 * Return the immutable launch-time ChildProcess identity for a test browser.
 * On Windows the Node ChildProcess handle itself is the exact owned process
 * reference; avoiding a PowerShell/CIM query during teardown also prevents a
 * slow process-table query from outliving the bounded browser-close deadline.
 */
export function getTestBrowserProcessIdentity(browser) {
  const identity = processIdentityByBrowser.get(browser);
  return identity ? { ...identity, spawnargs: [...identity.spawnargs] } : null;
}

/** Persist the verified cleanup outcome without removing the Crashpad database. */
export async function finalizeTestBrowserLaunch(browser, cleanupReport) {
  const metadata = launchMetadataByBrowser.get(browser);
  if (!metadata) return null;

  const processReport = cleanupReport?.browser?.process;
  const naturallyClosed = Boolean(
    cleanupReport?.status === "normal" &&
      cleanupReport?.browser?.status === "normal" &&
      Number.isInteger(processReport?.pid) &&
      processReport.exitCode === 0 &&
      (processReport.signalCode === null || processReport.signalCode === undefined) &&
      cleanupReport.browser.connectedAfterClose === false,
  );
  metadata.cleanupState = naturallyClosed
    ? "closed-naturally"
    : cleanupReport?.status === "forced" || cleanupReport?.browser?.status === "forced"
      ? "forced"
      : "cleanup-failed";
  const terminalState = metadata.recordErrors.length
    ? "record-write-failed"
    : metadata.cleanupState;
  await recordState(metadata, terminalState, {
    cleanupStatus: cleanupReport?.status || "unknown",
    browserStatus: cleanupReport?.browser?.status || "unknown",
    processExitCode: processReport?.exitCode ?? null,
    processSignalCode: processReport?.signalCode ?? null,
    connectedAfterClose: cleanupReport?.browser?.connectedAfterClose ?? null,
  });
  return metadataSnapshot(metadata);
}
