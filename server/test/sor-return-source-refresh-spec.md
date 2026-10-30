# SOR return source refresh

Tier 3: assigned-work concurrency and execution history. Spec approval: not
obtained (autonomous run under the user's instruction to repair SOR00248 first
and then automatically update returns when their source changes).

1. Repair SOR00248-Return first: replace item 10756 with current source item
   10750, quantity one; clear review; update its saved plan and catalog without
   changing assignment, route, or completed travel. Abort if pickup has started,
   source details differ from this scoped correction, or execution preservation
   rejects the proposal. Keep before-state operational audit and plan history.
2. Automatically refresh open unstarted returns after source item, quantity,
   address, or rental-policy changes, including already assigned returns.
3. Update the authoritative return, assigned plan cargo/locations, catalog, and
   driver-facing projection consistently. Preserve load/truck/stop identities.
4. Preserve started/completed physical return work and completed return history.
   A genuine incompatible source change requires accurate Dispatch review.
5. Repeated reconciliation and JSON object-key reordering are idempotent.
   Clear obsolete review flags on unchanged or safely refreshed work.
6. Keep existing split identity, disabled-feature, no-charge billing, durable
   retry, catalog failure, collision, and source cancellation safeguards.
7. Source updates after delivery can refresh an existing outstanding return;
   never backfill historical billed/delivered orders with new returns.

Failure model: concurrent driver start must serialize with refresh under the
fleet lock; a failed projection write must roll back the return update; stale
plan saves must not restore old cargo; address changes must not alter executed
travel; key ordering must not create spurious review; queue retry must not lose
a newer source update. Verify with real isolated PostgreSQL integration,
concurrency, serialization properties, regression tests, and manual mutants.

Setup: use existing Node test, c8, fast-check, ESLint, and TypeScript tools; add
no dependencies or commits. Run all tests through docker/run-isolated-tests.sh
with bounded containers in mbbs-tests.slice. Temporary copies, coverage and logs
stay in the runner's MBBS_TEST_ARTIFACT_DIR and are removed on teardown. Retain
only source tests/spec/evidence and operational repair/deployment audit records.
Release only the selected changed files on the current live image and retain a
rollback image; verify live source/return/plan agreement and application health.

Compatibility clarification: the former lifecycle assertion that a delivered,
billed order always produces zero source drafts is replaced by criterion 7:
an existing open return remains eligible for source refresh. Its assertions
against backfilling orders with no return remain in place.

Additional source-removal acceptance detail: ignore inactive source lines even
when a fulfilled-order feed includes them. A present source that explicitly
contains no returnable items must not fall back to saved delivered cargo.
Assigned removal still requires Dispatch to release the assignment; missing
historical source feeds retain the outstanding collection.
