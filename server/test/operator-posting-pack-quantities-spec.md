# Operator IF / IR pack columns — 2026-10-10

The user authorized the pack-column fix for SOA10124 and clarified that LYR is
descriptive on an Item Fulfillment and must not block completion. Specification
approval: not obtained (autonomous run). The user is separately changing the
OAuth role exclusion in MB Sales Order Approval; this change does not alter that
workflow or bypass its lock.

Tier 3 failure model: copied full-order counts misdescribe partial shipments;
cumulative counts overstate a subsequent shipment; grouped lines lose counts;
pack columns accidentally change accounting quantities or block completion;
retries duplicate inventory transactions; a release includes unrelated changes.

Executable acceptance criteria:

1. A confirmed 3 LYR pickup on a 7 LYR, 73.22 SQFT order produces one selected
   payload line with quantity 31.38, custcol_lyr 3, and explicit zero PLT/SEC/PCS.
   The unselected item remains unselected with no pack-field update.
2. Pickup and delivery-prep counts use packed minus already fulfilled counts;
   receiving counts use the current receipt draft. Support SO/TO IF and PO/TO IR.
   Preserve component evidence for kits without copying component pack counts
   onto a kit parent.
3. Multiple local allocations of one source line sum their physical counts.
   Keep counts in the immutable selected-line snapshot and payload hash.
4. Preserve the existing rule: only a positive SQFT difference strictly below
   0.01 may use the fresh NetSuite quantity. A 3-vs-7 LYR difference remains a
   partial 31.38 SQFT posting, and the physical count stays 3 when SQFT rounds.
5. PLT/LYR/SEC/PCS differences, absent columns, or absent legacy pack evidence
   never block an otherwise valid IF/IR. The existing identity, location, unit,
   source-line and accounting quantity checks remain required.
6. NetSuite exposes these custom columns as int64. Optional descriptive values
   that cannot be represented as nonnegative safe integers are omitted rather
   than rounded or turned into an accounting failure. Valid counts including
   zeros are written. No accounting quantity is derived from these columns.
7. A realistic durable pickup completes once even if readback retains 7 LYR
   while accounting quantity is 31.38; a replay does not create another IF or
   local load record. A true accounting mismatch still holds completion.
8. Source only this patch over the captured live image, preserve configuration,
   keep rollback artifacts, remove all disposable test containers, volumes and
   networks, and verify production health. No new dependencies, schema changes,
   checkpoint commits, or production credentials/data in tests.

Setup: existing Node 20, node:test, fast-check, c8, TypeScript and ESLint from the
lockfile; standard resource-bounded isolated Compose runner with registered
teardown. Add regression, property, lifecycle tests and a persisted gauntlet,
mutation script, source manifest, coverage comparison and evidence report.

Operational checks: inspect the source REST read after the user's workflow role
exclusion. Correct IF157565's descriptive fields only when its source, external
ID, original operator confirmation and 31.38 SQFT accounting quantity still
match. Preserve before/after evidence; do not create a replacement fulfillment.

SOA10099 extends this authorized fix to one pickup SO with lines in multiple
yards. The source header and line inventory locations remain persisted as synced.
The pickup response and actions use the operator's selected parent yard; a child
inventory location belongs to its directory-defined parent. This scope applies
only to customer pickup, preserving delivery/group authorization rules.

9. Lookup in 3445 returns only its line; lookup in 2967 finds the same SO and
   returns only its line even when the SO header is 3445. An operator needs only
   permission for the requested yard. Unknown or inconsistent stored locations
   fail closed; a supplied yard cannot grant access to a foreign line.
10. Single/bulk confirmations reject foreign line IDs before writing any line.
    Confirmation responses stay scoped. Clearing/loading 3445 preserves 2967's
    staged quantities and confirmations. Loading computes global SO completion
    across both yards while recording only the current yard's line snapshot.
11. A gated IF selects only confirmed lines in the current yard and deselects
    other source lines. The durable finalizer uses the command's canonical yard.
    A later pickup at the other yard remains available without duplicating the
    completed yard. Single-yard clients remain compatible; mixed-yard clients
    supply the selected yard on lookup, confirm, clear, and load.
12. The served operator assets use a new cache version and pass the selected
    yard on every pickup mutation. Verify both SOA10099 yard scopes after release
    without changing its existing operator drafts or posting an unsolicited IF.

The load-screen refresh was found to reuse the delivery endpoint. Criterion 12
also requires pickup-scoped GET detail on entry and final confirmation, with the
missing-line confirmation summary recomputed from the selected yard's lines.
Keep ordinary delivery refresh unchanged and reject a non-pickup SO on this new
pickup detail endpoint. Preserve legacy single-yard child-location requests when
the resolver infers their parent without a client yard.
