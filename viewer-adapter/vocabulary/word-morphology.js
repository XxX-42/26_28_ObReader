// SPDX-License-Identifier: Apache-2.0
// Original ObReader implementation and hand-authored linguistic facts.
// See WORD_MORPHOLOGY_SOURCES.md. No WordDecoder lexicon is bundled.
export function normalizeWordDisplayMode(value) {
  return value === "roots" ? "roots" : "whole";
}

const PARTS = Object.freeze({
  un: ["prefix", "un-", "否定或相反"], re: ["prefix", "re-", "再次"],
  dis: ["prefix", "dis-", "否定或相反"], pre: ["prefix", "pre-", "预先"],
  inter: ["prefix", "inter-", "相互、之间"], trans: ["prefix", "trans-", "跨越"],
  sub: ["prefix", "sub-", "在下"], ex: ["prefix", "ex-", "向外"],
  im: ["prefix", "im-", "向内"], in: ["prefix", "in-", "向内"],
  ly: ["suffix", "-ly", "构成副词"], ness: ["suffix", "-ness", "性质或状态"],
  ful: ["suffix", "-ful", "具有某种性质"], less: ["suffix", "-less", "缺少"],
  ment: ["suffix", "-ment", "行为或结果"], able: ["suffix", "-able", "能够被…的"],
  al: ["suffix", "-al", "与…有关"], ity: ["suffix", "-ity", "性质或状态"],
  ive: ["suffix", "-ive", "具有…性质的"], ion: ["suffix", "-ion", "行为或结果"],
  er: ["suffix", "-er", "做某事的人或物"], ing: ["suffix", "-ing", "动词 -ing 形式"],
  ed: ["suffix", "-ed", "动词过去式或分词形式"], s: ["suffix", "-s", "复数或第三人称单数形式"],
  port: ["root", "port", "携带"], script: ["root", "script", "书写"],
  spect: ["root", "spect", "看"], dict: ["root", "dict", "说"],
});

// Only listed relationships are eligible. A dictionary word's existence alone
// does not prove a derivation (corner != corn + -er; department != depart + ment
// in every contemporary sense). These are structure aids, not sense proofs.
const DERIVATIONS = new Map([
  ["mostly", ["most", "ly"]], ["quickly", ["quick", "ly"]],
  ["slowly", ["slow", "ly"]], ["carefully", ["careful", "ly"]],
  ["careful", ["care", "ful"]], ["careless", ["care", "less"]],
  ["helpful", ["help", "ful"]], ["helpless", ["help", "less"]],
  ["hopeful", ["hope", "ful"]], ["hopeless", ["hope", "less"]],
  ["happiness", ["happy", "ness"]], ["sadness", ["sad", "ness"]],
  ["kindness", ["kind", "ness"]], ["darkness", ["dark", "ness"]],
  ["unhappy", ["un", "happy"]], ["unhappiness", ["un", "happiness"]],
  ["unhelpful", ["un", "helpful"]],
  ["unknown", ["un", "known"]], ["rewrite", ["re", "write"]],
  ["rebuild", ["re", "build"]], ["reread", ["re", "read"]],
  ["disagree", ["dis", "agree"]], ["disagreement", ["disagree", "ment"]],
  ["preview", ["pre", "view"]], ["development", ["develop", "ment"]],
  ["enjoyment", ["enjoy", "ment"]], ["movement", ["move", "ment"]],
  ["readable", ["read", "able"]], ["washable", ["wash", "able"]],
  ["usable", ["use", "able"]], ["reusable", ["re", "usable"]],
  ["national", ["nation", "al"]], ["international", ["inter", "national"]],
  ["creative", ["create", "ive"]], ["creativity", ["creative", "ity"]],
  ["active", ["act", "ive"]], ["activity", ["active", "ity"]],
  ["teacher", ["teach", "er"]], ["reader", ["read", "er"]],
  ["reading", ["read", "ing"]], ["running", ["run", "ing"]],
  ["studying", ["study", "ing"]], ["studied", ["study", "ed"]],
  ["played", ["play", "ed"]], ["books", ["book", "s"]],
  ["studies", ["study", "s"]], ["transport", ["trans", "port"]],
  ["export", ["ex", "port"]], ["import", ["im", "port"]],
  ["subscription", ["sub", "script", "ion"]], ["inscription", ["in", "script", "ion"]],
  ["inspect", ["in", "spect"]], ["predict", ["pre", "dict"]],
]);

// A deliberately small, independently authored base vocabulary. Validation is
// O(1) and occurs only when a card is expanded, never during page matching.
const BASE_CATEGORIES = new Map([
  ["most", "adjective"], ["quick", "adjective"], ["slow", "adjective"],
  ["happy", "adjective"], ["sad", "adjective"], ["kind", "adjective"],
  ["dark", "adjective"], ["known", "adjective"], ["care", "noun"],
  ["help", "verb"], ["hope", "noun"], ["write", "verb"], ["build", "verb"],
  ["read", "verb"], ["agree", "verb"], ["view", "noun"], ["develop", "verb"],
  ["enjoy", "verb"], ["move", "verb"], ["wash", "verb"], ["use", "verb"],
  ["nation", "noun"], ["create", "verb"], ["act", "verb"], ["teach", "verb"],
  ["run", "verb"], ["study", "verb"], ["play", "verb"], ["book", "noun"],
]);
const RULES = [
  {affix:"ness", accepts:["adjective"], category:"noun"},
  {affix:"able", accepts:["verb"], category:"adjective"},
  {affix:"less", accepts:["noun","verb"], category:"adjective"},
  {affix:"ment", accepts:["verb"], category:"noun"},
  {affix:"ful", accepts:["noun","verb"], category:"adjective"},
  {affix:"ity", accepts:["adjective"], category:"noun"},
  {affix:"ing", accepts:["verb"], category:"verb"},
  {affix:"ly", accepts:["adjective"], category:"adverb"},
  {affix:"er", accepts:["verb"], category:"noun"},
  {affix:"ed", accepts:["verb"], category:"verb"},
];
const PREFIX_RULES = [
  {affix:"un", accepts:["adjective"]}, {affix:"re", accepts:["verb"]},
  {affix:"dis", accepts:["verb"]},
];
const SUFFIX_CATEGORY = {ful:"adjective",less:"adjective",able:"adjective",ive:"adjective",al:"adjective",
  ness:"noun",ment:"noun",ity:"noun",ion:"noun",er:"noun",ly:"adverb",ing:"verb",ed:"verb"};
function part(form) {
  const entry = PARTS[form];
  return entry ? {kind:entry[0],form:entry[1],meaning:entry[2]} : {kind:"base",form,meaning:"词基"};
}
function restoredStems(stem, affix) {
  const values=[stem];
  if (["ness","ly","ed"].includes(affix) && stem.endsWith("i")) values.push(stem.slice(0,-1)+"y");
  if (["able","er","ing","ed"].includes(affix)) values.push(stem+"e");
  if (["er","ing","ed"].includes(affix) && /([a-z])\1$/.test(stem)) values.push(stem.slice(0,-1));
  if (affix==="ity" && stem.endsWith("abil")) values.push(stem.slice(0,-2)+"le");
  if (affix==="ity" && stem.endsWith("iv")) values.push(stem+"e");
  return [...new Set(values)];
}
function solve(form, depth, budget) {
  if (depth>4 || --budget.remaining<0) return null;
  const reviewed = DERIVATIONS.get(form);
  if (reviewed) {
    const parts=reviewed.flatMap(piece => PARTS[piece] ? [part(piece)] : (solve(piece,depth+1,budget)?.parts || [part(piece)]));
    const suffix=reviewed.at(-1);
    const base=reviewed.find(piece=>!PARTS[piece]);
    const category=SUFFIX_CATEGORY[suffix] || (base ? categoryOf(base) : "verb");
    return {parts,category,derived:true};
  }
  const category=BASE_CATEGORIES.get(form);
  if (category) return {parts:[part(form)],category,derived:false};
  for (const rule of RULES) {
    if (!form.endsWith(rule.affix) || form.length-rule.affix.length<3) continue;
    const stem=form.slice(0,-rule.affix.length);
    for (const restored of restoredStems(stem,rule.affix)) {
      const base=solve(restored,depth+1,budget);
      if (base && rule.accepts.includes(base.category)) {
        return {parts:[...base.parts,part(rule.affix)],category:rule.category,derived:true};
      }
    }
  }
  for (const rule of PREFIX_RULES) {
    if (!form.startsWith(rule.affix) || form.length-rule.affix.length<3) continue;
    const base=solve(form.slice(rule.affix.length),depth+1,budget);
    if (base && rule.accepts.includes(base.category)) return {parts:[part(rule.affix),...base.parts],category:base.category,derived:true};
  }
  return null;
}
function categoryOf(form) {
  const direct=BASE_CATEGORIES.get(form);
  if (direct) return direct;
  const relation=DERIVATIONS.get(form);
  if (!relation) return null;
  return SUFFIX_CATEGORY[relation.at(-1)] || categoryOf(relation.find(piece=>!PARTS[piece]));
}

export function analyzeEnglishWord(value) {
  const original = typeof value === "string" ? value.trim() : "";
  const word = original.normalize("NFKC").toLowerCase();
  if (!/^[a-z]+$/.test(word) || word.length > 80) {
    return { word: original, supported: false, parts: [], note: "仅分析单个英语词；短语保留完整显示。" };
  }
  const result = solve(word, 0, {remaining:64});
  if (!result?.derived) {
    return { word: original, supported: false, parts: [], note: "暂无可靠构词分析，保留全词。" };
  }
  const parts = result.parts;
  return { word: original, supported: true, parts,
    note: word === "subscription"
      ? "subscribe → subscription：词干拼写由 scrib(e) 变为 script，不能把 subscribe 原样拼接 -ion。构词仅作学习辅助。"
      : word === "inscription"
        ? "inscribe → inscription：词干拼写由 scrib(e) 变为 script；构词仅作学习辅助。"
        : "构词学习辅助；词基会还原拼写，不能代替词典中的整词含义。" };
}
