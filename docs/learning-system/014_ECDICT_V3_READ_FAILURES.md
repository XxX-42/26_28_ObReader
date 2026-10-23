# ECDICT v3 adapter read failure classification

Candidate-only correction based on `962a6f94900e4cee9d65f362d6135794ad2928cb`.

- Explicit `ENOENT` and DOM `NotFoundError` retain missing-resource compatibility behavior.
- Permission (`EACCES`, `NotAllowedError`), I/O (`EIO`) and unknown exceptions produce `DICTIONARY_INDEX_READ_FAILED` or `DICTIONARY_RESOURCE_READ_FAILED`, preserving the original cause. They cannot trigger v2 compatibility fallback.
- Invalid binary values still produce resource-corrupt errors; conversion is outside the adapter read catch.
- Existing in-memory missing-file fixtures now provide an explicit ENOENT signal instead of an untyped exception. Existing assertions were retained.

## Evidence

With original dictionary implementation and new regression cases: 8 tests failed (all manifest/block combinations for permissions, I/O and unknown errors). With the correction:

`node --test tests/dictionary-resource-v3.test.mjs tests/vocabulary-dictionary.test.mjs tests/dictionary-cache.test.mjs`

53 passed, 0 failed, 0 skipped. Includes ready-v2-cache fallback prevention, availability status, retry after recovery, genuine missing compatibility, integrity failures and prior-ready-cache retention. `git diff --check` passed.

No Vault access, Native test, build, deployment or production wiring occurred. `main.js`, dist and canonical vocabulary/storage schemas are unchanged. Adapters that only expose untyped missing-file strings fail closed as READ_FAILED; platform-specific missing-error formats require verified adapter evidence before adding another recognized signal.
