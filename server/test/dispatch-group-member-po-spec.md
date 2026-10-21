# Group member PO pickup projection

Spec approval: not obtained (autonomous run under the user's request to fix the route).
Tier 2 code correction, with guarded rollback rehearsal for the live plan correction.

The group GOM-6255S2-6256S2-6662-6663 must collect the active PO links held by
its actual members. Fully linked cargo requires TECHO BLOC Vaughan and no
150 pickup. A partially linked member still requires its remaining own-yard
cargo. Group-level links and member links are each counted once. Nested
groups retain member links. Split parent and sibling links are never inherited.
CO source children are informational and must not acquire SO pickup cargo.
Cancelled links disappear after authoritative refresh. Repeated strip/enrich
cycles conserve quantities and are idempotent, without changing source orders
or allocation records. Existing PO residual, pickup, and plan guards survive.

Failure model: missed descendants recreate the 150 stop; duplicate member refs
double vendor cargo; split-parent aliases import the completed S1 load; stale
projections keep cancelled links; refreshing a live route can overwrite a
dispatcher edit or driver activity. Cover the first four with production-function
tests and generated examples. Cover live changes with revision and edit-lease
guards, driver activity checks, normal transactional save validation, a private
backup, rollback rehearsal, and exact unrelated-load comparisons.

Setup: use existing Node test, fast-check, ESLint, TypeScript, and c8 tools in
an isolated Docker image. Add no dependencies or commits. Save baseline,
regression tests, mutation runner, evidence, and guarded support repair in this
repository. Release only the verified repository file over the running image.
Use the current plan save path to remove the empty 150 pickup and attach the
group to its existing vendor visit. Preserve customer delivery and other loads.
