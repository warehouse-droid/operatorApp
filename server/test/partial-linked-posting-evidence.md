# Partial linked-order posting evidence — 2026-10-27

Spec approval: not obtained (autonomous run). Tier 3 because the change admits
financial transactions and must prevent duplicate consumption. The user requested
a general partial fulfillment/receipt behavior rather than adding pallet links.
The executable acceptance criteria are in `partial-linked-posting-spec.md`.

The released change admits PO receipts from immutable, paired pickup/delivery
allocations. It selects only those quantities, retains the live NetSuite remainder
checks and durable posting claims, and records local partial receipt progress.
Existing SO fulfillment remains triggered by Operator loading and already posts
partial saved quantities. Driver delivery does not create a duplicate SO IF.

## Final validation

Source hashes and tool versions: `partial-linked-posting-evidence.json`.
Reproduce from the frozen release with:

```sh
bash server/tools/partial-linked-posting-test.sh static coverage reverse mutations
PARTIAL_POSTING_RUNTIME="$PWD/server/deployments/partial-linked-posting-20261027/live-before" \
  bash server/tools/partial-linked-posting-test.sh baseline
```

- 22 new tests passed. The 36-file affected regression set ran 275 tests:
  247 passed, 28 pre-existing failures, zero new failures. Reversing file order
  produced the same results. Files receive separate disposable database clones.
- All 169 changed executable lines were exercised. Branch percentages were not
  retained; this report does not claim complete branch coverage.
- Five of five manual mutants were killed. The quantity property alone killed
  all three quantity mutants. The two database-state mutants require integration
  tests; the quantity property does not establish database ownership/provenance.
- The new property ran 120 examples with seed 20261027.
- Type diagnostics: 109 before and after, zero new. Lint diagnostics: four before
  and after, zero new. Syntax checks passed. Changed-source secret scan found zero
  issues. New allocation-evidence functions meet complexity limit 12.
- Concurrent tests use independent transactions: 32 workers admit one command;
  two delivery jobs cannot consume an allocation twice; two deliberately stale
  readers race at the unique ownership boundary; a source-claim conflict rolls
  back allocation ownership and succeeds after the earlier receipt completes.
- Migration reapply and transactional rollback passed. Immutable claim deletion
  is rejected, with its retained row checked afterward.
- No dependencies or lockfiles changed. No git commit was created.

The 28 exact baseline failures are retained in `partial-linked-posting-baseline.json`:
one receiving-follow-up assertion and 27 older split/completion tests. They were
observed twice against the frozen live runtime before candidate comparison.
Unrelated application/UI suites were not run. The older `direct-ship-posting`
integration file expects Driver-triggered SO IF creation, superseded by migration
301; the current sales-load integration suite covers that trigger contract.

## Acceptance mapping

| Spec | Executable evidence |
| --- | --- |
| 1: paired evidence, partial admission, rejected invalid routes | New integration tests for no whole-PO completion, cancelled links, reopened delivery/pickup audit, and revocation after admission |
| 2: exact selected quantity and residual | New unit property, 40/100 real finalizer, later 60, unlinked pallet, full product with pallet outstanding |
| 3: sum once, replay, race, later distinct allocation | New multiple-allocation, duplicate-job, replay, and independent-transaction concurrency tests |
| 4: gates, exact source, live bounds, durable recovery | New gate and provenance tests; existing direct-posting, operator posting, rounding, repository, adversarial, and property suites |
| 5: partial SO load and unchanged trigger | Existing sales-delivery-load unit/integration suite and saved-load property |
| 6: automatic future admission, scoped historical recovery | Migration trigger tests; production recovery script restricted to PO IDs 1082483 and 1080498 and delivery record 7300 |
| 7: retain links/history/runtime and clean test host | Immutable claim assertions; deployment verifies all 1,557 runtime files, unchanged configuration/dependencies; before/after operational audit |

## Iterations and limits

The original unit tests failed on full-line quantities and selecting pallets, and
the original integration tests failed because no partial receipt job was created.
A later adversarial test exposed a missing reopened-pickup audit check; that check
was added. A network fixture needed the real NetSuite unit shape. The immutable
ledger test was corrected to assert the existing exact append-only error and the
retained row. The first mutation harness exited without a report while copying
unrelated historical tooling; it now copies only the required source and fixtures.
The complete mutation run then passed. No behavioral assertion was relaxed.

The posting pipeline still holds ambiguous/blocked jobs for review. Allocation
ownership is not automatically moved to another delivery after a failed job.
Live remaining quantities prevent over-receipt; this change does not infer which
allocation an independently posted external receipt belonged to.

All test workloads used the repository retention wrapper, bounded Compose
configuration and `mbbs-tests.slice`. Every test environment, database clone,
volume, network and generated artifact was removed. Both `docker ps` and
`docker ps -a` showed only the four production containers after cleanup.

## Operational records

The scoped release is `mbbs-operator-app:partial-linked-posting-20261027`.
Deployment and rollback audit records are under
`server/deployments/partial-linked-posting-20261027`; the exact source hashes match
the final tests. The app passed health verification, with configuration and all
three dependency containers preserved. Production before-state and receipt
recovery records are under `server/artifacts/partial-linked-posting-20261027`.

Live recovery completed through the real durable processor and NetSuite adapter:

| PO | Verified IR | Received | Outstanding pallet quantity |
| --- | --- | --- | --- |
| LOINC-040951 / POB04107 | IR15315 (1095092) | 92.31 SQFT | 1 |
| LOINC-04087, canonical LOINC-040807 / POB04103 | IR15316 (1095093) | 93 PC plus 1 PC fee line | 3 |

Both live NetSuite POs are status E, Pending Billing/Partially Received. Their
local receipt status is `partial_received`; each has exactly one receipt ledger
record. All three allocations are unchanged. The receipt claims reference only
execution events 239, 240 and 241 and delivery 7300. Live related SOs 1082694 and
1068795 were already status F before recovery, and no IF was created. Final health,
container, network, volume and artifact checks passed. Exact before/after and
remote readback are retained in the operational audit directory.
