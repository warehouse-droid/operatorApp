User correction: remove Pieces per sales UOM; the conversion is always 1. Tier 3 follow-up to the existing Special Order field edits. Spec approval: not obtained (autonomous run); the user explicitly authorized this behavior.

1. No conversion control or Pieces per sales UOM text remains in the Sales adjustment form or Sales/SCM review displays. All requested material, discount, date, note and packing fields remain editable.
2. Every new issued-order adjustment uses conversion 1, even if an older client submits another conversion. UOM edits need no conversion input. Missing historical conversion defaults to 1 only while existing order identity/rate checks continue to protect the stored price basis.
3. Pending proposals leave saved lines/orders unchanged. Approved proposals preserve original sales rate and purchase cost, and apply the entered quantity directly. Rejection leaves originals unchanged. Existing durable pending/recovery plans retain their approved snapshots.
4. Preserve authentication, revision, Dispatch, fulfillment and SCM approval checks. No production business-record migration or NetSuite writes are needed.

Failure model: UI-only removal leaving a blocking server validation (browser submission and real repository tests); a client-supplied conversion changing quantities/prices (adversarial and generated database tests); loss of approval/rate/cost protections (existing field/edit/adapter/REST suites); unrelated deployment drift (captured live overlay, hashes and rollback).

Use the already installed isolated Node/PostgreSQL/Chromium toolchain and existing scoped suites. No new dependencies, commits or migration. Persist reproducible checks, mutation definitions and measured evidence.

Test assumption correction: PostgreSQL stores the legacy numeric value as the string 2 rather than 2.000000. The pending-review assertion now compares entire saved rows before/after, verifying unchanged data without assuming a numeric display format.
