import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { teardownViewerPage } from "./browser-viewer-teardown.mjs";
import { promisify } from "node:util";
import {
  finalizeTestBrowserLaunch,
  getTestBrowserLaunchMetadata,
  getTestBrowserProcessIdentity,
} from "./browser-test-launch.mjs";

const MAX_BROWSER_STDERR_TAIL_BYTES = 4 * 1024;
export const MAX_BROWSER_SAMPLE_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_BROWSER_SAMPLE_STREAM_BYTES = 4 * 1024;
const execFileAsync = promisify(execFile);
const trackedChildIdentities = new WeakMap();

/** Track a test-owned child immediately after spawn, before teardown can mutate. */
export function registerOwnedBrowserChild(child) {
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0) return false;
  const profile = tempProfileFromChild(child);
  if (!profile || typeof child.spawnfile !== "string" || !child.spawnfile) return false;
  const identity = {
    child,
    pid: child.pid,
    spawnfile: child.spawnfile,
    spawnargs: [...(Array.isArray(child.spawnargs) ? child.spawnargs : [])],
    ...profile,
  };
  const existing = trackedChildIdentities.get(child);
  if (existing) {
    return existing.pid === identity.pid && existing.spawnfile === identity.spawnfile &&
      existing.profileDirectory === identity.profileDirectory &&
      JSON.stringify(existing.spawnargs) === JSON.stringify(identity.spawnargs);
  }
  trackedChildIdentities.set(child, identity);
  return true;
}

const sameSpawnIdentity = (child, identity) =>
  Boolean(
    child && identity && child.pid === identity.pid && child.spawnfile === identity.spawnfile &&
    JSON.stringify(child.spawnargs || []) === JSON.stringify(identity.spawnargs || []) &&
    tempProfileFromChild(child)?.profileDirectory === identity.profileDirectory,
  );

const childHandleOwnership = (child, identity) => {
  if (!sameSpawnIdentity(child, identity)) {
    return {
      available: false,
      reason: "The ChildProcess handle no longer matches its captured launch identity",
      pid: child?.pid ?? null,
      ...identity,
      identityMode: "node-child-process-handle",
    };
  }
  const baselineLeader = {
    pid: identity.pid,
    parentPid: process.pid,
    groupId: process.platform === "win32" ? null : identity.pid,
    state: processHasExited(child) ? "Z" : "R",
    startedAt: null,
    executablePath: identity.spawnfile,
    commandLine: identity.spawnargs.join(" "),
  };
  return {
    available: true,
    reason: null,
    ...identity,
    executable: identity.spawnfile,
    pid: identity.pid,
    baselineLeader,
    baselineRows: [baselineLeader],
    groupId: null,
    groupValidatedAtStart: false,
    groupValidationReason: null,
    identityMode: "node-child-process-handle",
  };
};

const boundedProcessOutput = (value) => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ""));
  const tail = bytes.subarray(Math.max(0, bytes.length - MAX_BROWSER_SAMPLE_STREAM_BYTES));
  return {
    limitBytes: MAX_BROWSER_SAMPLE_STREAM_BYTES,
    capturedBytes: tail.length,
    truncated: bytes.length > MAX_BROWSER_SAMPLE_STREAM_BYTES,
    tail: tail.toString("utf8"),
  };
};

const sampleFileIdentity = (stats) => ({
  dev: stats.dev,
  ino: stats.ino,
  size: stats.size,
  mtimeMs: stats.mtimeMs,
});

function withSampleFileIdentity(record, stats) {
  Object.defineProperty(record, "fileIdentity", {
    value: sampleFileIdentity(stats),
    enumerable: false,
  });
  return record;
}

async function truncateOwnedSampleArtifact(outputPath, output) {
  const expected = output?.fileIdentity;
  if (!expected) {
    return {
      ...output,
      truncation: { state: "refused", reason: "No inspected file identity is available" },
    };
  }

  let handle;
  try {
    handle = await open(
      outputPath,
      fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW || 0),
    );
    const current = await handle.stat();
    if (
      !current.isFile() ||
      current.nlink !== 1 ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino ||
      current.size !== expected.size ||
      current.mtimeMs !== expected.mtimeMs
    ) {
      return {
        ...output,
        truncation: {
          state: "refused",
          reason: "Sample output identity changed before bounded cleanup",
        },
      };
    }

    await handle.truncate(MAX_BROWSER_SAMPLE_OUTPUT_BYTES);
    const after = await handle.stat();
    if (!after.isFile() || after.nlink !== 1 || after.dev !== expected.dev || after.ino !== expected.ino) {
      return {
        ...output,
        truncation: { state: "failed", reason: "Sample output identity changed during bounded cleanup" },
      };
    }
    return {
      ...output,
      state: "oversized-truncated",
      originalBytes: expected.size,
      bytes: after.size,
      truncatedToBytes: MAX_BROWSER_SAMPLE_OUTPUT_BYTES,
      truncation: { state: "truncated", limitBytes: MAX_BROWSER_SAMPLE_OUTPUT_BYTES },
    };
  } catch (error) {
    return {
      ...output,
      truncation: { state: "failed", reason: error?.message || String(error) },
    };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function inspectSampleOutputFile(outputPath) {
  let before;
  try {
    before = await lstat(outputPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "missing", exists: false };
    return { state: "unavailable", exists: false, error: error?.message || String(error) };
  }
  if (before.isSymbolicLink()) return { state: "symlink", exists: true };
  if (!before.isFile()) return { state: "not-regular-file", exists: true };
  if (before.size === 0) return { state: "empty", exists: true, bytes: 0 };
  if (before.size > MAX_BROWSER_SAMPLE_OUTPUT_BYTES) {
    return withSampleFileIdentity({
      state: "oversized",
      exists: true,
      bytes: before.size,
      limitBytes: MAX_BROWSER_SAMPLE_OUTPUT_BYTES,
    }, before);
  }

  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of createReadStream(outputPath, {
      flags: fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0),
    })) {
      bytes += chunk.length;
      if (bytes > MAX_BROWSER_SAMPLE_OUTPUT_BYTES) {
        return withSampleFileIdentity({
          state: "oversized-during-read",
          exists: true,
          bytes,
          limitBytes: MAX_BROWSER_SAMPLE_OUTPUT_BYTES,
        }, before);
      }
      hash.update(chunk);
    }
    const after = await lstat(outputPath);
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      bytes !== after.size
    ) {
      return { state: "changed-during-read", exists: true, bytes };
    }
    return { state: "present", exists: true, bytes, sha256: hash.digest("hex") };
  } catch (error) {
    return {
      state: "unreadable",
      exists: true,
      bytes,
      error: error?.message || String(error),
    };
  }
}

const errorRecord = (error) => ({
  name: error?.name || "Error",
  message: error?.message || String(error),
  stack: error?.stack || null,
});

const withinDeadline = async (promise, timeoutMs, label) => {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(
        (value) => ({ state: "fulfilled", value }),
        (error) => ({ state: "rejected", error }),
      ),
      new Promise((resolve) => {
        timer = setTimeout(
          () => resolve({ state: "timeout", error: new Error(`${label} exceeded ${timeoutMs} ms`) }),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Capture a bounded stderr tail from a browser process launched by this test.
 * Call immediately after Puppeteer launch to include startup and shutdown logs.
 * No stdout, page content, or PDF bytes are observed.
 */
export function observeBrowserTestChildStderr(child, { maxBytes = MAX_BROWSER_STDERR_TAIL_BYTES } = {}) {
  const limitBytes = Math.min(
    MAX_BROWSER_STDERR_TAIL_BYTES,
    Math.max(0, Number.isFinite(maxBytes) ? Math.floor(maxBytes) : MAX_BROWSER_STDERR_TAIL_BYTES),
  );
  let tail = Buffer.alloc(0);
  let truncated = false;
  let disposed = false;
  let firstByteAt = null;
  let lastByteAt = null;
  let teardownWatchdogAt = null;
  let childExitAt = null;
  const stderr = child?.stderr;
  const onData = (chunk) => {
    if (disposed) return;
    const receivedAt = Date.now();
    firstByteAt ??= receivedAt;
    lastByteAt = receivedAt;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    const watchdogMarker = Buffer.from("Teardown watchdog expired; recording dump and terminating.");
    const overlap = Math.min(tail.length, Math.max(0, watchdogMarker.length - 1));
    if (teardownWatchdogAt === null &&
      Buffer.concat([tail.subarray(tail.length - overlap), bytes]).includes(watchdogMarker)) {
      teardownWatchdogAt = receivedAt;
    }
    if (limitBytes === 0) return;
    if (bytes.length >= limitBytes) {
      truncated ||= tail.length > 0 || bytes.length > limitBytes;
      tail = Buffer.from(bytes.subarray(bytes.length - limitBytes));
    } else if (limitBytes > 0) {
      const combinedLength = tail.length + bytes.length;
      if (combinedLength <= limitBytes) {
        tail = Buffer.concat([tail, bytes], combinedLength);
      } else {
        const overflow = combinedLength - limitBytes;
        const retainedTail = overflow < tail.length ? tail.subarray(overflow) : Buffer.alloc(0);
        const nextTail = Buffer.allocUnsafe(limitBytes);
        retainedTail.copy(nextTail);
        bytes.copy(nextTail, retainedTail.length);
        tail = nextTail;
        truncated = true;
      }
    }
  };
  const onExit = () => {
    childExitAt ??= Date.now();
  };
  if (typeof stderr?.on === "function") stderr.on("data", onData);
  if (typeof child?.once === "function") {
    child.once("exit", onExit);
    if (processHasExited(child)) childExitAt = Date.now();
  }

  return {
    child,
    snapshot() {
      return {
        limitBytes,
        capturedBytes: tail.length,
        truncated,
        tail: tail.toString("utf8"),
        firstByteAt,
        lastByteAt,
        teardownWatchdogAt,
        childExitAt,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stderr?.removeListener?.("data", onData);
      child?.removeListener?.("exit", onExit);
    },
  };
}

const processHasExited = (child) =>
  Boolean(
    child &&
      (typeof child.exitCode === "number" || typeof child.signalCode === "string"),
  );

const waitForProcessExit = async (child, timeoutMs) => {
  if (!child || processHasExited(child)) return true;
  return new Promise((resolve) => {
    const finish = (exited) => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited || processHasExited(child));
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
    if (processHasExited(child)) finish(true);
  });
};

const splitProcessLine = (line) => {
  const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w+\s+\w+\s+\d+\s+\S+\s+\d{4})\s+(.*)$/);
  if (!match) return null;
  return {
    pid: Number(match[1]),
    parentPid: Number(match[2]),
    groupId: Number(match[3]),
    state: match[4],
    startedAt: match[5],
    commandLine: match[6],
  };
};

const hasNoProcessMatch = (error) =>
  Number(error?.code) === 1 &&
  !String(error?.stdout || "").trim() &&
  !String(error?.stderr || "").trim();

const queryProcessCommand = async (command, args, processQuery) =>
  processQuery(command, args, {
    encoding: "utf8",
    timeout: 1_000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LC_ALL: "C" },
  });

const readLinuxProcessTable = async (pid, groupId, processQuery) => {
  const selectedPids = new Set();
  if (Number.isInteger(groupId) && groupId > 0) {
    let stdout = "";
    try {
      ({ stdout } = await queryProcessCommand("pgrep", ["-g", String(groupId)], processQuery));
    } catch (error) {
      if (!hasNoProcessMatch(error)) throw error;
    }
    for (const line of String(stdout || "").split(/\r?\n/)) {
      const value = line.trim();
      if (/^\d+$/.test(value) && Number(value) > 0) selectedPids.add(Number(value));
    }
  }
  if (Number.isInteger(pid) && pid > 0) selectedPids.add(pid);
  if (selectedPids.size === 0) return [];

  const args = ["-p", [...selectedPids].join(","), "-o", "pid=,ppid=,pgid=,stat=,lstart=,command="];
  let stdout = "";
  try {
    ({ stdout } = await queryProcessCommand("ps", args, processQuery));
  } catch (error) {
    if (!hasNoProcessMatch(error)) throw error;
  }
  return String(stdout || "").split(/\r?\n/).map(splitProcessLine).filter(Boolean);
};

export const readPosixProcessTable = async (
  pid,
  groupId,
  processQuery = execFileAsync,
  platform = process.platform,
) => {
  if (platform === "linux") return readLinuxProcessTable(pid, groupId, processQuery);

  const args = [];
  if (Number.isInteger(pid) && pid > 0) args.push("-p", String(pid));
  if (Number.isInteger(groupId) && groupId > 0) args.push("-g", String(groupId));
  if (args.length === 0) return [];
  args.push("-o", "pid=,ppid=,pgid=,stat=,lstart=,command=");
  let stdout;
  try {
    ({ stdout } = await queryProcessCommand("ps", args, processQuery));
  } catch (error) {
    if (hasNoProcessMatch(error)) {
      // BSD/macOS ps uses exit 1 with empty output when no requested PID or
      // process group remains. Diagnostics or timeouts remain fail-closed.
      return [];
    }
    throw error;
  }
  return String(stdout || "").split(/\r?\n/).map(splitProcessLine).filter(Boolean);
};

const readWindowsProcess = async (pid, processQuery = execFileAsync) => {
  const script = [
    `$processId = ${pid}`,
    "$process = Get-CimInstance Win32_Process -Filter \"ProcessId = $processId\" -ErrorAction SilentlyContinue",
    "if (-not $process) { $process = Get-WmiObject Win32_Process -Filter \"ProcessId = $processId\" -ErrorAction SilentlyContinue }",
    "if ($process) { @{ pid = $process.ProcessId; parentPid = $process.ParentProcessId; executablePath = $process.ExecutablePath; commandLine = $process.CommandLine; startedAt = $process.CreationDate } | ConvertTo-Json -Compress }",
  ].join("; ");
  const { stdout } = await processQuery("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ], {
    encoding: "utf8",
    timeout: 2_000,
    windowsHide: true,
  });
  const output = String(stdout || "").trim();
  if (!output) return null;
  const row = JSON.parse(output);
  return {
    pid: Number(row.pid),
    parentPid: Number(row.parentPid),
    groupId: null,
    state: "R",
    startedAt: String(row.startedAt || ""),
    executablePath: row.executablePath || "",
    commandLine: row.commandLine || "",
  };
};

const readProcessTable = async (pid, groupId, processQuery = execFileAsync) => {
  if (process.platform === "win32") {
    const row = await readWindowsProcess(pid, processQuery);
    return row ? [row] : [];
  }
  return readPosixProcessTable(pid, groupId, processQuery);
};

const tempProfileFromChild = (child) => {
  const args = Array.isArray(child?.spawnargs) ? child.spawnargs : [];
  let profileDirectory = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (typeof argument === "string" && argument.startsWith("--user-data-dir=")) {
      profileDirectory = argument.slice("--user-data-dir=".length);
      break;
    }
    if (argument === "--user-data-dir" && typeof args[index + 1] === "string") {
      profileDirectory = args[index + 1];
      break;
    }
  }
  if (!profileDirectory) return null;
  const basename = profileDirectory.split(/[\\/]/).filter(Boolean).at(-1) || "";
  if (!/^puppeteer_dev_(?:chrome|chromium)_profile-/i.test(basename)) return null;
  return { profileDirectory: profileDirectory.replace(/[\\/]+$/, "") };
};

const normalizePath = (value) =>
  String(value || "").replaceAll("\\", "/").toLowerCase();

const matchesExpectedExecutable = (row, child) => {
  const expected = String(child?.spawnfile || "");
  if (!expected) return false;
  const actual = String(row?.executablePath || row?.commandLine || "");
  const normalizedExpected = normalizePath(expected);
  const normalizedActual = normalizePath(actual).replace(/^["']+/, "");
  if (normalizedActual.startsWith(normalizedExpected)) return true;
  const basename = normalizedExpected.split("/").filter(Boolean).at(-1);
  return Boolean(basename && normalizedActual.startsWith(basename));
};

const rowHasProfile = (row, ownership) =>
  Boolean(
    row &&
      ownership?.profileDirectory &&
      String(row.commandLine || "").includes(ownership.profileDirectory),
  );

export const processIdentityMatches = (row, baseline) =>
  Boolean(
    row &&
      baseline &&
      row.pid === baseline.pid &&
      typeof baseline.startedAt === "string" &&
      baseline.startedAt.trim().length > 0 &&
      typeof row.startedAt === "string" &&
      row.startedAt.trim().length > 0 &&
      row.startedAt === baseline.startedAt,
  );

const liveRows = (rows) => rows.filter((row) => !String(row.state || "").includes("Z"));

const captureOwnership = async (child, processQuery = execFileAsync, browserIdentity = null) => {
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0) {
    return { available: false, reason: "No owned browser PID is available" };
  }
  if (process.platform === "win32" && processQuery === execFileAsync) {
    const tracked = browserIdentity?.child === child
      ? { ...browserIdentity, ...tempProfileFromChild(child) }
      : trackedChildIdentities.get(child);
    if (tracked) return childHandleOwnership(child, tracked);
  }
  const profile = tempProfileFromChild(child);
  if (!profile) {
    return {
      available: false,
      reason: "The launched process does not have a Puppeteer temporary profile identity",
    };
  }
  try {
    const rows = await readProcessTable(child.pid, child.pid, processQuery);
    const leader = rows.find((row) => row.pid === child.pid) || null;
    const validLeader = Boolean(
      leader &&
        rowHasProfile(leader, profile) &&
        matchesExpectedExecutable(leader, child),
    );
    const groupRows =
      process.platform === "win32"
        ? []
        : liveRows(rows).filter((row) => row.groupId === child.pid);
    const groupObserved = groupRows.some((row) => row.pid === child.pid || row.groupId === child.pid);
    const validGroup = Boolean(
      groupRows.length > 0 &&
        groupRows.every((row) => rowHasProfile(row, profile)) &&
        (!leader || (rowHasProfile(leader, profile) && matchesExpectedExecutable(leader, child))),
    );
    return {
      available: validLeader || validGroup,
      reason: validLeader || validGroup ? null : "The process table did not confirm the temporary profile and executable identity",
      ...profile,
      executable: child.spawnfile || null,
      pid: child.pid,
      baselineLeader: leader,
      baselineRows: rows,
      groupId: groupObserved ? child.pid : null,
      groupValidatedAtStart: validGroup,
      groupValidationReason: validGroup
        ? null
        : groupObserved
          ? "The observed process group did not contain only processes with this temporary profile identity"
          : null,
    };
  } catch (error) {
    return {
      available: false,
      reason: `Could not capture the launched process identity: ${error?.message || error}`,
      ...profile,
      executable: child.spawnfile || null,
      pid: child.pid,
      baselineLeader: null,
      baselineRows: [],
      groupId: null,
      groupValidatedAtStart: false,
      groupValidationReason: null,
    };
  }
};

const inspectOwnedTargets = async (child, ownership, processQuery = execFileAsync) => {
  if (!ownership?.available || !child || child.pid !== ownership.pid) {
    return { direct: false, group: false, reason: ownership?.reason || "Process identity is unavailable" };
  }
  if (ownership.identityMode === "node-child-process-handle") {
    if (processHasExited(child)) {
      return { direct: false, group: false, rows: [], alreadyExited: true, reason: "The exact owned ChildProcess has exited" };
    }
    const direct = child === ownership.child && sameSpawnIdentity(child, ownership);
    return {
      direct,
      group: false,
      rows: direct ? [ownership.baselineLeader] : [],
      reason: direct ? null : "The ChildProcess handle no longer matches its captured launch identity",
    };
  }
  try {
    const rows = await readProcessTable(child.pid, ownership.groupId, processQuery);
    const leader = rows.find((row) => row.pid === child.pid) || null;
    const baselineLeader = ownership.baselineLeader;
    const direct = Boolean(
      leader &&
        processIdentityMatches(leader, baselineLeader) &&
        rowHasProfile(leader, ownership) &&
        matchesExpectedExecutable(leader, child),
    );
    let group = false;
    if (ownership.groupId && process.platform !== "win32") {
      const members = liveRows(rows).filter((row) => row.groupId === ownership.groupId);
      const baselineByPid = new Map(
        (ownership.baselineRows || []).map((row) => [row.pid, row]),
      );
      group = Boolean(
        members.length > 0 &&
          members.every((row) => {
            const baseline = baselineByPid.get(row.pid);
            return (
              rowHasProfile(row, ownership) &&
              Boolean(baseline && processIdentityMatches(row, baseline))
            );
          }) &&
          (!leader || direct),
      );
    }
    return { direct, group, leader, rows, reason: direct || group ? null : "The current process identity no longer matches the test-owned temporary profile" };
  } catch (error) {
    return { direct: false, group: false, reason: `Could not revalidate process identity: ${error?.message || error}` };
  }
};

/** Capture the launch-time identity used by later test-owned diagnostics. */
export function captureOwnedBrowserIdentity(child, { processQuery = execFileAsync } = {}) {
  return captureOwnership(child, processQuery);
}

/**
 * Take a short macOS sample only after revalidating the exact launched browser
 * PID, its nonempty start identity, executable, and Puppeteer temporary
 * profile. Sampling is diagnostic-only and never signals the target process.
 */
export async function sampleOwnedBrowserProcess(
  child,
  ownership,
  outputPath,
  {
    durationSeconds = 1,
    timeoutMs = 2_500,
    mayDie = false,
    sampleRunner = execFileAsync,
    processQuery = execFileAsync,
  } = {},
) {
  if (!ownership?.baselineLeader?.startedAt) {
    return { state: "skipped", reason: "Process identity requires an exact nonempty birth timestamp" };
  }
  if (process.platform !== "darwin") {
    return { state: "skipped", reason: "Process sampling is available only on macOS" };
  }
  if (!outputPath || !path.isAbsolute(outputPath)) {
    return { state: "skipped", reason: "An absolute diagnostic sample path is required" };
  }
  if (processHasExited(child)) {
    return { state: "skipped", reason: "The owned browser process had already exited" };
  }
  const targets = await inspectOwnedTargets(child, ownership, processQuery);
  if (!targets.direct) {
    return {
      state: "skipped",
      reason: targets.reason || "The exact owned browser PID could not be revalidated",
    };
  }
  const existingOutput = await inspectSampleOutputFile(outputPath);
  if (existingOutput.exists || existingOutput.state !== "missing") {
    return {
      state: "failed",
      pid: child.pid,
      outputPath,
      identityRevalidated: true,
      reason: existingOutput.exists
        ? "Refusing to overwrite an existing sample output path"
        : `Sample output path could not be checked: ${existingOutput.state}`,
      output: existingOutput,
    };
  }

  let commandResult = null;
  let commandError = null;
  let sampleInvocationStarted = false;
  try {
    sampleInvocationStarted = true;
    commandResult = await sampleRunner(
      "/usr/bin/sample",
      [
        String(child.pid),
        String(durationSeconds),
        ...(mayDie ? ["-mayDie"] : []),
        "-file",
        outputPath,
      ],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    commandError = error;
  }

  let output = await inspectSampleOutputFile(outputPath);
  if (
    sampleInvocationStarted &&
    (output.state === "oversized" || output.state === "oversized-during-read")
  ) {
    output = await truncateOwnedSampleArtifact(outputPath, output);
  }
  const commandOutput = {
    state: commandError ? "rejected" : "fulfilled",
    code: commandError?.code ?? commandResult?.code ?? 0,
    timeoutMs,
    killed: Boolean(commandError?.killed),
    signal: commandError?.signal ?? null,
    message: commandError?.message ? String(commandError.message).slice(0, 1_000) : null,
    stdout: boundedProcessOutput(commandError?.stdout ?? commandResult?.stdout),
    stderr: boundedProcessOutput(commandError?.stderr ?? commandResult?.stderr),
  };
  const outputCaptured = output.state === "present" && output.bytes > 0;
  const state = !commandError && outputCaptured ? "captured" : "failed";
  return {
    state,
    pid: child.pid,
    outputPath,
    durationSeconds,
    mayDie,
    identityRevalidated: true,
    childExitedBySampleReturn: processHasExited(child),
    command: commandOutput,
    output,
    ...(state === "failed"
      ? {
          reason: commandError
            ? "The macOS sample command failed"
            : `The sample command completed without a valid nonempty output file (${output.state})`,
        }
      : {}),
  };
}

const currentOwnedProcessesExited = async (child, ownership, processQuery) => {
  if (processHasExited(child)) {
    if (!ownership?.groupValidatedAtStart || !ownership?.groupId || process.platform === "win32") return true;
  }
  if (!ownership?.groupValidatedAtStart || !ownership?.groupId || process.platform === "win32") {
    return processHasExited(child);
  }
  try {
    const rows = await readPosixProcessTable(null, ownership.groupId, processQuery);
    return liveRows(rows).every((row) => row.groupId !== ownership.groupId);
  } catch {
    return false;
  }
};

const waitForOwnedProcessesExit = async (
  child,
  ownership,
  timeoutMs,
  onProcessState,
  processQuery,
) => {
  const deadline = Date.now() + timeoutMs;
  if (!child) return true;
  const processExited = await waitForProcessExit(child, Math.max(0, deadline - Date.now()));
  onProcessState?.();
  if (!processExited) return false;
  if (!ownership?.groupValidatedAtStart || !ownership?.groupId || process.platform === "win32") return true;
  while (!(await currentOwnedProcessesExited(child, ownership, processQuery))) {
    onProcessState?.();
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining)));
  }
  onProcessState?.();
  return true;
};

const watchForSafePipeRelease = (child, browser, onSafeExit, timeoutMs) => {
  let timer;
  let interval;
  let settled = false;
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  if (!child) {
    timer = setTimeout(() => {
      settled = true;
      resolvePromise(false);
    }, timeoutMs);
    return {
      promise,
      cancel: () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(false);
      },
    };
  }
  const finish = (safe) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearInterval(interval);
    child.removeListener("exit", check);
    browser.removeListener?.("disconnected", check);
    resolvePromise(safe);
  };
  const check = () => {
    if (processHasExited(child) && browserConnected(browser) === false) {
      onSafeExit();
      finish(true);
    }
  };
  child.once("exit", check);
  browser.once?.("disconnected", check);
  interval = setInterval(check, 20);
  interval.unref?.();
  timer = setTimeout(() => finish(false), timeoutMs);
  check();
  return {
    promise,
    cancel: () => finish(false),
  };
};

const signalOwnedProcess = async (child, ownership, signal, processQuery) => {
  const targets = await inspectOwnedTargets(child, ownership, processQuery);
  if (!targets.direct && !targets.group) {
    const verifiedGroupAbsent =
      !ownership?.groupValidatedAtStart ||
      process.platform === "win32" ||
      (Array.isArray(targets.rows) &&
        !liveRows(targets.rows).some((row) => row.groupId === ownership.groupId));
    if (processHasExited(child) && verifiedGroupAbsent) {
      return { sent: false, target: null, alreadyExited: true };
    }
    return { sent: false, target: null, validationError: targets.reason };
  }
  const target = targets.group && process.platform !== "win32" ? "owned-process-group" : "owned-browser-process";
  try {
    if (target === "owned-process-group") process.kill(-child.pid, signal);
    else if (process.platform === "win32" && signal === "SIGKILL") {
      // Node's Windows child_process.kill() does not implement SIGKILL. Use
      // taskkill only after inspectOwnedTargets has just revalidated the
      // exact test-owned PID, executable, creation time, and unique profile.
      await execFileAsync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      });
      return {
        sent: true,
        target: "owned-browser-process-tree",
        method: "taskkill.exe /PID /T /F",
        identityRevalidated: true,
        validatedPid: child.pid,
        validatedProfile: ownership.profileDirectory,
      };
    } else if (!child.kill(signal)) {
      if (processHasExited(child)) return { sent: false, target, alreadyExited: true };
      return { sent: false, target, validationError: `Node did not accept ${signal} for the verified child PID` };
    }
    return {
      sent: true,
      target,
      identityRevalidated: true,
      validatedPid: child.pid,
      validatedProfile: ownership.profileDirectory,
    };
  } catch (error) {
    if (processHasExited(child)) return { sent: false, target, alreadyExited: true };
    return { sent: false, target, validationError: error?.message || String(error) };
  }
};

const browserConnected = (browser) => {
  try {
    if (typeof browser?.isConnected === "function") return browser.isConnected();
    if (typeof browser?.connected === "boolean") return browser.connected;
  } catch {
    return null;
  }
  return null;
};

const releaseBrowserPipes = (child, report) => {
  if (!child) return false;
  let released = true;
  for (const streamName of ["stdout", "stderr"]) {
    try {
      child[streamName]?.destroy();
    } catch (error) {
      released = false;
      report.errors.push({
        phase: `browser.${streamName}.destroy`,
        ...errorRecord(error),
      });
    }
  }
  return released;
};

const addCleanupError = (report, phase, error, fallbackMessage) => {
  report.errors.push({
    phase,
    ...(error ? errorRecord(error) : { name: "Error", message: fallbackMessage }),
  });
};

const safePageTargetLabel = (page) => {
  try {
    const value = page?.url?.();
    if (!value || value === "about:blank") return value || null;
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return `${url.origin}${url.pathname}`;
    }
    return `${url.protocol}//[redacted]`;
  } catch {
    return null;
  }
};

const closeOwnedBrowserPages = async (
  browser,
  deadlineAt,
  report,
  timings,
  ownedPages,
  prepareOwnedPageClose,
) => {
  const pageCloseReport = {
    state: "not-run",
    source: ownedPages === undefined ? "browser.pages" : "ownedPages",
    attempted: 0,
    closed: 0,
    skipped: 0,
    pages: [],
  };
  const remainingMs = () => Math.max(0, deadlineAt - Date.now());
  let pages;
  if (ownedPages !== undefined) {
    if (!Array.isArray(ownedPages)) {
      pageCloseReport.state = "failed";
      addCleanupError(report, "browser.pages.owned", null, "ownedPages must be an array when provided");
      return pageCloseReport;
    }
    timings.pageListingStartedAt = Date.now();
    pages = [...new Set(ownedPages.filter(Boolean))];
    timings.pageListingSettledAt = Date.now();
  } else {
    if (typeof browser?.pages !== "function") return pageCloseReport;
    timings.pageListingStartedAt = Date.now();
    const listing = await withinDeadline(
      Promise.resolve().then(() => browser.pages()),
      remainingMs(),
      "Puppeteer browser.pages",
    );
    timings.pageListingSettledAt = Date.now();
    if (listing.state !== "fulfilled") {
      pageCloseReport.state = listing.state;
      addCleanupError(
        report,
        "browser.pages.list",
        listing.error,
        "Puppeteer could not list the owned browser pages",
      );
      pageCloseReport.pages.push({ state: listing.state, error: listing.error ? errorRecord(listing.error) : null });
      return pageCloseReport;
    }
    pages = Array.isArray(listing.value) ? listing.value : [];
  }

  const openPages = [];
  for (const [index, page] of pages.entries()) {
    try {
      if (typeof page?.isClosed === "function" && page.isClosed()) {
        pageCloseReport.skipped += 1;
        pageCloseReport.pages.push({ index, state: "already-closed" });
        continue;
      }
    } catch (error) {
      addCleanupError(report, "browser.page.state", error);
      pageCloseReport.pages.push({ index, state: "state-error", error: errorRecord(error) });
    }
    openPages.push({ index, page });
  }

  pageCloseReport.attempted = openPages.length;
  if (openPages.length === 0) {
    pageCloseReport.state = "fulfilled";
    return pageCloseReport;
  }

  const closeResults = await Promise.all(openPages.map(async ({ index, page }) => {
    let preparation = null;
    const prepare = prepareOwnedPageClose || (typeof page.frames === "function" ? teardownViewerPage : null);
    if (typeof prepare === "function") {
      const preparationStartedAt = Date.now();
      const preparationBudgetMs = remainingMs();
      let preparationSettledAt = null;
      let preparationResult;
      if (preparationBudgetMs <= 0) {
        preparationResult = {
          state: "timeout",
          error: new Error(`Puppeteer page ${index} pre-close preparation had no remaining close budget`),
        };
      } else {
        let preparationOutcomePromise;
        try {
          const callbackValue = prepare(page, preparationBudgetMs);
          preparationOutcomePromise = Promise.resolve(callbackValue).then(
            (value) => {
              preparationSettledAt = Date.now();
              return { state: "fulfilled", value };
            },
            (error) => {
              preparationSettledAt = Date.now();
              return { state: "rejected", error };
            },
          );
        } catch (error) {
          preparationSettledAt = Date.now();
          preparationResult = { state: "rejected", error };
        }
        if (preparationOutcomePromise) {
          const waitBudgetMs = remainingMs();
          const boundedPreparation = waitBudgetMs > 0
            ? await withinDeadline(
                preparationOutcomePromise,
                waitBudgetMs,
                `Puppeteer page ${index} pre-close preparation`,
              )
            : {
                state: "timeout",
                error: new Error(`Puppeteer page ${index} pre-close preparation exhausted the close budget`),
              };
          preparationResult = boundedPreparation.state === "fulfilled"
            ? boundedPreparation.value
            : boundedPreparation;
        }
      }
      const valueState = preparationResult.state === "fulfilled"
        ? preparationResult.value?.state
        : null;
      const callbackFailed = preparationResult.state !== "fulfilled" ||
        ["failed", "rejected", "timeout"].includes(valueState);
      const state = preparationResult.state === "fulfilled"
        ? (callbackFailed ? valueState : "fulfilled")
        : preparationResult.state;
      const error = preparationResult.state !== "fulfilled"
        ? preparationResult.error
        : callbackFailed
          ? new Error(
              preparationResult.value?.message ||
              preparationResult.value?.reason ||
              `Pre-close preparation returned ${valueState}`,
            )
          : null;
      preparation = {
        state,
        startedAt: preparationStartedAt,
        settledAt: preparationSettledAt,
        remainingMsAtStart: preparationBudgetMs,
        elapsedMs: preparationSettledAt === null
          ? null
          : Math.max(0, preparationSettledAt - preparationStartedAt),
        result: preparationResult.state === "fulfilled" ? preparationResult.value : null,
        error: error ? errorRecord(error) : null,
      };
      if (callbackFailed) {
        const phase = state === "timeout"
          ? "browser.page.prepare-close.timeout"
          : "browser.page.prepare-close";
        addCleanupError(
          report,
          phase,
          error,
          `Puppeteer page ${index} pre-close preparation did not complete`,
        );
      }
    }

    const startedAt = Date.now();
    let settledAt = null;
    const closePromise = Promise.resolve().then(() => page.close()).then(
      (value) => {
        settledAt = Date.now();
        return value;
      },
      (error) => {
        settledAt = Date.now();
        throw error;
      },
    );
    const result = await withinDeadline(
      closePromise,
      remainingMs(),
      `Puppeteer page ${index} close`,
    );
    return { index, preparation, result, startedAt, settledAt, target: safePageTargetLabel(page) };
  }));
  let failed = false;
  let timedOut = false;
  for (const { index, preparation, result, startedAt, settledAt, target } of closeResults) {
    if (preparation && ["failed", "rejected", "timeout"].includes(preparation.state)) {
      failed = true;
      timedOut ||= preparation.state === "timeout";
    }
    const timing = {
      index,
      target,
      startedAt,
      settledAt,
      elapsedMs: settledAt === null ? null : Math.max(0, settledAt - startedAt),
    };
    if (result.state === "fulfilled") {
      pageCloseReport.closed += 1;
      pageCloseReport.pages.push({ ...timing, state: "fulfilled", preparation });
      continue;
    }
    failed = true;
    timedOut ||= result.state === "timeout";
    const phase = result.state === "timeout" ? "browser.page.close.timeout" : "browser.page.close";
    addCleanupError(
      report,
      phase,
      result.error,
      `Puppeteer page ${index} did not close`,
    );
    pageCloseReport.pages.push({
      ...timing,
      state: result.state,
      preparation,
      error: result.error ? errorRecord(result.error) : null,
    });
  }
  pageCloseReport.state = timedOut ? "timeout" : failed ? "failed" : "fulfilled";
  return pageCloseReport;
};

async function cleanupBrowser({
  browser,
  browserObserver,
  processQuery,
  ownedPages,
  prepareOwnedPageClose,
  onBrowserCloseStart,
  browserTimeoutMs,
  processExitTimeoutMs,
  terminateTimeoutMs,
  killTimeoutMs,
  report,
}) {
  const browserReport = {
    status: "normal",
    closeState: "not-run",
    closeError: null,
    pageClose: { state: "not-run", attempted: 0, closed: 0, skipped: 0, pages: [] },
    process: null,
    connectedAfterClose: null,
    termination: [],
    releasedExitedProcessPipes: false,
    detachedStreamsAfterFailure: false,
  };
  report.browser = browserReport;

  let child = null;
  try {
    child = browser.process?.() || null;
  } catch (error) {
    addCleanupError(report, "browser.process", error);
  }
  let stderrObserver = null;
  if (child) {
    if (browserObserver?.child === child) {
      stderrObserver = browserObserver;
    } else {
      stderrObserver = observeBrowserTestChildStderr(child);
      if (browserObserver) {
        browserObserver.dispose?.();
        addCleanupError(report, "browser.stderr.observer", null, "The stderr observer does not match the owned browser process");
      }
    }
  } else if (browserObserver) {
    browserObserver.dispose?.();
  }
  const ownership = child
    ? await captureOwnership(child, processQuery, getTestBrowserProcessIdentity(browser))
    : null;
  const releasePipesAfterSafeExit = () => {
    if (
      child &&
      !browserReport.releasedExitedProcessPipes &&
      processHasExited(child) &&
      browserConnected(browser) === false
    ) {
      browserReport.releasedExitedProcessPipes = releaseBrowserPipes(child, report);
    }
  };
  browserReport.process = child
    ? {
        pid: child.pid ?? null,
        exitCode: child.exitCode ?? null,
        signalCode: child.signalCode ?? null,
        identity: ownership
          ? {
              pid: ownership.pid ?? null,
              startedAt: ownership.baselineLeader?.startedAt || null,
              identityMode: ownership.identityMode || "process-table",
              parentPid: ownership.baselineLeader?.parentPid ?? null,
              groupId: ownership.baselineLeader?.groupId ?? ownership.groupId ?? null,
              state: ownership.baselineLeader?.state || null,
              executable: child.spawnfile || null,
              executableValidated: Boolean(
                ownership.baselineLeader && matchesExpectedExecutable(ownership.baselineLeader, child),
              ),
              profileDirectory: ownership.profileDirectory || null,
              profileValidated: Boolean(
                ownership.baselineLeader && rowHasProfile(ownership.baselineLeader, ownership),
              ),
              validated: Boolean(ownership.available),
            }
          : null,
        profileIdentityValidatedAtStart: Boolean(ownership?.available),
        processGroupValidatedAtStart: Boolean(ownership?.groupValidatedAtStart),
        processGroupId: ownership?.groupId ?? null,
        processGroupIdentityValidationReason: ownership?.groupValidationReason || null,
        identityValidationReason: ownership?.reason || null,
      }
    : null;

  const closeStartedAt = Date.now();
  const closeDeadlineAt = closeStartedAt + browserTimeoutMs;
  const timings = {
    cleanupStartedAt: closeStartedAt,
    closeDeadlineAt,
    pageListingStartedAt: null,
    pageListingSettledAt: null,
    browserCloseCalledAt: null,
    browserCloseSettledAt: null,
    cdpDisconnectedAt: browserConnected(browser) === false ? closeStartedAt : null,
    processExitAt: null,
  };
  browserReport.timings = timings;
  const onBrowserDisconnected = () => {
    timings.cdpDisconnectedAt ??= Date.now();
  };
  browser.once?.("disconnected", onBrowserDisconnected);
  const pipeReleaseWatcher = watchForSafePipeRelease(
    child,
    browser,
    releasePipesAfterSafeExit,
    browserTimeoutMs,
  );
  browserReport.pageClose = await closeOwnedBrowserPages(
    browser,
    closeDeadlineAt,
    report,
    timings,
    ownedPages,
    prepareOwnedPageClose,
  );

  let closeValue;
  timings.browserCloseCalledAt = Date.now();
  if (typeof onBrowserCloseStart === "function") {
    try {
      onBrowserCloseStart({
        browser,
        child,
        ownership,
        startedAt: timings.browserCloseCalledAt,
        closeDeadlineAt,
        timings,
      });
    } catch (error) {
      browserReport.diagnostics ??= { errors: [] };
      browserReport.diagnostics.errors.push({
        phase: "browser.close.diagnostic-hook",
        ...errorRecord(error),
      });
    }
  }
  try {
    closeValue = browser.close();
  } catch (error) {
    closeValue = Promise.reject(error);
  }
  const closePromise = Promise.resolve(closeValue).then(
    (value) => {
      timings.browserCloseSettledAt = Date.now();
      return value;
    },
    (error) => {
      timings.browserCloseSettledAt = Date.now();
      throw error;
    },
  );
  const closeOutcomePromise = closePromise.then(
    (value) => ({ state: "fulfilled", value }),
    (error) => ({ state: "rejected", error }),
  );
  const closeRace = timings.browserCloseCalledAt >= closeDeadlineAt
    ? { kind: "timeout" }
    : await Promise.race([
        closeOutcomePromise.then((outcome) => ({ kind: "close", outcome })),
        pipeReleaseWatcher.promise.then((released) => ({
          kind: released ? "safe-pipe-release" : "timeout",
        })),
      ]);
  let closeResult;
  if (closeRace.kind === "close") {
    pipeReleaseWatcher.cancel();
    closeResult = closeRace.outcome;
  } else if (closeRace.kind === "safe-pipe-release") {
    const remainingMs = Math.max(0, closeDeadlineAt - Date.now());
    const boundedClose = await withinDeadline(
      closeOutcomePromise,
      remainingMs,
      "Puppeteer browser.close",
    );
    if (boundedClose.state === "fulfilled") {
      closeResult = boundedClose.value;
    } else {
      // Chrome can exit cleanly and disconnect CDP while Puppeteer's close
      // promise remains pending. The owned process exit is the stronger
      // completion signal, but accept it only after identity-aware exit
      // validation and a zero exit code (never after forced termination).
      const processExitedSafely = await waitForOwnedProcessesExit(
        child,
        ownership,
        0,
        releasePipesAfterSafeExit,
        processQuery,
      );
      const cleanNaturalExit = processExitedSafely &&
        browserConnected(browser) === false &&
        child?.signalCode == null &&
        child?.exitCode === 0;
      closeResult = cleanNaturalExit
        ? {
            state: "process-exited",
            error: null,
            diagnostic: {
              puppeteerCloseState: boundedClose.state,
              reason: "owned browser exited with code 0 and CDP disconnected",
            },
          }
        : boundedClose;
      if (cleanNaturalExit) browserReport.closeCompletion = "verified-process-exit";
    }
  } else {
    pipeReleaseWatcher.cancel();
    closeResult = {
      state: "timeout",
      error: new Error(`Puppeteer browser.close exceeded ${browserTimeoutMs} ms`),
    };
  }
  browserReport.closeState = closeResult.state;
  browserReport.closeError = closeResult.error ? errorRecord(closeResult.error) : null;

  const needsDisconnect = browserConnected(browser) !== false;
  if (needsDisconnect) {
    try {
      await withinDeadline(
        Promise.resolve().then(() => browser.disconnect()),
        1_000,
        "Puppeteer browser.disconnect",
      ).then((result) => {
        browserReport.disconnectState = result.state;
        if (result.state !== "fulfilled") {
          addCleanupError(report, "browser.disconnect", result.error, "Puppeteer disconnect did not complete");
        }
      });
    } catch (error) {
      addCleanupError(report, "browser.disconnect", error);
    }
  }

  releasePipesAfterSafeExit();
  let exitedNaturally = await waitForOwnedProcessesExit(
    child,
    ownership,
    processExitTimeoutMs,
    releasePipesAfterSafeExit,
    processQuery,
  );
  let terminationNeeded = Boolean(child && !exitedNaturally);
  if (terminationNeeded) {
    if (!ownership?.available) {
      browserReport.status = "failed";
      addCleanupError(
        report,
        "browser.identity",
        null,
        ownership?.reason || "Could not verify the test-owned browser identity; refusing to signal a process",
      );
    } else {
      const termResult = await signalOwnedProcess(child, ownership, "SIGTERM", processQuery);
      browserReport.termination.push({ signal: "SIGTERM", ...termResult });
      if (termResult.validationError) {
        browserReport.status = "failed";
        addCleanupError(report, "browser.signal.SIGTERM", null, termResult.validationError);
      } else if (termResult.sent) {
        browserReport.status = "forced";
        const termExited = await waitForOwnedProcessesExit(
          child,
          ownership,
          terminateTimeoutMs,
          releasePipesAfterSafeExit,
          processQuery,
        );
        if (!termExited) {
          const killResult = await signalOwnedProcess(child, ownership, "SIGKILL", processQuery);
          browserReport.termination.push({ signal: "SIGKILL", ...killResult });
          if (killResult.validationError) {
            browserReport.status = "failed";
            addCleanupError(report, "browser.signal.SIGKILL", null, killResult.validationError);
          } else if (killResult.sent) {
            const killExited = await waitForOwnedProcessesExit(
              child,
              ownership,
              killTimeoutMs,
              releasePipesAfterSafeExit,
              processQuery,
            );
            if (!killExited) {
              browserReport.status = "failed";
              addCleanupError(
                report,
                "browser.process.exit",
                null,
                `Verified browser process ${child.pid} remained alive after SIGKILL and ${killTimeoutMs} ms`,
              );
            }
          } else if (!killResult.alreadyExited) {
            browserReport.status = "failed";
            addCleanupError(report, "browser.signal.SIGKILL", null, "SIGKILL was not sent to a revalidated process");
          }
        }
      } else if (!termResult.alreadyExited) {
        browserReport.status = "failed";
        addCleanupError(report, "browser.signal.SIGTERM", null, "SIGTERM was not sent to a revalidated process");
      }
    }
  }

  exitedNaturally = await waitForOwnedProcessesExit(
    child,
    ownership,
    0,
    releasePipesAfterSafeExit,
    processQuery,
  );
  browserReport.connectedAfterClose = browserConnected(browser);
  browserReport.process = child
    ? {
        pid: child.pid ?? null,
        exitCode: child.exitCode ?? null,
        signalCode: child.signalCode ?? null,
        identity: ownership
          ? {
              pid: ownership.pid ?? null,
              startedAt: ownership.baselineLeader?.startedAt || null,
              identityMode: ownership.identityMode || "process-table",
              parentPid: ownership.baselineLeader?.parentPid ?? null,
              groupId: ownership.baselineLeader?.groupId ?? ownership.groupId ?? null,
              state: ownership.baselineLeader?.state || null,
              executable: child.spawnfile || null,
              executableValidated: Boolean(
                ownership.baselineLeader && matchesExpectedExecutable(ownership.baselineLeader, child),
              ),
              profileDirectory: ownership.profileDirectory || null,
              profileValidated: Boolean(
                ownership.baselineLeader && rowHasProfile(ownership.baselineLeader, ownership),
              ),
              validated: Boolean(ownership.available),
            }
          : null,
        profileIdentityValidatedAtStart: Boolean(ownership?.available),
        processGroupValidatedAtStart: Boolean(ownership?.groupValidatedAtStart),
        processGroupId: ownership?.groupId ?? null,
      }
    : null;

  // A browser.close promise can remain pending after its configured close
  // deadline even though CDP disconnected and the owned Chrome process then
  // exits cleanly during the existing processExitTimeoutMs grace period.
  // Treat that verified natural exit as completion; do not report a false
  // close failure merely because process teardown crossed the earlier
  // browser.close deadline. The process-exit budget is not extended here.
  const cleanDelayedBrowserExit = closeResult.state === "timeout" &&
    child &&
    exitedNaturally &&
    browserReport.connectedAfterClose === false &&
    child.signalCode == null &&
    child.exitCode === 0 &&
    !browserReport.termination.some((entry) => entry.sent);
  if (cleanDelayedBrowserExit) {
    browserReport.closeState = "process-exited";
    browserReport.closeError = null;
    browserReport.closeCompletion = "verified-process-exit";
  } else if (
    closeResult.state !== "fulfilled" && closeResult.state !== "process-exited"
  ) {
    addCleanupError(
      report,
      "browser.close",
      closeResult.error,
      `Puppeteer browser.close did not complete within ${browserTimeoutMs} ms`,
    );
  }

  if (browserReport.connectedAfterClose !== false) {
    browserReport.status = "failed";
    addCleanupError(
      report,
      "browser.disconnect",
      null,
      `Puppeteer browser remained connected after cleanup (${String(browserReport.connectedAfterClose)})`,
    );
  }
  if (child && !exitedNaturally) {
    browserReport.status = "failed";
    if (!report.errors.some((entry) => entry.phase === "browser.process.exit")) {
      addCleanupError(
        report,
        "browser.process.exit",
        null,
        processHasExited(child) && ownership?.groupId
          ? `Owned browser process group ${ownership.groupId} still has live or unverifiable members`
          : `Owned browser process ${child.pid} did not exit`,
      );
    }
  }

  const helperSentSignal = browserReport.termination.some((entry) => entry.sent);
  if (child && exitedNaturally && !helperSentSignal) {
    if (child.signalCode !== null && child.signalCode !== undefined) {
      browserReport.status = "failed";
      addCleanupError(
        report,
        "browser.process.exit",
        null,
        `Browser child ${child.pid} exited from signal ${child.signalCode}`,
      );
    } else if (child.exitCode !== 0) {
      browserReport.status = "failed";
      addCleanupError(
        report,
        "browser.process.exit",
        null,
        `Browser child ${child.pid} exited with code ${String(child.exitCode)} instead of 0`,
      );
    }
  }

  if (child && processHasExited(child) && browserReport.connectedAfterClose === false) {
    releasePipesAfterSafeExit();
  } else if (child && !exitedNaturally) {
    // Keep the streams intact while the browser process or CDP connection is
    // still live. Only unref this failed child so its handles cannot hold the
    // test runner open after the bounded cleanup report is written.
    child.stdout?.unref?.();
    child.stderr?.unref?.();
    child.unref?.();
    browserReport.detachedStreamsAfterFailure = true;
  }

  if (!new Set(["fulfilled", "process-exited"]).has(browserReport.closeState) && browserReport.status === "normal") {
    browserReport.status = "failed";
  }
  if (
    report.errors.some((entry) => entry.phase.startsWith("browser.") && entry.phase !== "browser.forced-cleanup") &&
    browserReport.status === "forced"
  ) {
    // Preserve the forced termination details while indicating that another
    // part of cleanup also failed.
    browserReport.additionalFailure = true;
  }
  if (
    report.errors.some((entry) => entry.phase.startsWith("browser.") && entry.phase !== "browser.forced-cleanup") &&
    browserReport.status === "normal"
  ) {
    browserReport.status = "failed";
  }

  if (browserReport.status === "forced") {
    addCleanupError(
      report,
      "browser.forced-cleanup",
      null,
      "The test browser required an external signal to exit; forced cleanup is not a natural test pass",
    );
  }
  const stderrSnapshot = stderrObserver?.snapshot();
  if (stderrSnapshot?.capturedBytes > 0 && browserReport.status !== "normal") {
    browserReport.stderr = stderrSnapshot;
  }
  stderrObserver?.dispose();
  timings.cdpDisconnectedAt ??= browserReport.connectedAfterClose === false ? Date.now() : null;
  timings.processExitAt = stderrSnapshot?.childExitAt ?? (processHasExited(child) ? Date.now() : null);
  browser.removeListener?.("disconnected", onBrowserDisconnected);
}

/**
 * Close a Puppeteer browser launched by the test, bound every wait, and only
 * signal it after revalidating the test's unique temporary profile and PID
 * start identity. POSIX process groups are signaled only when every live
 * member still carries that same temporary profile identity.
 */
export async function cleanupBrowserTestResources({
  browser,
  browserObserver,
  processQuery = execFileAsync,
  ownedPages,
  prepareOwnedPageClose,
  onBrowserCloseStart,
  server,
  browserTimeoutMs = 20_000,
  processExitTimeoutMs = 10_000,
  terminateTimeoutMs = 2_000,
  killTimeoutMs = 2_000,
  serverTimeoutMs = 5_000,
} = {}) {
  const report = {
    status: "normal",
    browser: null,
    server: null,
    errors: [],
  };

  if (browser) {
    try {
      await cleanupBrowser({
        browser,
        browserObserver,
        processQuery,
        ownedPages,
        prepareOwnedPageClose,
        onBrowserCloseStart,
        browserTimeoutMs,
        processExitTimeoutMs,
        terminateTimeoutMs,
        killTimeoutMs,
        report,
      });
    } catch (error) {
      report.browser ??= { status: "failed" };
      report.browser.status = "failed";
      addCleanupError(report, "browser.cleanup", error);
    }
  }

  if (server) {
    const closeResult = await withinDeadline(
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections?.();
      }),
      serverTimeoutMs,
      "HTTP test server close",
    );
    report.server = { closeState: closeResult.state };
    if (closeResult.state !== "fulfilled") {
      report.server.closeError = closeResult.error ? errorRecord(closeResult.error) : null;
      addCleanupError(
        report,
        "server.close",
        closeResult.error,
        `HTTP test server did not close within ${serverTimeoutMs} ms`,
      );
    }
  }

  if (
    report.errors.some((entry) => entry.phase.startsWith("server.")) ||
    report.browser?.status === "failed" ||
    (report.errors.length > 0 && report.browser?.status === "normal")
  ) {
    report.status = "failed";
  } else if (report.browser?.status === "forced") {
    report.status = "forced";
  }

  if (browser) {
    const launchMetadata = getTestBrowserLaunchMetadata(browser);
    if (launchMetadata) {
      let finalizedMetadata = launchMetadata;
      try {
        finalizedMetadata = await finalizeTestBrowserLaunch(browser, report) || launchMetadata;
      } catch (error) {
        addCleanupError(report, "browser.launch-record", error);
      }
      report.browser ??= { status: "failed" };
      report.browser.testBrowserLaunch = finalizedMetadata;
      if (finalizedMetadata.state === "record-write-failed" || finalizedMetadata.recordErrors?.length) {
        const errors = finalizedMetadata.recordErrors?.length
          ? finalizedMetadata.recordErrors
          : [{ message: "Test browser launch record could not be finalized" }];
        for (const error of errors) {
          addCleanupError(
            report,
            "browser.launch-record",
            null,
            `${error.stage || "launch record"}: ${error.message || "record write failed"}`,
          );
        }
      }
      if (
        report.errors.some((entry) => entry.phase === "browser.launch-record") ||
        finalizedMetadata.state === "record-write-failed"
      ) {
        report.browser.status = "failed";
        report.status = "failed";
      }
    }
  }
  return report;
}

export function attachCleanupErrors(primaryError, report) {
  if (!report?.errors?.length) return primaryError;
  const entries = report.errors;
  if (primaryError) {
    const error = primaryError instanceof Error
      ? primaryError
      : new Error(String(primaryError), { cause: primaryError });
    const oldMessage = error.message || String(error);
    const details = entries.map((entry) => `${entry.phase}: ${entry.message}`).join("; ");
    error.cleanupErrors = [...(error.cleanupErrors || []), ...entries];
    error.cleanupReport = report;
    error.cleanupError = new AggregateError(
      entries.map((entry) => Object.assign(new Error(entry.message), entry)),
      "Browser test cleanup failed",
    );
    error.message = `${oldMessage}\nBrowser test cleanup issues: ${details}`;
    if (typeof error.stack === "string") error.stack = error.stack.replace(oldMessage, error.message);
    return error;
  }
  const cleanupError = new AggregateError(
    entries.map((entry) => Object.assign(new Error(entry.message), entry)),
    "Browser test cleanup failed",
  );
  cleanupError.cleanupReport = report;
  return cleanupError;
}
