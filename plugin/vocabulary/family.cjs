"use strict";

const FAMILY_VERSION = 1;

/**
 * Build the persisted family identity from the vocabulary service's existing
 * surface and English-match functions. Keeping the matcher injected avoids a
 * service/family import cycle and makes the resolver a pure data helper.
 */
function createFamilyResolver({
  normalizeTermKey,
  normalizeEnglishMatchKey,
  isAmbiguousEnglishSurface,
  isLayVerbInflectionSurface,
} = {}) {
  for (const [name, fn] of Object.entries({
    normalizeTermKey,
    normalizeEnglishMatchKey,
    isAmbiguousEnglishSurface,
    isLayVerbInflectionSurface,
  })) {
    if (typeof fn !== "function") throw new TypeError(`Family resolver requires ${name}().`);
  }

  function describeKey(value) {
    const canonicalKey = normalizeTermKey(value);
    if (!canonicalKey) return null;
    const type = canonicalKey.includes(" ") ? "phrase" : "word";
    const surfaceTokens = canonicalKey.split(" ");
    const matchPath = [];
    const ambiguousPositions = [];
    const layVerbInflectionPositions = [];

    surfaceTokens.forEach((surface, index) => {
      if (isAmbiguousEnglishSurface(surface)) ambiguousPositions.push(index);
      if (isLayVerbInflectionSurface(surface)) layVerbInflectionPositions.push(index);

      // The service's matcher deliberately treats an exact `lay` request as
      // ambiguous and chooses the established lay record when it exists. Its
      // general lemma function maps bare `lay` to `lie`, so a canonical `lay`
      // storage surface must keep its own stable family path here. Inflected
      // lay forms still resolve through that same matcher to the lay path.
      const tokenKey = surface === "lay" ? "lay" : normalizeEnglishMatchKey(surface);
      if (!tokenKey) return;
      matchPath.push(...tokenKey.split(" "));
    });

    if (matchPath.length !== surfaceTokens.length) return null;
    return {
      familyKey: `en-family:v${FAMILY_VERSION}:${type}:${JSON.stringify(matchPath)}`,
      type,
      matchPath,
      ambiguousPositions,
      layVerbInflectionPositions,
    };
  }

  function familyKeyForKey(value) {
    return describeKey(value)?.familyKey || null;
  }

  function groupRecords(records, keyOf = (record) => record?.key) {
    const groups = new Map();
    for (const record of records || []) {
      const description = describeKey(keyOf(record));
      if (!description) continue;
      if (!groups.has(description.familyKey)) {
        groups.set(description.familyKey, { ...description, records: [] });
      }
      groups.get(description.familyKey).records.push(record);
    }
    return groups;
  }

  return Object.freeze({ describeKey, familyKeyForKey, groupRecords });
}

module.exports = { FAMILY_VERSION, createFamilyResolver };
