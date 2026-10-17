# Phase B: vocabulary families and core service

This note records the family/schema service evidence and the behavior change that follows v1 migration. It does not claim that the UI or the complete Phase B gate passes.

## Focused evidence

The combined focused service, Context, and history run was:

```text
node --test tests/vocabulary-context-service.test.mjs tests/vocabulary-v2-schema-family.test.mjs tests/vocabulary-service.test.mjs tests/vocabulary-history.test.mjs
71 passed, 0 failed, 0 skipped
```

The TAP output is retained at `/private/tmp/vocabulary-v2-phase-b-family-reference-precondition.log`. Related Phase B logs are `/private/tmp/vocabulary-v2-phase-b-host-3.log` (plugin-host unit suite, 77/77) and `/private/tmp/vocabulary-v2-phase-b-runtime.log` (runtime boundary suite, 2/2). These are focused checks, not UI or full-gate results.

The separate cross-runtime interleaving suite `node --test tests/vocabulary-v2-runtime.test.mjs` was also reported green by the root agent (4/4). It is not included in the retained 71-test TAP log.

## Legacy assertions and migration mapping

| Existing assertion | v1 expectation before migration | v2 expectation after migration | What remains stable |
| --- | --- | --- | --- |
| `tests/vocabulary-service.test.mjs`, “legacy duplicate inflection records keep their own definitions but receive one family status” | `getTerm("walking").key` selects `walked` while the v1 family members have different status/richness. | Migration raises both `walk` and `walked` to the family maximum. The tie is then resolved deterministically to `walk`; a subsequent status write also returns `walk`. | Both canonical records and their own translations, notes, and pronunciations remain separate; the family key and status semantics are stable. |
| `tests/vocabulary-v2-schema-family.test.mjs`, “v1 migration is atomic, family-stable, status-max preserving, and idempotent” | Before migration, `walking` selects `walk`; writes are refused and the exact v1 bytes stay untouched until migration. | Migration writes schema v2 once, sets each family member to its maximum status, and is idempotent. `walking` still selects `walk` in this fixture because the status tie uses the stable key order. | Original per-record metadata is retained; `walk`/`walked`, `low`/`lowest`, and phrase variants share versioned family keys; `lay`/`laid` remain separate from `lie`. |
| `tests/vocabulary-service.test.mjs`, “ambiguous lay prefers its exact record and keeps lie and lay families separate” | The `lays` alias selects higher-status `lay`. | After `lay` and `laid` are normalized to the same family status, the deterministic tie selects `laid`; exact `lay` still returns the `lay` record. | `lay`/`laid` remain one family and `lie` remains another; the matcher's ambiguous-surface rule is unchanged. |
| `tests/vocabulary-service.test.mjs`, page word/phrase matching assertions | Alias selection can reflect legacy per-record statuses. | Family status is shared and selected storage keys are deterministic; exact phrase matches still take precedence, while inflected phrases resolve within the same phrase family. | Match spans, phrase boundaries, and original personal metadata remain attached to their records. |

The selected `storageKey` is a lookup result, not the family identity. Migration intentionally removes within-family status differences by applying the maximum status to every member; where that makes lookup candidates tie, the deterministic key tie-break can change the selected record. It does not merge siblings or move their user metadata. `familyKey` remains versioned and independent of the selected member.

## Audit note

The cross-store reference race is covered by snapshot preconditions. Context obtains family and core snapshot identity in one queued `getFamilyEvidence(surface)` read, then commits its Context writes with that core identity as a transaction precondition. Core history deletion validates Context and Review references and passes the checked manifest/shard identities through the restore plan into the same coordinator commit that removes the final family record. `tests/vocabulary-v2-runtime.test.mjs` exercises both races with two Runtime instances and coordinators sharing one adapter: a Context inserted after restore reference validation blocks the deletion, and a real deletion between Context lookup and commit blocks the Context write. Service, Context, and history focused checks passed together; this does not claim UI or full-gate completion.
