import path from "node:path";

/** Resolve a test's ignored evidence directory, honoring per-child gate isolation. */
export function resolveTestArtifactRoot(repositoryRoot) {
  const override = process.env.VOCABULARY_GATE_ARTIFACTS_DIR;
  return path.resolve(override || path.join(repositoryRoot, "tests", "artifacts"));
}
