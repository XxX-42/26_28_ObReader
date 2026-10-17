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

// This is a matching key only. The persistent vocabulary key remains the
// normalized surface key above so imports and existing records are untouched.
// Keep this table intentionally small and explicit: inflection is useful for
// learning, but unbounded stemming creates collisions between unrelated words.
const IRREGULAR_LEMMA_ENTRIES = [
  ["be", ["am", "is", "are", "was", "were", "been", "being"]],
  ["have", ["has", "had", "having"]],
  ["do", ["does", "did", "done", "doing"]],
  ["go", ["goes", "went", "gone", "going"]],
  ["get", ["got", "gotten", "getting"]],
  ["make", ["made", "making"]],
  ["take", ["took", "taken", "taking"]],
  ["come", ["came", "coming"]],
  ["run", ["ran", "running"]],
  ["write", ["wrote", "written", "writing"]],
  ["buy", ["bought", "buying"]],
  ["give", ["gave", "given", "giving"]],
  ["lie", ["lies", "lain", "lying", "lay"]],
  ["lay", ["lays", "laid", "laying"]],
  ["say", ["said", "saying"]],
  ["tell", ["told", "telling"]],
  ["speak", ["spoke", "spoken", "speaking"]],
  ["think", ["thought", "thinking"]],
  ["bring", ["brought", "bringing"]],
  ["catch", ["caught", "catching"]],
  ["teach", ["taught", "teaching"]],
  ["feel", ["felt", "feeling"]],
  ["keep", ["kept", "keeping"]],
  ["leave", ["left", "leaving"]],
  ["meet", ["met", "meeting"]],
  ["find", ["found", "finding"]],
  ["lose", ["lost", "losing"]],
  ["pay", ["paid", "paying"]],
  ["sell", ["sold", "selling"]],
  ["send", ["sent", "sending"]],
  ["sit", ["sat", "sitting"]],
  ["stand", ["stood", "standing"]],
  ["understand", ["understood", "understanding"]],
  ["win", ["won", "winning"]],
  ["sleep", ["slept", "sleeping"]],
  ["spend", ["spent", "spending"]],
  ["build", ["built", "building"]],
  ["hold", ["held", "holding"]],
  ["hear", ["heard", "hearing"]],
  ["wear", ["wore", "worn", "wearing"]],
  ["break", ["broke", "broken", "breaking"]],
  ["choose", ["chose", "chosen", "choosing"]],
  ["drive", ["drove", "driven", "driving"]],
  ["eat", ["ate", "eaten", "eating"]],
  ["fall", ["fell", "fallen", "falling"]],
  ["fly", ["flew", "flown", "flying"]],
  ["forget", ["forgot", "forgotten", "forgetting"]],
  ["grow", ["grew", "grown", "growing"]],
  ["know", ["knew", "known", "knowing"]],
  ["ride", ["rode", "ridden", "riding"]],
  ["rise", ["rose", "risen", "rising"]],
  ["throw", ["threw", "thrown", "throwing"]],
  ["draw", ["drew", "drawn", "drawing"]],
  ["show", ["showed", "shown", "showing"]],
  ["become", ["became", "becoming"]],
  ["begin", ["began", "begun", "beginning"]],
  ["drink", ["drank", "drunk", "drinking"]],
  ["sing", ["sang", "sung", "singing"]],
  ["swim", ["swam", "swum", "swimming"]],
  ["ring", ["rang", "rung", "ringing"]],
  ["cost", ["costing"]],
  ["let", ["letting"]],
  ["put", ["putting"]],
  ["cut", ["cutting"]],
  ["set", ["setting"]],
  ["hit", ["hitting"]],
  ["hurt", ["hurting"]],
  ["shut", ["shutting"]],
  ["carry", ["carried", "carrying"]],
  ["study", ["studies", "studied", "studying"]],
  ["stop", ["stopped", "stopping"]],
  ["box", ["boxed", "boxes", "boxing"]],
  ["bus", ["buses"]],
  ["gas", ["gases"]],
  ["quiz", ["quizzes"]],
  ["hero", ["heroes"]],
  ["potato", ["potatoes"]],
  ["tomato", ["tomatoes"]],
  ["echo", ["echoes"]],
  ["veto", ["vetoes"]],
  ["analysis", ["analyses"]],
  ["crisis", ["crises"]],
  ["thesis", ["theses"]],
  ["diagnosis", ["diagnoses"]],
  ["walk", ["walked", "walking"]],
];

const IRREGULAR_LEMMA_MAP = new Map();
for (const [lemma, forms] of IRREGULAR_LEMMA_ENTRIES) {
  for (const form of forms) IRREGULAR_LEMMA_MAP.set(form, lemma);
}

// English verbs commonly restore a silent e before -ing/-ed. These stems are
// explicit because a spelling-only suffix rule cannot distinguish, for
// example, "hoped" (hope) from "hopped" (hop), or "changed" from "hanged".
const SILENT_E_FORMS = new Map(Object.entries({
  baking: "bake", baked: "bake",
  closing: "close", closed: "close",
  dancing: "dance", danced: "dance",
  changing: "change", changed: "change",
  charging: "charge", charged: "charge",
  managing: "manage", managed: "manage",
  judging: "judge", judged: "judge",
  hoping: "hope", hoped: "hope",
  liking: "like", liked: "like",
  joking: "joke", joked: "joke",
  moving: "move", moved: "move",
  loving: "love", loved: "love",
  living: "live", lived: "live",
  giving: "give", given: "give",
  saving: "save", saved: "save",
  using: "use", used: "use",
  sizing: "size", sized: "size",
  tying: "tie", tied: "tie",
  dying: "die", died: "die",
  lying: "lie", lied: "lie",
  vied: "vie",
}));

const UNCHANGING_FINAL_S = new Set([
  "alias", "always", "analysis", "atlas", "basis", "business", "canvas", "chaos", "economics", "ethics", "gas", "bus", "his", "lens", "yes",
  "mathematics", "means", "news", "physics", "politics", "series", "species",
  "status", "this", "thus",
]);
const AMBIGUOUS_ENGLISH_SURFACES = new Set(["lay"]);
const LAY_VERB_INFLECTIONS = new Set(["lays", "laid", "laying"]);

function normalizeEnglishWordLemma(word) {
  if (!/^[a-z]+$/.test(word)) return word;
  // Some common citation forms end in a productive-looking suffix by
  // coincidence. Protect them before applying y/s inflection rules.
  if (UNCHANGING_FINAL_S.has(word)) return word;
  const irregular = IRREGULAR_LEMMA_MAP.get(word);
  if (irregular) return irregular;
  const silentE = SILENT_E_FORMS.get(word);
  if (silentE) return silentE;

  // Consonant + y verbs/nouns: carry/carries/carried/carrying.
  if (word.length > 4 && word.endsWith("ied")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;

  // Regular -ed and -ing inflections. Only collapse an actual doubled final
  // consonant; vowel pairs such as "looked" stay intact.
  if (word.length > 4 && word.endsWith("ed")) {
    let stem = word.slice(0, -2);
    if (/([^aeiou])\1$/.test(stem)) stem = stem.slice(0, -1);
    if (stem.endsWith("c") || stem.endsWith("v") || stem.endsWith("z")) return `${stem}e`;
    if (/^[^aeiou][aeiou][kp]$/.test(stem)) return `${stem}e`;
    return stem;
  }
  if (word.length > 5 && word.endsWith("ing")) {
    let stem = word.slice(0, -3);
    if (/([^aeiou])\1$/.test(stem)) stem = stem.slice(0, -1);
    if (stem.endsWith("c") || stem.endsWith("v") || stem.endsWith("z")) return `${stem}e`;
    if (/^[^aeiou][aeiou][kp]$/.test(stem)) return `${stem}e`;
    return stem;
  }

  // -es is productive after ch/sh/ss/x/z. Do not apply the rule to every
  // `-es` spelling: that would turn "potatoes" into "potatoe" and can
  // create unrelated stems. A short explicit map above covers common -o
  // plurals, while silent-e stems such as case/cases remove only final s.
  const finalSRemoved = word.slice(0, -1);
  if (word.length > 3 && word.endsWith("es") && /[aeiou]ze$/.test(finalSRemoved)) return finalSRemoved;
  if (word.length > 4 && /(?:ch|sh|ss|x|z)es$/.test(word)) return word.slice(0, -2);

  // Verbs and nouns whose citation form ends in silent e add only `s`
  // (make/makes, write/writes, case/cases). Leave unknown -es forms alone.
  if (word.length > 3 && word.endsWith("es") && word.slice(0, -1).endsWith("e")) {
    return word.slice(0, -1);
  }

  if (!UNCHANGING_FINAL_S.has(word) && word.length > 3 && word.endsWith("s")) {
    if (word.endsWith("ss") || word.endsWith("us") || word.endsWith("is")) return word;
    if (word.endsWith("ys")) return `${word.slice(0, -2)}y`;
    return word.slice(0, -1);
  }
  return word;
}

/**
 * Return a deterministic matching-only English lemma key. Unlike
 * normalizeTermKey(), this intentionally folds common inflections together;
 * never use it as a persistence key. Multiword input is normalized word by
 * word, so phrase matching preserves token count and order.
 */
export function normalizeEnglishLemmaKey(surface) {
  const normalized = normalizeTermKey(surface);
  if (!normalized) return "";
  return normalized.split(" ").map(normalizeEnglishWordLemma).join(" ");
}

/**
 * Some spellings have more than one ordinary lemma. They may be matched only
 * as an exact surface unless the host has already resolved the lookup to one
 * canonical record. Currently `lay` is also the past tense of `lie`.
 */
export function isAmbiguousEnglishSurface(surface) {
  const normalized = normalizeTermKey(surface);
  return AMBIGUOUS_ENGLISH_SURFACES.has(normalized);
}

/** Return true for the unambiguous inflections of the verb `lay`. */
export function isLayVerbInflectionSurface(surface) {
  const normalized = normalizeTermKey(surface);
  return LAY_VERB_INFLECTIONS.has(normalized);
}

// Retain the descriptive alias for callers that already use the viewer-side
// name while making the shared host/viewer term-key contract explicit.
export const normalizeEnglishSurfaceKey = normalizeTermKey;
