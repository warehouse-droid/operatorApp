# SCM stock-check revisions — evidence

The live fix lets SCM explicitly revise a declined Special Request stock check.
Saving that response reopens the line for customer confirmation. Declined and
closed lines no longer hold an otherwise replied Special Request in New enquiry.

Tier: 3. Spec approval: **not obtained (autonomous run)**. The user authorized
the fix and explicitly approved reopening revised declines, but did not review
the complete [specification](special-stock-check-editing-20261009-spec.md) before
implementation. This limits the independent review behind this evidence.

## Reproduction and source state

From `/home/ubuntu/apps/operatorApp`, run:

```sh
python3 server/tools/special-stock-check-editing-20261009/run.py final
```

The runner requires Docker access and the existing cached test image
`sha256:e0051d1aa1c279a31eaf8c958301fd9ee80e5be77564883b1c3c346983272fd9`.
It uses the standard isolated Compose configuration, registers teardown before
creation, and removes its containers, databases, volumes and networks on exit.
It never uses production credentials or production data in test containers.
`run.py baseline` can independently reconstruct the captured pre-change source.
The persisted baseline result is also available in the task's tooling directory.

The final run's source hashes and complete failure names are in
[summary.json](../test-artifacts/special-stock-check-editing-20261009/summary.json).
No commit was made: the repository already contained unrelated edits. The live
release uses only the four files in
[files.json](../tools/special-stock-check-editing-20261009/files.json), overlaid
on the previously deployed image. Its exact diff is
[task.patch](../deployments/special-stock-check-editing-20261009/task.patch).

Recorded tools: Node 20.20.2, TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0,
fast-check 4.9.0 and Playwright 1.62.1. No packages were installed, and no
application dependencies or lockfiles changed.

## Spec to test mapping

Tests below are in `server/test/mbt/integration/` unless indicated otherwise.

| Spec behavior or invariant | Verification | Result |
| --- | --- | --- |
| Ten replied lines plus an unanswered declined fee await confirmation in detail, SQL, filters and Sales alerts | HTTP: `replied active lines plus an unanswered declined pallet fee await customer confirmation in API, SQL, filters and alerts` | Pass |
| Unanswered open lines and requested updates still need a reply | HTTP: `property: JavaScript and SQL stages agree when declined/closed lines are unanswered but open lines need a reply` | Pass; 50 examples, seed 20261009 |
| Explicit revision edits supply status, ETA and reply; failed saves retain inputs | Browser: `SCM can explicitly revise a declined line, retains edits on failure and saves its new status for customer confirmation` | Pass |
| Revised decline becomes pending, clears old metadata, records actor/reason and preserves other lines including quantities/prices | HTTP: `SCM revised decline becomes pending, clears decline metadata, preserves other lines and records actor and previous reason` | Pass |
| Unselected declines remain declined; abandoning an unsaved revision writes nothing | Browser: `saving another stock check leaves an untouched decline excluded from the batch`; `leaving an unsaved decline revision submits nothing and returning requires a fresh explicit revision` | Pass |
| SCM-only writes; anonymous and Sales requests write nothing | HTTP: `Sales and unauthenticated callers cannot revise a declined stock check` | Pass; 403/401 |
| Closed lines cannot reopen; closed/pending-information/order/skipped/busy locks apply | HTTP: `closed lines cannot be reopened by a crafted SCM response`; `closed, pending-information, linked/skipped-order and busy cases cannot reopen a decline`; browser locked-state test | Pass; 409 and unchanged snapshots |
| Invalid batch writes roll back stock, decision, revision and audit together | HTTP: `invalid batch after a declined-line revision rolls back the reopened decision, stock and audit` | Pass |
| Concurrent revisions have exactly one winner and one reopen audit | HTTP: `concurrent SCM revisions of a decline allow exactly one save and one reopen event` | Pass; one 200, one 409 |
| Backorder behavior remains intact | `backorder-workflow.test.js`, `backorder-routing.property.test.js`, `backorder-already-ordered.test.js` | Pass; 16 tests |
| Accepted-line readiness and unrelated order workflows remain intact | Existing Special suite plus manual task-diff review; accepted readiness branch unchanged | No new failures; existing integration failures limit verification |
| No new dependencies or NetSuite writes | Dependency/capability diff review; tests disable direct NetSuite access; live verification reads existing records | Pass within this task's scope |
| Isolated four-file release, rollback preserved, correct live request stage, no fabricated supply/customer decision | Candidate hash/import checks and `deploy.py verify`; release manifest and live record | Pass |
| Remove every disposable test resource and preserve production health | Runner teardown, image-check `finally`, final Docker inspection | Pass |

## Final fresh gauntlet

All test figures below come from the final `run.py final` execution after the
last application edit. Deployment-harness formatting/hash normalization was
adjusted afterward; application files retained the verified hashes.

| Layer | Actual result |
| --- | --- |
| Focused HTTP/browser tests | 12 passed, 0 failed, 0 skipped |
| Reverse file execution | 12 passed, 0 failed |
| Backorder checks | 16 passed, 0 failed |
| Coverage run | 12 passed; 39/39 changed executable JavaScript lines executed |
| Server branch records intersecting changed code | 13/14 covered; blank previous-reason fallback uncovered |
| Restored source after mutations/regression | 12 passed, 0 failed |
| Full affected Special suite | 952 tests: 851 passed, 101 failed; baseline also 851/101 with the same failure names; **0 new failures** |
| Type comparison | 8,122 existing diagnostics before and after; 0 new diagnostics |
| Runtime lint comparison | 0 new diagnostics; new tests/check scripts pass lint |
| JavaScript syntax | Both changed scripts pass |
| Manual mutation | 7/7 actual bugs detected |
| Property-only mutation | JavaScript and SQL stage mutants both detected by the property test alone |
| Secret scan | Pass on runtime files, tests and gauntlet runner |
| Candidate execution | Exact source hashes verified; real server module imports |
| Live execution | Healthy; SPREQ-000063 awaits customer confirmation in repository, SQL view and filtered SCM queue |

The seven mutants respectively count declines as unanswered, retain the decline
after a revised reply, retain stale restore metadata, save untouched declines,
retain abandoned revision selection, grant Sales the SCM role, and restore the
old SQL stage calculation. Their logs and selection code are persisted in
[check.mjs](../tools/special-stock-check-editing-20261009/check.mjs).
The property checks verify stage calculations; they do not claim to verify the
five unrelated mutation behaviors.

Browser tests run the real page and scripts with mocked API boundaries. The
HTTP tests separately run the real authenticated endpoint against PostgreSQL.
The [screenshot](../test-artifacts/special-stock-check-editing-20261009/browser/revised-declined-stock-check.png)
was inspected. File-order reversal and repeated focused runs passed; randomized
ordering of the entire broader suite was not performed.

## Deployment and cleanup

Candidate image: `sha256:15ddb601d9bad60997d36f40533d3d8603e6adb8f36a9b026674bec0cb90787a`.
Only migration 276 was applied, transactionally with a five-second lock timeout.
It replaces a view and does not update business rows. The app was recreated;
database, worker and Ollama image/config hashes remain unchanged. The previous
image and SQL view are retained in
[the release directory](../deployments/special-stock-check-editing-20261009/).

[live.json](../test-artifacts/special-stock-check-editing-20261009/live.json)
records SPREQ-000063 at revision 14 with 11 lines, both stage calculations
`await_customer_confirmation`, inclusion in the confirmation queue, and no
linked SO/PO. Line 130 remains declined with no invented stock response; SCM's
explicit revised save will reopen it.

`cleanup-final.json`, `cleanup-images.json` and
[cleanup-completion.json](../test-artifacts/special-stock-check-editing-20261009/cleanup-completion.json)
confirm no task containers, networks or database volumes remain. Both
`docker ps` and `docker ps -a` contain only the four production containers, and
production health passes. Test logs, source coverage and rollback records are
retained; test databases are removed.

## Honest limitations and resolved failures

- Original behavior failed 8 of 11 initial tests. A later abandonment scenario
  brought the focused suite to 12. Initial fixture/setup errors were corrected
  without weakening behavior assertions.
- UI lock alignment initially missed manual/skipped POs; the existing shared
  case-edit helper now governs declined revisions in both UI and backend.
- One mutation selector initially matched two reset statements; it was made
  unique. Removing only the endpoint SCM check did not bypass the shared SCM
  middleware, so that mutation was replaced with an actual unauthorized-role
  grant. The final seven mutants all represent observable bugs and are killed.
- Preparation first rejected harmless SQL indentation differences. The captured
  definitions matched after trimming line indentation; initial artifacts remain.
- The first deployment verification rejected reordered mount bindings and
  automatically restored the prior image and view. Reordering the live binding
  list reproduced the original full configuration hash exactly, proving this
  was the only difference. The check now sorts binding lists, and the successful
  retry preserves the original configuration. Initial publish/rollback logs
  and the hash diagnosis remain available.
- The 101 broader failures and 8,122 type diagnostics predate this patch.
  They are surfaced rather than repaired outside scope. The full repository
  suite was not run; verification covers the affected Special suite and the
  selected Backorder checks.
- No new latency budget or cross-platform support was specified; no benchmarks
  or platform matrix were run. Dependency/license audits were not rerun because
  dependencies did not change. Blank decline-reason branch coverage remains
  a known gap. Live customer decisions and stock availability were not altered
  solely to exercise the new save behavior.
