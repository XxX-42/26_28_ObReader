import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

function isLoopback(hostname) {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname);
}

function localUrl(value) {
  const parsed = new URL(value);
  assert.ok(
    ["http:", "https:", "ws:", "wss:"].includes(parsed.protocol),
    "PDF_READER_CDP_URL must be a local HTTP or WebSocket URL",
  );
  assert.ok(
    isLoopback(parsed.hostname),
    "PDF_READER_CDP_URL must point to a loopback address",
  );
  return parsed;
}

function createConnection(url, timeoutMs) {
  assert.equal(
    typeof globalThis.WebSocket,
    "function",
    "Direct isolated CDP needs Node.js with the built-in WebSocket API",
  );
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  let opened = false;

  const openPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out connecting to isolated Obsidian CDP")), timeoutMs);
    socket.addEventListener("open", () => {
      opened = true;
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Could not connect to the configured isolated Obsidian CDP endpoint"));
    }, { once: true });
  });

  socket.addEventListener("message", async (event) => {
    let text;
    if (typeof event.data === "string") {
      text = event.data;
    } else if (event.data instanceof ArrayBuffer) {
      text = new TextDecoder().decode(event.data);
    } else if (typeof event.data?.text === "function") {
      text = await event.data.text();
    } else {
      return;
    }
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.id == null) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) {
      waiter.reject(new Error(`CDP ${waiter.method} failed: ${JSON.stringify(message.error)}`));
    } else {
      waiter.resolve(message);
    }
  });

  socket.addEventListener("close", () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Isolated Obsidian CDP connection closed"));
    }
    pending.clear();
  });

  return {
    async ready() {
      await openPromise;
      return this;
    },
    send(command, params = {}, sessionId) {
      assert.ok(opened, "CDP connection is not open");
      const id = nextId++;
      const message = { id, method: command, params };
      if (sessionId) message.sessionId = sessionId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for CDP ${command}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer, method: command });
        socket.send(JSON.stringify(message));
      });
    },
    close() {
      socket.close();
    },
  };
}

async function targetList(endpoint, timeoutMs) {
  const listUrl = new URL("/json/list", endpoint);
  const response = await fetch(listUrl, { signal: AbortSignal.timeout(timeoutMs) });
  assert.ok(response.ok, `Local CDP target listing returned HTTP ${response.status}`);
  const targets = await response.json();
  assert.ok(Array.isArray(targets), "Local CDP target listing was not an array");
  return targets;
}

async function connectCandidates(endpoint, timeoutMs) {
  if (["http:", "https:"].includes(endpoint.protocol)) {
    const targets = await targetList(endpoint, timeoutMs);
    const candidates = [];
    for (const target of targets) {
      if (target.type !== "page" || target.url !== "app://obsidian.md/index.html") {
        continue;
      }
      const socketUrl = localUrl(target.webSocketDebuggerUrl);
      const connection = await createConnection(socketUrl.href, timeoutMs).ready();
      candidates.push({ connection, title: target.title || "", sessionId: null });
    }
    return candidates;
  }

  if (endpoint.pathname.includes("/devtools/page/")) {
    const connection = await createConnection(endpoint.href, timeoutMs).ready();
    return [{ connection, title: "explicit renderer endpoint", sessionId: null }];
  }

  if (endpoint.pathname.includes("/devtools/browser/")) {
    const connection = await createConnection(endpoint.href, timeoutMs).ready();
    const response = await connection.send("Target.getTargets");
    const targets = response.result?.targetInfos || [];
    const candidates = [];
    for (const target of targets) {
      if (target.type !== "page" || target.url !== "app://obsidian.md/index.html") {
        continue;
      }
      const attached = await connection.send("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true,
      });
      if (attached.result?.sessionId) {
        candidates.push({
          connection,
          title: target.title || "",
          sessionId: attached.result.sessionId,
        });
      }
    }
    return candidates;
  }

  throw new Error(
    "PDF_READER_CDP_URL must be a local Obsidian CDP HTTP port or a renderer/browser WebSocket URL",
  );
}

async function identityFor(candidate) {
  const response = await candidate.connection.send(
    "Runtime.evaluate",
    {
      expression: "JSON.stringify({ vault: window.app?.vault?.adapter?.basePath || null, configDir: window.app?.vault?.configDir || null })",
      awaitPromise: false,
      returnByValue: true,
    },
    candidate.sessionId,
  );
  if (response.result?.result?.exceptionDetails) return null;
  const value = response.result?.result?.value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function connectToIsolatedObsidian({
  cdpUrl,
  expectedVault,
  expectedConfigDir,
  vaultSelector,
  timeoutMs = 20_000,
}) {
  const endpoint = localUrl(cdpUrl);
  const candidates = await connectCandidates(endpoint, timeoutMs);
  const matched = [];
  for (const candidate of candidates) {
    const identity = await identityFor(candidate);
    if (
      identity?.vault === expectedVault &&
      identity?.configDir === expectedConfigDir
    ) {
      matched.push(candidate);
    }
  }

  if (matched.length !== 1) {
    for (const connection of new Set(candidates.map((candidate) => candidate.connection))) {
      connection.close();
    }
    throw new Error(
      `Expected exactly one Obsidian renderer for vault ${expectedVault} (${vaultSelector}); found ${matched.length}. No requested CDP command was sent.`,
    );
  }

  const selected = matched[0];
  for (const connection of new Set(candidates.map((candidate) => candidate.connection))) {
    if (connection !== selected.connection) connection.close();
  }

  async function verifyIdentity() {
    const identity = await identityFor(selected);
    assert.deepEqual(
      identity,
      { vault: expectedVault, configDir: expectedConfigDir },
      `CDP renderer identity changed; expected only ${expectedVault} (${expectedConfigDir})`,
    );
    return identity;
  }

  return {
    verifyIdentity,
    send(method, params = {}) {
      return selected.connection.send(method, params, selected.sessionId);
    },
    close() {
      selected.connection.close();
    },
  };
}

async function main() {
  const [
    cdpUrl,
    expectedVault,
    expectedConfigDir,
    vaultSelector,
    method,
    rawParams,
    rawTimeout,
  ] = process.argv.slice(2);
  const client = await connectToIsolatedObsidian({
    cdpUrl,
    expectedVault,
    expectedConfigDir,
    vaultSelector,
    timeoutMs: Number(rawTimeout),
  });
  try {
    await client.verifyIdentity();
    const response = await client.send(method, JSON.parse(rawParams));
    process.stdout.write(`${JSON.stringify(response.result ?? response)}\n`);
  } finally {
    client.close();
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
