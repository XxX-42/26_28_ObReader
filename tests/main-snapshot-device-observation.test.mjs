import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const { RETIRE_AFTER_MS, observeDevice, isRetirementCandidate } = require("../plugin/storage/main-snapshot-device-observation.cjs");
const { createMainDeviceObservationStore } = require("../plugin/storage/main-device-observation-store.cjs");
const digest = `sha256-v1:${"a".repeat(64)}`;
const nextDigest = `sha256-v1:${"b".repeat(64)}`;

test("unchanged reobservations retain the original time and reach seven-day eligibility", () => {
  let state = observeDevice(null, { digest, now: 100 });
  state = observeDevice(state, { digest, now: 200 });
  assert.equal(state.firstObservedAt, 100);
  assert.equal(isRetirementCandidate(state, 100 + RETIRE_AFTER_MS - 1), false);
  assert.equal(isRetirementCandidate(state, 100 + RETIRE_AFTER_MS), false,
    "an old observation cannot authorize retirement without rereading current device presence");
  state = observeDevice(state, { digest, now: 100 + RETIRE_AFTER_MS });
  assert.equal(isRetirementCandidate(state, 100 + RETIRE_AFTER_MS), true);
});

test("new activity restarts observation and clock rollback never retires a device", () => {
  let state = observeDevice(null, { digest, now: 100 });
  state = observeDevice(state, { digest: nextDigest, now: 200 });
  assert.equal(state.firstObservedAt, 200);
  state = observeDevice(state, { digest: nextDigest, now: 150 });
  assert.equal(state.clockUncertain, true);
  assert.equal(isRetirementCandidate(state, 200 + RETIRE_AFTER_MS), false);
  state = observeDevice(state, { digest: nextDigest, now: 200 + RETIRE_AFTER_MS });
  assert.equal(isRetirementCandidate(state, 200 + RETIRE_AFTER_MS), false,
    "a recovered clock must start a fresh observation period rather than credit an uncertain interval");
  state = observeDevice(state, { digest: nextDigest, now: 200 + 2 * RETIRE_AFTER_MS });
  assert.equal(isRetirementCandidate(state, 200 + 2 * RETIRE_AFTER_MS), true);
  assert.throws(() => observeDevice(null, { digest: "bad", now: 0 }), TypeError);
});

test("malformed observation times or digest cannot nominate a device", () => {
  const now = RETIRE_AFTER_MS;
  assert.equal(isRetirementCandidate({ digest, firstObservedAt: -1, lastObservedAt: now, clockUncertain: false }, now), false);
  assert.equal(isRetirementCandidate({ digest: "invalid", firstObservedAt: 0, lastObservedAt: now, clockUncertain: false }, now), false);
});

test("vault-wide presence observations persist across restart and missing or corrupt presence cannot retire a device", async () => {
  const files = new Map(), directories = new Set();
  const adapter = {
    async exists(path) { return files.has(path) || directories.has(path); },
    async mkdir(path) { directories.add(path); },
    async read(path) { if (!files.has(path)) throw new Error("missing"); return files.get(path); },
    async write(path, text) { files.set(path, text); },
    async rename(from, to) { files.set(to, files.get(from)); files.delete(from); },
    async remove(path) { files.delete(path); },
    async list(path) {
      const prefix = `${path}/`;
      return { files: [...files.keys()].filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/")), folders: [] };
    },
  };
  const sha = (bytes) => `sha256-v1:${createHash("sha256").update(bytes).digest("hex")}`;
  let now = 100, seq = 0;
  const make = (deviceId) => createMainDeviceObservationStore({ adapter, root: "data", hash: sha,
    identityHash: sha, deviceId, token: () => `token-${++seq}`, clock: () => now });
  const a = make("windows-A"), b = make("ipad-B");
  await assert.rejects(a.observe({ deviceId: "ipad-B" }), { code: "MAIN_DEVICE_PRESENCE_MISSING" });
  await b.publishPresence();
  assert.equal((await a.observe({ deviceId: "ipad-B" })).retirementCandidate, false);
  now += RETIRE_AFTER_MS;
  const restarted = make("windows-A");
  assert.equal((await restarted.observe({ deviceId: "ipad-B" })).retirementCandidate, true);
  files.set(`${b.presencePath("ipad-B")}.pending`, "{incoming device activity");
  await assert.rejects(restarted.observe({ deviceId: "ipad-B" }), { code: "MAIN_DEVICE_PRESENCE_PENDING" });
  await assert.rejects(restarted.knownDevices(), { code: "MAIN_DEVICE_PRESENCE_PENDING" });
  files.delete(`${b.presencePath("ipad-B")}.pending`);
  const originalRead = adapter.read;
  let injectedDuringList = false;
  adapter.read = async (path) => {
    const value = await originalRead(path);
    if (!injectedDuringList && path === b.presencePath("ipad-B")) {
      injectedDuringList = true;
      files.set(`${path}.pending`, "{arrived after listing");
    }
    return value;
  };
  await assert.rejects(restarted.knownDevices(), { code: "MAIN_DEVICE_PRESENCE_PENDING" });
  assert.equal(injectedDuringList, true);
  adapter.read = originalRead;
  files.delete(`${b.presencePath("ipad-B")}.pending`);
  const originalWrite = adapter.write;
  let injected = false;
  adapter.write = async (path, text) => {
    await originalWrite(path, text);
    if (!injected && path === `${restarted.path}.pending`) {
      injected = true;
      files.set(`${b.presencePath("ipad-B")}.pending`, "{activity arrived during observation");
    }
  };
  await assert.rejects(restarted.observe({ deviceId: "ipad-B" }), { code: "MAIN_DEVICE_PRESENCE_PENDING" });
  assert.equal(injected, true);
  assert.equal(files.get(`${b.presencePath("ipad-B")}.pending`), "{activity arrived during observation");
  adapter.write = originalWrite;
  files.delete(`${b.presencePath("ipad-B")}.pending`);
  now -= 1000;
  assert.equal((await restarted.observe({ deviceId: "ipad-B" })).retirementCandidate, false);
  now += RETIRE_AFTER_MS + 1000;
  const afterClockRecovery = make("windows-A");
  assert.equal((await afterClockRecovery.observe({ deviceId: "ipad-B" })).retirementCandidate, false,
    "clock uncertainty survives restart and requires a new full observation period");
  await b.publishPresence();
  assert.equal((await afterClockRecovery.observe({ deviceId: "ipad-B" })).retirementCandidate, false);
  files.set(b.presencePath("ipad-B"), "{corrupt");
  await assert.rejects(restarted.observe({ deviceId: "ipad-B" }));
  assert.equal((await restarted.read()).entries[0].observation.firstObservedAt, now);
});
