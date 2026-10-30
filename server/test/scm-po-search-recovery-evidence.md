# PO Split search, loading, and refresh recovery — 2026-10-29

Deployed at 22:17 UTC. Spec approval: not obtained (autonomous run).
Tier 3 applies to worker concurrency. See [acceptance spec](scm-po-search-recovery-spec.md).

POB04160's refresh job 4198 had remained `running` since 16:37 UTC. Enqueue
deduplicated against it, while the worker only claimed pending/failed jobs.
The original interruption's cause is not established. PO/TO visibility also
depends on status and role filters; its earlier Hold status must not be confused
with the catalog refresh failure.

The worker now reclaims abandoned claims after five minutes, fences every claim
with its database timestamp, and holds its row lock while publishing the refresh
and completion in one transaction. Queries restrict linked-order work, decode
plan metadata once, and avoid repeated history and status calculations. No TTL
cache, new dependency, migration, or order-editing action was introduced.

## Final verification

Run `bash docker/run-scm-po-search-checks.sh node tools/scm-po-search-checks.mjs`.
The runner creates a bounded disposable environment, compares the original and
candidate on separate fresh databases, restores mutations, and removes its
containers, storage, networks, logs, coverage, and source copies.

| Layer | Final result |
| --- | --- |
| Affected SCM suites | 269 tests: 243 passed, 26 failures identical to the unchanged baseline; zero new failures |
| Focused recovery/adversarial contracts | All 8 passed in the affected run and restored run |
| Manual mutation | 6/6 killed by behavioral assertions; source hashes restored |
| Reordered regression run | 17/17 passed |
| Changed-line coverage | 187/187 mapped changed lines reached: server 5, dispatch 125, catalog 57 |
| Syntax | All three runtime files passed |
| Scoped TypeScript check | 4,503 baseline diagnostics, 4,500 candidate; zero new diagnostics |
| Scoped ESLint correctness rules | One existing undefined-name error in both versions; zero new errors |
| Property checks | Queue ownership: seed 4160, 8 generated cases, 3 concurrent workers; existing status properties also exercised |

The unchanged failures are captured verbatim in the operational
[check report](../deployments/scm-po-search-20261029/checks.json): one historical
linked-PO replay assertion, one POB03658 execution-lock assertion, and 24 TO
linking/packing protection assertions. They were not removed or weakened.

Acceptance mapping: focused tests cover abandoned/recent claims, superseded
workers, active row locks, concurrent enqueue, rollback/retry, exclusive claims,
the real application's success/failure tick, unrelated allocation query plans,
and numeric versus string Driver references. Existing SCM suites cover split
status parity, aliases, restrictions, pagination, completion, direct shipping,
planning, cancellation, and browser schedule search. The malformed numeric
reference initially produced In Transit incorrectly; its regression now passes
and kills removal of the JSON membership guard.

Property-only mutation runs killed 1/6 mutations. The ownership generator does
not independently cover fencing, active-lock lifetime, query scope, or Driver
reference typing; their dedicated integration tests supply those checks.
Coverage measures JavaScript statements, including executed SQL strings, not
individual SQL branches. Types use `--noResolve`; lint uses the runner's scoped
correctness rules. Full unrelated repository suites and a separate formatter
were not run. Manual diff review found no added runtime network/environment/file
capabilities or credentials. The installed Node version was v20.20.2; tool
dependencies remain locked by the existing package lock.

During verification, shared fixtures initially contaminated the second run and
dropping the large public schema exceeded PostgreSQL's lock budget. The runner
now recreates only its explicitly guarded disposable database between versions.
The final results above are from the resulting fresh run after all runtime edits.

## Live correctness and timing

Run `python3 server/tools/scm-po-search-live-check.py --record`, then the same
command with `--extended --record`. Comparisons use one repeatable-read,
read-only production snapshot. Before release, all 1,508 catalog entries over
eight pages and both schedule queries exactly matched the original JSON results.
Exact, partial, vendor, restricted, empty, detail, and cursor results were checked.

After deployment, run those commands with `--post`, and run
`python3 server/tools/scm-po-search-live-check.py --recovery --record`.

| Live operation after deployment | Five repeated server timings |
| --- | --- |
| PO Split exact POB04160 search | 113–135 ms |
| PO Split initial 200-order list | 681–779 ms |
| PO/TO POB04160 search | 610–633 ms |
| PO/TO default schedule load | 436–472 ms |

Selected PO detail took 106–120 ms. These repository timings include status
hydration; browser rendering, authentication, network latency, and extra split
editor requests are not included. The sub-second gate applies to the initial
list and sampled searches, not every possible filter or page under all loads;
one pre-release later catalog page took 1,122 ms during the broader comparison.

All four abandoned jobs (1718, 2677, 4197, 4198) completed after deployment.
The full refresh rebuilt the current eligible catalog to 1,364 entries; the
post-release scan compared every entry across seven pages. POB04160 appears in
both views as Queued / Vendor. Detailed timings and recovery evidence are in
`server/deployments/scm-po-search-20261029/`.

## Release and cleanup

`python3 server/tools/scm-po-search-deploy.py prepare|apply|verify` builds only the
three-file task diff on the live image and checks source hashes, configuration,
health, mounts, and unchanged dependency container IDs. Rollback is automatic if
cutover verification fails. The captured effective Compose configuration avoids
references to already-retired historical deployment files.

Released image: `sha256:ff7a7054e01e2f88f9c38ef214fa9576a17aeefb9377121480f7ca332f43d872`.
The [manifest](../deployments/scm-po-search-20261029/manifest.json) records source
hashes and the original image. Unrelated workspace server changes were excluded.
Production health returned `ok: true`; both `docker ps` and `docker ps -a`
contained exactly the four allowlisted production containers after cleanup.
Production volumes were not modified by test cleanup. Only source documentation
and operational release/rollback records were retained.
