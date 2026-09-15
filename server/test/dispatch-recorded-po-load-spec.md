# Preserve the recorded PO load

2026-09-14 follow-up: the user confirmed LOINC-033146's recorded load is unchanged.
Risk tier 3. Spec approval: not obtained (autonomous run); the business invariant
is explicitly confirmed by the user. Existing deployment authorization persists.

1. A PO with in-progress or completed physical pickup/drop activity retains its
   published `poRouteProjection`, including absence of that optional projection.
   Current allocation enrichment must not shrink or replace its recorded cargo.
2. Automatic residual-drop reconciliation leaves that PO's existing stops intact,
   even when the new allocation projects zero remaining cargo or a new destination.
3. Unstarted POs continue to use current allocations. Travel alone, queued jobs,
   and activity for another PO do not freeze their residuals.
4. Incoming edited stop/cargo data remains visible to the executed-prefix guard.
   No user payload can supply the protected reference set or recorded projection.
   Read and save paths derive these only from persisted snapshots and driver rows.
5. Repeated refresh is idempotent, doesn't mutate its inputs or persisted rows,
   and preserves all existing executed-timing and retirement protection.
6. Replay current production plan 324 and recoveries 17288/17291 through save and
   confirmation in isolated rollback transactions, with current driver activity.
   The LOINC drop remains exactly its recorded 1500.29 with the same stop identity,
   location, line IDs, timings and driver evidence. Reject an altered active drop.
7. Deploy the selective correction and post-check live read/validator agreement,
   recorded manifests, app health and unchanged plans, drivers and source data.

Failure model: stale client cargo changes (strict repository rejection), automatic
history rewrites (real DB refresh/replay), overbroad freezing (unstarted/travel/
other-order tests), stale activity races (existing save locks and concurrency
suite), projection drift (properties/idempotence), input mutation and accidental
writes (immutable fixtures, before/after hashes and rollback witnesses).

Use existing Docker, Node, PostgreSQL, fast-check, ESLint/TypeScript and coverage
tooling; no new dependencies or commits. Retain baseline sources and extend the
existing single-command gauntlet with regression, property, adversarial, mutation,
coverage, full suites, isolated replay and live post-check evidence. Preserve
unrelated workspace changes and the deployed worker image. Do not cancel the SO
supply allocation or modify recorded operational quantities as a workaround.

Replay detail: drafts 17288/17291 already contain the earlier automatically
reduced PO drop. Under the user's explicit "recorded load unchanged" instruction,
restore that one stop from published plan 324 in the replay candidate before
save/confirm. Its identity must match; all other draft edits remain intact.
Historical recovery records remain immutable. The application continues rejecting
an uncorrected submitted change to this active stop.

A new full database export was denied by automatic review because of unrelated
sensitive data. Use the existing isolated production copy plus only the current
active driver-event fields for plan 324; apply those events inside outer rollback.
Pair the replay with live read-only validation and persistence hashes.

Replay correction to the detail above: inspection showed draft 17288 omits both
PO stops altogether, rather than merely containing a reduced drop. It predates
the now-executed pickup/drop, so under current activity it must fail the exact
T4 driver lock. Do not synthesize missing physical history into that draft. Draft
17291 already contains the correct recorded PO stops and must save/confirm as-is
with schedule normalization only. Retain the original earlier-activity replay
of 17288 separately. The current live plan must also save/confirm unchanged.

Legacy serialized `po_route_projection` cannot bypass the published route. Strip
both spellings from a candidate, normalize a published legacy value to the
canonical field, and prove this at both the pure projection and real save boundary.
