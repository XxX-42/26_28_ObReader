# Exact learning Markdown source bounds

Baseline `671833a`: a persisted 4,097-character Markdown learning excerpt could not return to its unchanged source. The actual Learning Host opener failed with `TARGET_UNRESOLVED` because the shared source evidence helper imposed its generic 4,096-character citation bound.

The repair permits up to 100,000 characters only when the opener receives both `source: "learning-item"` and `requireExact: true`. The identical evidence options apply before and after asynchronous note opening. Generic, nonexact, or differently labelled requests retain the 4,096-character bound. Exact literal comparison and temporary selection/user-movement cleanup are unchanged.

Evidence:

- New actual-Host 4,097-character saved-item Source test failed before repair and passes after repair.
- The same test checks the actual exact-source navigation boundary at 100,000 characters, rejects 100,001, keeps generic 4,097-character requests rejected, and rejects a literal changed during asynchronous open without selection, cursor fallback, or focus stealing.
- Targeted source routing/focus tests: 5/5, zero skipped. Learning Host/domain suites: 24/24, zero skipped. No Browser or Native run.

The 100,000-character case tests navigation directly: an item with duplicated text snapshots at that size can exceed the existing single-record shard byte cap. This repair does not expand persistence limits or change any schema.
