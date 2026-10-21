# Closed-order workflow lock recovery, 2026-09-26

Spec approval: not obtained (autonomous run). Tier 3: completing the already
SCM-confirmed cancellation affects live commercial orders. The user reported
SPREQ-000007 / SOB121380 closed while POB03934 remained open.

Read-only live evidence confirms the lock is on the already closed SO: all three
SO lines are closed with zero execution/billing, but REST GET returns the workflow
lock error. The PO remains Pending Receipt, unreceived/unbilled and REST-readable.
The local closure review is attention with no saved plan; local cancellation has
correctly not completed.

Acceptance scenarios, before implementation:

1. For an order whose complete SuiteQL lines prove Closed and unexecuted/unbilled,
   verify its exact stable line identities, quantities, UOM, descriptions and rates
   through read-only data when workflow locking prevents loading the REST record.
   Never reopen or update that already closed order, and do not change a workflow.
2. A saved partial closure can retry: validate both orders, close only still-open
   lines through REST, and finish local cancellation only after both are verified.
   Preserve material/discount/PALLET identity, prices, native links and PO costs.
3. Workflow locks on open orders, incomplete/malformed query results, execution,
   billing, inconsistent closed flags, wrong quantities/UOM/keys, changed records
   and unrelated errors must not become successful closure verification.
4. An order may become workflow-locked immediately after its successful close.
   Its post-write check must succeed using the same complete closed-order evidence.
5. Preserve SCM review, Dispatch guards, approval journal, concurrency locks and
   idempotency. Only retry the existing approved-in-progress SPREQ-000007 review.
   SPREQ-000006 is excluded from all mutations.

Setup: reuse the existing isolated Node/PostgreSQL runner and installed tools;
no dependencies, migrations, commits or resets. Add focused contract, property
and real-journal tests, run related Special Item tests, type/lint/syntax checks,
changed-line coverage, manual mutants and reversed focused tests. Keep private
live snapshots and rollback artifacts. Deploy only changed closure runtime files
over the verified existing app/worker image. NetSuite writes remain REST only.

Refinement from the account readback: a closed record does not need another
commercial edit. Verify its terminal state, no execution/billing, complete expected
item/stable-line identities, and an unchanged raw SuiteQL commercial fingerprint.
Open records retain the existing full REST quantity/UOM/description comparison.
Capture the raw quantity, UOM, rate, percentage rate and description before closing
an open record so its locked readback can be compared without guessing native UOM
conversion. Existing legacy plans without that evidence must fail closed if their
REST record becomes unavailable. Reopened records conflict with a previously
closed baseline. No Units-list permission or workflow change is required.

User-added UI scope: SCM sees an alert on each request awaiting closure confirmation
or retry, plus a queue alert count. Pending/attention closure reviews sort ahead of
quantity reviews and ordinary cases, both before database pagination and after
client-side updates. Completed/rejected closures lose the alert and priority.
Existing search, stage filters, Sales permissions and saved form state remain.
