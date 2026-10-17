const LOGICAL_LIGATURES = Object.freeze({
  "\uFB00": "ff",
  "\uFB01": "fi",
  "\uFB02": "fl",
  "\uFB03": "ffi",
  "\uFB04": "ffl",
});

const COMMON_APOSTROPHES = /[\u2018\u2019\u02BC\uFF07]/gu;
const LIGATURES = /[\uFB00-\uFB04]/gu;
const ALLOWED_WORD = /^[\p{Script=Latin}\p{Script_Extensions=Latin}\p{M}0-9]+(?:['./…-][\p{Script=Latin}\p{Script_Extensions=Latin}\p{M}0-9]+)*(?:\.|…)?$/u;

/**
 * Return a stable lookup key for an English surface form.
 *
 * This deliberately does not stem, lemmatize, remove accents, or otherwise
 * guess that two different printed forms are the same word. It only applies
 * canonical Unicode composition, a small set of typographic ligature and
 * apostrophe mappings, and lowercase conversion.
 */
export function normalizeTermKey(surface) {
  if (typeof surface !== "string") return "";

  const normalized = surface
    .normalize("NFC")
    .replace(LIGATURES, (ligature) => LOGICAL_LIGATURES[ligature])
    .replace(COMMON_APOSTROPHES, "'")
    .replace(/\(([\p{Script=Latin}\p{Script_Extensions=Latin}\p{M}0-9]+)\)/gu, "$1")
    .replace(/-\s+/gu, " ")
    .replace(/\.{3,}/gu, "…")
    .toLowerCase()
    .normalize("NFC")
    .replace(/\s+/gu, " ")
    .trim();

  if (!normalized) return "";
  const words = normalized.split(" ");
  if (words.some((word) => word.length > 128 || !ALLOWED_WORD.test(word))) return "";
  if (normalized.length > 1600) return "";
  if (!words.some((word) => [...word].some((character) => /\p{Script=Latin}/u.test(character)))) return "";
  return normalized;
}

// Retain the descriptive alias for callers that already use the viewer-side
// name while making the shared host/viewer term-key contract explicit.
export const normalizeEnglishSurfaceKey = normalizeTermKey;
