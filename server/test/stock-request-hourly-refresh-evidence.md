# Hourly linked pickup SO refresh — evidence

The user authorized an hourly shared refresh. Implementation spec approval was
not obtained (autonomous run); see [the specification](stock-request-hourly-refresh-spec.md).
Tier 3 covers background concurrency and local state changes. No new packages,
schema migrations or commits. Production NetSuite access is read-only.

Reproduce with `sudo -n bash docker/run-stock-request-hourly-checks.sh gauntlet`.
The runner captures live source, applies only this task's delta, and tests each
file on a fresh disposable PostgreSQL database inside `mbbs-tests.slice`.
Source hashes, pinned image identity and actual tool versions are recorded in
`server/deployments/stock-request-hourly-refresh-20261028/verified.json`.

Final fresh run: **59 passing tests, zero failures** across seven targeted files.
The 27 focused tests passed again after restoring mutants. The existing 29
regression tests also passed against the unchanged live baseline. Type diagnostics
are 2648 before/after; lint diagnostics 26 before/after; zero new diagnostics.
The existing unresolved browser import diagnostic is compared independently of
its cache-version query string. **203/203 changed executable lines executed**,
including actual app startup and browser code at 390px and 1440px.

| Requirement | Executable evidence | Result |
| --- | --- | --- |
| Exactly one-hour due gate across workers/restarts | Timestamp boundaries at 3599999/3600000 ms; simultaneous PostgreSQL session locks; failure then successful next run | Pass |
| Enabled/access and operational-sync guards | Disabled/busy worker tests; real bootstrap with direct access disabled | Pass |
| Non-delivery Special, Backorder and Regular pickup scope | Candidate controls for Delivery/cancellation; completed routing work still checked; shared SO deduplicated | Pass |
| Reference-only Backorder SO | Optional reference refreshed; manual case link/approval unchanged | Pass |
| Fulfillment correctness | 100 generated quantity examples, seed 20261028; partial/full/closed headers; fee/subtotal exclusion; missing/duplicate/malformed identities and canonical line mismatch rejection | Pass |
| Stale-response protection | Timestamp differing by one microsecond; revision, method, cancellation and link races | Pass |
| Local atomicity and preservation | Forced request-write failure rolls back header; commercial values and canonical packing lines unchanged; no invented PO arrival | Pass |
| Completion and display | Special becomes Completed/locked; Regular becomes Completed; partial stays active; desktop/mobile status and last-checked values safely escaped | Pass |
| Outages and observability | Failed order audited, next order proceeds; updates emitted only after successful persistence; lost lock prevents apply | Pass |

Manual mutation: **3/3 killed** (half-hour gate, partial treated as complete,
stale canonical timestamp ignored). The property suite alone kills 1/3;
PostgreSQL integration tests cover the other two. File shuffle seed 20261028.
All candidate hashes match after restoration. Toolchain: Node 20.20.2,
TypeScript 7.0.2, ESLint 10.8.0, fast-check 4.9.0, c8 12.0.0,
Playwright 1.62.1, pg 8.21.0.

Two real read-only NetSuite samples (SOM06894 and SOA10227) confirmed status,
line IDs, native quantities and NetSuite's zero-quantity synthetic subtotal
format before release. Early test fixture errors were corrected to match the
existing schema; tests then failed on missing behavior. Adversarial tests exposed
the incomplete-line completion risk, and that guard was added before release.

The full repository suite and version/performance matrices were not run: this
change uses the seven relevant suites on the shared application host. No dependency
audit was needed because dependencies are unchanged. Existing Special PO-arrival
completion rules remain in effect. Historical Regular routing-completion status
is preserved while its separate SO status continues refreshing until terminal.
The per-run cap is 200 unique SOs, processed serially in least-recent-attempt order.
Failures retain the last successful observation for the next hourly attempt.

Test teardown removes containers, disposable databases, networks and temporary
logs/source/coverage/browser artifacts; only concise evidence and operational
release/rollback records are retained. Deployment and final cleanup receipts are
recorded in the release directory.

Deployed at 2026-10-28 03:45 UTC as image
`sha256:838a1c9576413dee263e785f278f5988a089d49aa3ea279b24371811e05c2b4b`.
All nine deployed hashes match validation; app configuration and the three
dependency containers are unchanged. Health and public assets return 200.
The first automatic run began at 03:45:51 UTC and **checked/updated 17 SOs,
with zero failures and zero stale observations**. One SO was fully fulfilled.
The durable due time for the next run is 04:45:51 UTC. The read-only operational
check is reproducible with `server/tools/stock-request-hourly-live-check.mjs`
through stdin in the live app; its receipt is `first-run-result.json`.

Final cleanup verified both `docker ps` and `docker ps -a`: only the four
production containers remain, with healthy app/database/AI services. This task
has zero remaining test containers, volumes, networks or temporary run
directories. Raw test reports were removed; the validation gate, release,
first-run and cleanup receipts remain as operational audit records.
