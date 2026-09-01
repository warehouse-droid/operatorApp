# PO/TO Schedule loading performance evidence

Status: deployed and verified on 2026-08-28 UTC.

## Acceptance result

- The normal `SCM Working` load omits effective Completed jobs.
- Completed history remains available when the user selects the `Completed`
  status, including a mixed status selection.
- The production target is less than 2,000 ms for both paths. The deployed
  normal view measured 862.7 ms maximum and the much larger explicit Completed
  view measured 1,057.9 ms maximum over five samples each.

## Test-first evidence

The executable scenarios were written in
`test/dispatch/integration/scm-schedule-loading-performance.red.test.js`
before the implementation. Running that suite against the prior repository
failed on the new Completed-default, compact-assignment, snapshot-independence,
and bounded-query requirements. The implementation began only after that RED
result was captured.

Final clean-database verification:

| Gate | Result |
| --- | --- |
| Focused SCM loading specification | 7/7 pass |
| Synthetic 1,000-plan-date scenario | 427.9 ms, below 2,000 ms |
| Critical coverage probes | 7/7 covered |
| Task mutation tests | 5/5 mutants killed |
| Authoritative SCM status compatibility | 44/44 pass |
| Phased PO split compatibility | 56/56 pass |
| Split receipt allocation compatibility | 15/15 pass |
| PO route residual compatibility | 39/39 pass |
| Planner optimization compatibility | 73/73 pass |
| Full isolated repository regression | 428 files, 2,100 tests, all pass |
| Migration upgrade and idempotency | pass through migration 188 |
| ESLint, legacy syntax, and TypeScript | pass with zero warnings/errors |
| Dependency tree and license policy | pass; 396 packages checked |
| Changed-line secret scan | pass; no high-confidence findings |

The enforced clean-database benchmark also passed with a 23.7 ms p95. The
production-data result below is the release acceptance measurement because it
exercises the real row and reconciliation volume.

## Implemented read path

- `listScmSchedule` treats Completed as an explicit opt-in unless the Completed
  view itself is selected.
- Planned status and route metadata are read from
  `dispatch_plan_order_assignments`; schedule loading no longer searches
  accumulated `dispatch_plan_snapshots` JSON.
- The projection records order kind, ETA, driver, truck, load, and parking data;
  cancelled plans are excluded.
- Closed PO/TO families are materialized once per request instead of evaluated
  with a correlated predicate for every visible row.
- Vendor-yard lookup uses indexed, materialized identity/name branches, and PO
  line detail lookup is set-based.
- Migration 188 adds four targeted indexes and invalidates only the compact
  projection marker so startup can rebuild it. Historical snapshots are not
  changed.

The broad regression also exposed an existing queued-webhook notification seam:
the serial worker retained the Smart SCM history event, but the application
handoff dropped it. That event is now preserved and its existing focused test
passes. Webhook processing remains serial at concurrency one.

## Production deployment

Pre-deployment state:

- Database latest migration: `187_dispatch_date_switch_lookup_indexes.sql`.
- Assignment projection: 1,231 rows; table size 7,272 kB.
- Historical snapshot table: 69 MB.
- Catalog state: ready.

Release artifacts:

| Service | Deployed image ID | Release tag |
| --- | --- | --- |
| app | `sha256:d0d89debfbe60799dcdb3e5985c91f1efb7bf969e451cca2de29672b93ad17c5` | `scm-schedule-loading-20260828T073625Z` |
| webhook worker | `sha256:6e1c0896c72dc9f056b5518f3b00a11b06f6ebf1bf7465cd41abff5792fbaa1f` | `scm-schedule-loading-20260828T073625Z` |

Rollback artifacts preserve the exact images that were running before this
deployment:

- app image `sha256:a2fd8b707c73e71b67306275403a9ed93c5d6220ae4955acb1ee55f265a17abf`,
  tag `pre-scm-schedule-loading-20260828T073625Z`;
- worker image `sha256:a09c7bc8d08c4299cec80bcda59b68e9224e795018cc0a798b0e21cb22cb4976`,
  tag `pre-scm-schedule-loading-20260828T073625Z`.

Migration `188_scm_schedule_loading_read_path.sql` was applied at
2026-08-28 07:38:31 UTC. All four expected indexes exist. Application startup
reported `ready=true`, 66 plans projected, and zero remaining. The Dispatch
catalog then reported ready with assignments ready; the SCM PO catalog also
reported ready.

The localhost health endpoint returned
`{"ok":true,"app":"MBBS Yard Server"}`. The webhook worker started in serial
mode, and its queue was unpaused with zero queued, running, or failed jobs.

## Production timing

Each result includes the complete repository list and reconciliation enrichment
used by the PO/TO Schedule response. One warm-up preceded five measured samples.

| Selected status | Rows | Total samples (ms) | p95 / max | Result |
| --- | ---: | --- | ---: | --- |
| default, no Completed opt-in | 111 | 827.8, 761.6, 758.5, 757.3, 862.7 | 862.7 ms | pass |
| Completed explicitly selected | 987 | 1,034.0, 1,044.3, 1,057.9, 1,003.4, 993.4 | 1,057.9 ms | pass |

An immediate post-deploy resource sample reported app CPU 0.47%, PostgreSQL CPU
0.47%, webhook-worker CPU 0.32%, and Ollama CPU 0.00%. App and database
containers were healthy, and the application/worker logs contained no startup
errors.

## Follow-up — fully split PO source visibility (2026-08-28 UTC)

Production witness `POB03774` had seven active source lines and two active split
children whose allocations exhausted every measurable source quantity. The
normal PO/TO Schedule nevertheless returned a zero-pallet, zero-weight source
row. The user required a failing reproduction before implementation.

The expanded
`test/dispatch/integration/scm-po-split-schedule-remaining.test.js` first failed
with `a source PO with no quantity remaining after active splits must be hidden`
(`true !== false`). It now proves all four transitions: partial split leaves the
exact residual, full split hides the source, cancelling one split restores only
that quantity, and cancelling all splits restores the full source.

The first full gauntlet intentionally blocked release because the initial query
also hid an active open PO whose mirror had no line rows. The existing
closed-order compatibility harness was the RED witness. The rule was narrowed:
only a PO with actual source-line evidence and zero residual is hidden; a
line-less open PO remains visible because missing evidence cannot prove full
allocation.

The final fresh isolated gauntlet completed successfully:

| Gate | Result |
| --- | --- |
| Focused schedule specification | 8/8 pass |
| Changed-path coverage probes | 8/8 executed |
| Authoritative schedule/completion compatibility | 44/44 pass |
| Phased split / receipt / route residual | 56/56, 15/15, 39/39 pass |
| Planner optimization | 73/73 pass |
| Open/closed PO compatibility | pass |
| Full isolated repository regression | 428 files, 2,100 tests, all pass |
| Migration upgrade and idempotency | pass through migration 189 |
| ESLint, legacy syntax, TypeScript | pass with zero errors/warnings |
| Manual mutation | 7/7 killed, including both new residual failure modes |
| Clean-database benchmark | 24.4 ms p95, below 2,000 ms |
| Dependency license policy | 396 packages checked; baseline exception unchanged |
| Changed-line secret scan | pass; no high-confidence findings |

Deployment was app-only. The previous healthy image is retained as
`mbbs-operator-app-app:pre-po-schedule-residual-20260828T172313Z`
(`sha256:eb477e3a2b8ef44960049557dbaf9fc95ed4d9a71df8e8f7e3bc9ee36b69ff24`).
The released app image is
`sha256:56912a8c2e3ff8e2565ad6c79ca470859c437a24bb63bdacaf693d4d990373ef`.
Container recreation took 1.89 seconds; `/health` returned 200 and the app was
healthy. PostgreSQL remained online and the webhook worker retained its
2026-08-28T15:54:46Z start time and image
`sha256:561ed980096ca2738d894cfe37b4dd5f5c447c274a15d348a13a285e65a44596`.

The deployed repository returned no `POB03774` source in either active or
Completed views. Split child `SN1399024` remained in Completed with 4 pallets;
`SN1399025` remained active on Hold with 8 pallets. No PO, split, receipt, or
schedule source data was rewritten by this code deployment.

The same read-only audit resolved the user's two VRMA spellings to
`RP-UNI-AYR-0810-2` and `RP-TH-PUTNAM-0826-1`. Both remain Planned because
neither identity has a canonical completion event or an exact Driver-PWA job,
manifest, offline event, correction, or photo. A completed custom order near
the Putnam request has no durable link to that VRMA and materially different
quantity/weight evidence, so it was not used to manufacture completion.
