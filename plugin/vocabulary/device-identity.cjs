"use strict";

// This is installation metadata, not a synchronized vocabulary record. A
// process-random fallback would strand acknowledged review journals after a
// restart, so inability to persist the device identity disables mutation.
const DEVICE_ID_KEY = "pdf-web-reader.vocabulary-device-id.v1";
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

function localVocabularyDeviceId({ storage = globalThis.localStorage, crypto = globalThis.crypto } = {}) {
  const failure = (message, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), {
    code: "vocabulary-device-identity-unavailable",
  });
  if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
    throw failure("无法可靠保存本设备身份，词汇写入已暂停；已有记录仍可读取。");
  }
  try {
    const saved = storage.getItem(DEVICE_ID_KEY);
    if (saved !== null && saved !== undefined) {
      if (!DEVICE_ID_PATTERN.test(saved)) throw failure("本设备词汇身份无效，请保留本地恢复记录。");
      return saved;
    }
    if (typeof crypto?.randomUUID !== "function") throw failure("缺少安全的设备身份生成能力。");
    const created = crypto.randomUUID();
    if (!DEVICE_ID_PATTERN.test(created)) throw failure("生成的设备身份无效。");
    storage.setItem(DEVICE_ID_KEY, created);
    if (storage.getItem(DEVICE_ID_KEY) !== created) throw failure("本设备词汇身份写后校验失败。");
    return created;
  } catch (error) {
    if (error?.code === "vocabulary-device-identity-unavailable") throw error;
    throw failure("无法可靠保存本设备身份，词汇写入已暂停；已有记录仍可读取。", error);
  }
}

module.exports = { DEVICE_ID_KEY, localVocabularyDeviceId };
