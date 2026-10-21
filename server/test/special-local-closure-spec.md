# Local closure of orders already closed in NetSuite

Spec approval: not obtained (autonomous run). Tier 3 because the request and its
commercial order journal change. No NetSuite order may be written by this path.

Acceptance criteria, before implementation:

1. Fresh NetSuite header queries must identify the exact linked SO and any PO by
   internal ID, transaction reference and transaction type. Only Closed,
   Cancelled or Canceled qualifies. Local cached statuses are insufficient.
2. When every linked order qualifies, both Sales closure and SCM confirmation
   finish locally, including a previously failed review. Recheck remote evidence
   before the transaction; preserve the review ID, original confirmer, links,
   line quantities, prices, discounts, costs and historical execution records.
3. Closed orders may have executed/billed lines, different discounts or a workflow
   lock. Local reconciliation needs no REST load, unit conversion or close PATCH.
4. Missing, duplicate, wrong-type, wrong-reference, malformed, reopened or open
   remote orders cannot use this path. The existing open-order cancellation flow
   and SCM confirmation requirements remain unchanged.
5. Preserve expected revision, Sales scope, pending operation and quantity review
   guards, Dispatch planning protection, closure lock, transaction rollback,
   audit event and retry idempotence. Completed handoffs retain their history.
6. SPREQ-000011 has a confirmed review in attention. Read-only evidence currently
   shows POB03960 Closed but SOM06738 Pending Billing with all material fulfilled.
   The requested both-Closed rule does not cover that state. Its local recovery
   waits for the user's answer; do not mark the SO Closed or write to NetSuite.

Failure model: accepting an open/wrong order (header contract and property tests);
closing only part of a pair (real database tests); stale or concurrent action
(revision and advisory lock tests); financial changes or duplicate remote work
(no-write boundary and preservation assertions); losing audit/history (journal
and completed-handoff assertions).

Setup: reuse the installed isolated Node/PostgreSQL runner and existing tools.
Add focused tests and reproducible check/deploy/recovery scripts, use no new
dependencies or migrations, and make no commits or resets. Run related Special
Item tests, lint, types, syntax, changed-line coverage, three manual mutants,
property tests and reversed focused tests. Capture source hashes, a targeted
rollback image and private live checkpoint. Release only the closure runtime
files over the current verified app image, preserving concurrent source changes
and all other container configuration.

User-authorized refinement: close SPREQ-000011 locally even though SOM06738 is
Pending Billing. This is an explicit recovery option, absent from ordinary HTTP
contexts. It requires fresh SO status F/Pending Billing and complete nonzero
quantity-bearing line evidence proving every quantity fulfilled. Preserve that
actual SO status rather than relabeling it Closed. POB03960 must still be Closed.
No NetSuite mutation is authorized or needed. Preserve the existing confirmed
review and all other requests. The default general rule remains both orders
Closed; add tests rejecting partial fulfillment and missing recovery authorization.

Baseline note: the broader current workspace has six unrelated failing tests.
They were reproduced on the captured original closure files (27 pass / 6 fail in
the six affected suites): purchase total currency formatting; PO approval before
Dispatch planning (two tests); legacy SO draft/customer identity expectations
(two tests); and an unrelated SO creation boundary requiring NetSuite config.
Keep these exact failures, report zero new failures, and do not weaken assertions
or change unrelated behavior. The added header read requires a new read-only
SuiteQL HTTP fixture; existing HTTP assertions remain unchanged.

Concurrent-work refinement: another session edited the shared repository and
added an SCM name-correction test during verification. Its new name/brand writes
are excluded from this release. Build the repository candidate from the captured
deployed baseline plus only the closure import, planning helper change and local
finalizer. The newest unrelated HTTP test also fails its own alert-count assertion
on the original closure code (2 instead of 1); both tests were reproduced there.
The scoped candidate's broader baseline therefore has eight exact failures.
Record these rather than changing another task's tests or releasing its code.

Final frozen-suite comparison: continuing concurrent edits added another
name/brand expectation. The final candidate run contains 481 tests, 472 passes
and nine failures. The exact same nine failures reproduce with the captured
original closure code against those frozen test files; there are zero new
failures. This final comparison supersedes the earlier six/eight counts without
changing their assertions. The 37 focused closure tests all pass.

Completion: the three-file candidate was deployed with unchanged app settings,
worker, dependencies and schema. The specifically authorized recovery closed
SPREQ-000011 locally, retained the original confirmation, commercial lines and
other requests, and independently verified the saved state. NetSuite remains
SOM06738 Pending Billing and POB03960 Closed; the recovery made zero NetSuite
writes. Detailed evidence is in special-local-closure-evidence.md.
