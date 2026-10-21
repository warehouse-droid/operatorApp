# SPREQ-000041 PO recovery and Stock Requests scrolling

Autonomous repair; spec approval: not obtained (autonomous run). The user requests
POB03999 linkage and completion without a stranded operation lock, and reports
Audit Trail scrolling on both Sales and SCM pages.

1. The native PO recovery reader recognizes PALLET 1784 as ancillary, alongside
   exact material 2055 identities. SPREQ-000041's SQFT quantity 98.08, SO price
   6.40, PO cost 4.48, and PALLET quantity 1/cost 35 remain intact. Recover an
   existing native PO without creation or writes. When there is no native PO,
   independently reviewed vendor PALLET quantities cannot block standalone PO
   creation. Real ambiguous identities, partial links, vendor/yard/source
   mismatches, execution, and material changes must continue to reject.
2. A custom manual PO link can resolve an unsubmitted failed PO operation after
   validating existing order identity, vendor, yard, activity, ownership, and
   revision. Clear only the matching PO failure's attention; preserve unrelated
   SO attention. Submitted/creating operations and other pending changes remain
   protected. Record the resolved operation ID/error in the linking audit.
3. SPREQ-000041 is linked to verified existing POB03999 through the standard
   custom-link workflow. Preserve all current NetSuite SO/PO lines and historical
   application drafts. No duplicate PO, repricing, or NetSuite write. Retrieve
   the actual PO PDF and verify no failed-operation lock remains.
4. On Sales and SCM Stock Requests, desktop detail scrolling and phone/tablet
   page scrolling reach every audit entry and scroll back out. Real mouse-wheel
   checks cover regular and special requests using the actual page assets.
   Preserve independent desktop list scrolling and mobile list-height limits.

Failure model: incorrect ancillary matching and duplicate creation are checked
with exact fixtures, generated acceptance/rejection, and mutations; unsafe lock
clearing with HTTP revision/rollback/operation-state checks; nested scroll traps
with real-browser wheel input; production drift with source/configuration hashes
and protected before-state snapshots.

Setup: existing cached test image and standard isolated Compose project, test-only
credentials, mbbs-tests.slice and standard memory/CPU/PID/tmpfs/init bounds.
Register teardown before startup; remove all test containers, databases/volumes,
and task networks even on failure. Keep logs and evidence. No new dependencies,
runtime schema changes, or commits; preserve unrelated workspace/deployment work.

Scope clarification after inspecting actual rendered pages: SCM Special and
Sales Regular display audit/update entries; Sales Special and SCM Regular do
not render those entries. Browser checks use the real trail where present and
the real final detail controls elsewhere. No audit component is invented or
added as part of the scrolling repair. The original overly broad fixture
assumption and its failures are retained in the evidence.
