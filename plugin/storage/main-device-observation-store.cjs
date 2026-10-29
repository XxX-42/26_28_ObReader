/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";
const { createStorageIo } = require("./io.cjs");
const { canonicalJson } = require("./canonical.cjs");
const { observeDevice, isRetirementCandidate } = require("./main-snapshot-device-observation.cjs");

// An observer owns its own file. Observations only nominate candidates: they
// cannot retire a device or authorize deletion without the consensus protocol.
function createMainDeviceObservationStore({ adapter, root, hash, identityHash, verifyHash, deviceId, token, clock = Date.now }) {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(deviceId || "") || typeof identityHash !== "function") {
    throw new TypeError("A safe observer device identity and SHA-256 are required.");
  }
  const io = createStorageIo({ adapter, hash, verifyHash, token });
  const path = `${root}/main-device-observations/${deviceId}.json`;
  const presencePath = (id) => `${root}/main-device-presence/${id}.json`;
  const validatePresence = (id) => (value) => {
    if (!value || value.schemaVersion !== 1 || value.kind !== "pdf-reader-device-presence" ||
        value.deviceId !== id || typeof value.activityId !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(value.activityId)) {
      throw new Error("MAIN_DEVICE_PRESENCE_INVALID");
    }
  };
  const validate = (value) => {
    if (!value || value.schemaVersion !== 1 || value.kind !== "pdf-reader-device-observations" ||
        value.observer !== deviceId || !Array.isArray(value.entries)) throw new Error("MAIN_DEVICE_OBSERVATION_INVALID");
    const seen = new Set();
    for (const entry of value.entries) {
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(entry.deviceId || "") || seen.has(entry.deviceId)) throw new Error("MAIN_DEVICE_OBSERVATION_INVALID");
      seen.add(entry.deviceId);
      observeDevice(entry.observation, { digest: entry.observation.digest, now: entry.observation.lastObservedAt });
    }
  };
  async function read() {
    return await io.readJson(path, { validate }) || { schemaVersion: 1, kind: "pdf-reader-device-observations", observer: deviceId, entries: [] };
  }
  async function publishPresence() {
    const value = { schemaVersion: 1, kind: "pdf-reader-device-presence", deviceId, activityId: String(token()) };
    const previous = await io.readJson(presencePath(deviceId), { validate: validatePresence(deviceId) });
    if (previous?.activityId === value.activityId) {
      throw Object.assign(new Error("A new device activity must have a unique identity."), { code: "MAIN_DEVICE_PRESENCE_ID_COLLISION" });
    }
    return io.writeJsonAtomic(presencePath(deviceId), value, { validate: validatePresence(deviceId) });
  }
  async function knownDevices() {
    const directory = `${root}/main-device-presence`;
    if (!(await adapter.exists(directory))) return [];
    const listing = await adapter.list(directory);
    const ids = new Set();
    for (const file of listing.files) {
      const leaf = file.slice(file.lastIndexOf("/") + 1);
      const match = /^([A-Za-z0-9_-]{1,256})\.json(?:\.pending)?$/.exec(leaf);
      if (!match) throw Object.assign(new Error("Unrecognized device presence file."), { code: "MAIN_DEVICE_PRESENCE_INVALID" });
      if (leaf.endsWith(".json.pending")) throw Object.assign(new Error("A device presence update is incomplete."), { code: "MAIN_DEVICE_PRESENCE_PENDING" });
      ids.add(match[1]);
    }
    for (const id of ids) {
      if (!(await io.readJson(presencePath(id), { validate: validatePresence(id) }))) {
        throw Object.assign(new Error("Device presence changed during discovery."), { code: "MAIN_DEVICE_PRESENCE_MISSING" });
      }
      if (await adapter.exists(`${presencePath(id)}.pending`)) {
        throw Object.assign(new Error("A device presence update is incomplete."), { code: "MAIN_DEVICE_PRESENCE_PENDING" });
      }
    }
    return [...ids].sort();
  }
  async function observe({ deviceId: observed }) {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(observed || "") || observed === deviceId) {
      throw new TypeError("A safe identity for another device is required.");
    }
    const ensureSettled = async () => {
      if (await adapter.exists(`${presencePath(observed)}.pending`)) {
        throw Object.assign(new Error("A device presence update is incomplete."), { code: "MAIN_DEVICE_PRESENCE_PENDING" });
      }
    };
    await ensureSettled();
    const presence = await io.readJson(presencePath(observed), { validate: validatePresence(observed) });
    await ensureSettled();
    if (!presence) throw Object.assign(new Error("Device presence is unavailable."), { code: "MAIN_DEVICE_PRESENCE_MISSING" });
    const digest = await identityHash(new TextEncoder().encode(canonicalJson(presence)));
    const now = clock();
    const current = await read();
    const entries = current.entries.filter((entry) => entry.deviceId !== observed);
    const prior = current.entries.find((entry) => entry.deviceId === observed);
    const observation = observeDevice(prior?.observation, { digest, now });
    entries.push({ deviceId: observed, observation });
    entries.sort((a, b) => a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0);
    const next = { ...current, entries };
    await io.writeJsonAtomic(path, next, { validate });
    if (!isRetirementCandidate(observation, now)) return { observation, retirementCandidate: false };
    // Re-read after the observation is durable: the device may have become
    // active while the observer was publishing its record. This is still an
    // observation, not a distributed lock or an authorization to retire.
    const latest = await io.readJson(presencePath(observed), { validate: validatePresence(observed) });
    await ensureSettled();
    if (!latest) throw Object.assign(new Error("Device presence disappeared."), { code: "MAIN_DEVICE_PRESENCE_MISSING" });
    const latestDigest = await identityHash(new TextEncoder().encode(canonicalJson(latest)));
    return { observation, retirementCandidate: latestDigest === digest,
      ...(latestDigest === digest ? {} : { reason: "presence-changed" }) };
  }
  return Object.freeze({ path, presencePath, read, observe, publishPresence, knownDevices });
}
module.exports = { createMainDeviceObservationStore };
