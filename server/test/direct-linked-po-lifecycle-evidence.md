# Direct-linked PO lifecycle verification

The follow-up patch was deployed with the waitlist enhancements on October 2,
2026 at 16:28 UTC. The user authorized “deploy with shortover with the waitlist
change as well”, superseding the earlier hold. The fresh live-source overlay
contains exactly 15 intended runtime files; every scoped file retains its
previously tested hash. The combined candidate passed 118 PO/TO tests and 63
waitlist tests, plus the same 63 waitlist tests in shuffled order.

The [release result](../deployments/po-status-waitlist-20261002/result.json) records
the live statuses below, complete source-tree verification, healthy local/public
endpoints, six verified waitlist assets and three protected API routes. The
[cutover record](../deployments/po-status-waitlist-20261002/cutover.json) reports
8.849 seconds of observed interruption and readiness after 11.709 seconds.
The app configuration and worker, database and Ollama containers were preserved.
The earlier [read-only hold check](../deployments/direct-linked-po-lifecycle-20261002/live-unchanged.json)
is retained as historical evidence.

The original bug counted unlinked PALLET deposits and Split Pallet Fee as
unfinished freight and did not propagate linked SO pickup progress. The user
confirmed excluding both charges and retaining Partially Done for unfinished
product quantities. Standalone spec approval was not obtained (autonomous run);
the behavior rules were confirmed in the conversation.

The isolated replay and live checks agree:

| Order | Verified status | Completion date |
| --- | --- | --- |
| LOINC-033146 | Completed | September 14, 2026 |
| LOINC-035332 | Completed | October 1, 2026 |
| PO#B03964 | In Transit | Delivery remains pending |

No quantities, links, mirrored order headers or Driver history change in the
replay. No receipt job is created for the two historical repairs. The migration
bounds historical repair to their exact IDs and references, retains the real
Driver timestamp, and passes rollback and repeat-application checks.

Migration 256 also checked unchanged live order headers, line quantities, links,
Driver evidence and receipt jobs inside its transaction. No receipt jobs were
admitted for these repairs. A live rollback rehearsal passed before cutover.
The first release guard compared millisecond fixture timestamps with PostgreSQL
microsecond timestamps and rejected the transaction without deploying or
committing the repair. The corrected guard compares the immutable completion
directly with Driver records 3628 and 5398, retaining their exact timestamps.
The initial failed guard and rollback-rehearsal evidence are preserved in the
combined release folder. The initial image build used an unsupported bare image
ID in Dockerfile FROM; it was corrected to a verified local parent tag before
deployment. Both build attempts are retained.

Run from `server` using the existing isolated runner:

```sh
python3 tools/direct-linked-po-lifecycle-gauntlet.py
```

This command uses only `mbbs-special-review-runner`, the isolated database
container and the task-owned `direct_linked_po_lifecycle_20261002` database.
External NetSuite access is disabled. No dependency was added and no Git commit
was created. Test dependencies are pinned in package-lock.json.

Final verification after the last implementation and test edit:

| Layer | Result |
| --- | --- |
| Full affected workflow suites | 118 passed, 0 failed, 0 skipped |
| Reversed file order with per-file database isolation | 118 passed |
| Quantity properties | 20 generated amounts, 80 balance scenarios |
| Deliberate regression mutations | 6/6 rejected; bounds and posting mutations also rejected by the property suite alone |
| Changed JavaScript executable lines | 55/55 executed |
| JavaScript syntax | Passed for both changed repositories |
| Test lint | Passed with 0 warnings |
| Captured-order replay and real PostgreSQL execution | Passed |
| Migration rollback, idempotence and retained source data | Passed |
| Scoped patch credential-pattern scan | Passed |

Acceptance scenarios map to named tests in
`test/dispatch/integration/direct-linked-po-lifecycle.test.js` and the captured
replay in `test/dispatch/integration/direct-linked-po-replay.test.js`. Existing
PO/TO route, split isolation, reconciliation, authenticated schedule API, saved
filters and UI suites provide regression checks. Exact commands, logs, mutation
records, coverage and source hashes are persisted in the deployment review folder.

The reversed shared-fixture attempt exposed an existing TO test that commits an
unindexed plan. The unchanged source reproduces “Dispatch assignment index is
still warming up”. Per-file isolation follows the repository test runner and
resolves the fixture contamination without weakening assertions. Initial replay
setup omitted load IDs; the sanitized fixture was corrected to retain the actual
load IDs. Test helper arguments were corrected to use exactRefs and view=completed;
behavior assertions were retained. Lint formatting and the mutation harness's
argument-size limit were corrected before the final run.

Limits: verification covers the affected workflow suites, not every unrelated
MBT module. The large repository files are outside the project's static type-check
configuration; PostgreSQL validates the new SQL types through real execution.
PostgreSQL line instrumentation is unavailable, so SQL behaviors are verified by
queries, replays, rollback and mutations rather than a SQL line coverage number.
Supply-chain audit was unnecessary because dependencies did not change. Live
deployment and the two bounded repairs passed their checks. External receipt
posting and production-load benchmarks were not run. This is a scoped verification result, not a guarantee about all
future source-data changes.
