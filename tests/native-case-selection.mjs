export const NATIVE_LIFECYCLE_CASES = Object.freeze({
  "manual-save": ["autosave-disabled-square"],
  autosave: ["autosave-square", "autosave-ink"],
  inflight: ["autosave-inflight-square-then-ink"],
  rename: ["rename-source"],
  stale: ["same-pdf-two-views"],
  "external-conflict": ["external-bytes-conflict"],
  "failed-save": ["write-failure-recovery-source"],
  "close-flush": ["close-flush-reopen"],
  "close-recovery": ["close-recovery-autosave-disabled"],
  "close-recovery-write-failure": ["close-recovery-write-failure"],
  switch: ["switch-offdirty-source", "switch-offdirty-target"],
  matrix: ["native-editor-viewer-matrix"],
  eraser: ["native-editor-eraser"],
  popout: ["popout-migrate-save-listeners"],
  "popout-close": [
    "popout-close-held-save",
    "popout-close-autosave-disabled",
    "popout-close-recovery-write-failure",
  ],
  "popout-move": [
    "popout-move-autosave-dirty",
    "popout-move-recovery",
    "popout-move-recovery-failure",
  ],
});

export function selectNativeCases(value, cases = NATIVE_LIFECYCLE_CASES) {
  const available = Object.keys(cases);
  if (value === undefined) return available;
  if (value.trim() === "all") return available;

  const selected = value.split(",").map((name) => name.trim());
  if (selected.length === 0 || selected.some((name) => !name)) {
    throw new Error("PDF_READER_NATIVE_CASES must be a comma-separated list of case names.");
  }
  if (new Set(selected).size !== selected.length) {
    throw new Error("PDF_READER_NATIVE_CASES must not contain duplicate case names.");
  }
  const unknown = selected.filter((name) => !Object.hasOwn(cases, name));
  if (unknown.length) {
    throw new Error(`Unknown PDF_READER_NATIVE_CASES value(s): ${unknown.join(", ")}. Available: ${available.join(", ")}.`);
  }
  return selected;
}

export function fixturesForNativeCases(selected, cases = NATIVE_LIFECYCLE_CASES) {
  return [...new Set(selected.flatMap((name) => {
    if (!Object.hasOwn(cases, name)) {
      throw new Error(`Unknown native lifecycle case: ${name}.`);
    }
    return cases[name];
  }))];
}
