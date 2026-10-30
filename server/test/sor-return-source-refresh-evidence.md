# SOR source refresh evidence

Spec: `sor-return-source-refresh-spec.md`. Spec approval was not separately
obtained: this was an autonomous run under the user's repair instruction.
Exact source hashes, tool versions, and results are in
`sor-return-source-refresh-evidence.json`.

Reproduce from the repository root:

```sh
bash docker/run-sor-return-source-refresh-checks.sh
```

The runner captures the current live source without credentials, overlays only
the five files in `tools/sor-return-source-refresh-files.json`, and tests it in
the standard disposable Compose environment. Every test file gets a disposable
database clone. Teardown removes containers, volumes, networks, runtime copies,
coverage, and logs; both running and stopped-container listings and production
health are checked by the runner.

Final verification after the last implementation/test change:

- 14 files, 85 tests passed; 14 focused tests also passed on repetition.
- Test-file order shuffled deterministically with seed 248.
- Changed executable lines: 163/163 covered. New source-fingerprint and plan
  projection modules: 100% line coverage, 88.23% and 71.42% branch coverage.
- Five manual mutants killed: assigned work remains blocked, plan refresh is
  omitted, derived catalog refresh is omitted, completed-return handling is
  removed, and fingerprint key sorting is removed.
- Property-only mutation reruns killed the serialization mutant. The other
  four survived that narrow property and were caught by integration tests;
  the serialization property is not claimed to verify workflow behavior.
- Syntax checks passed for all five runtime files; zero new lint findings;
  zero secret findings. The two new JS modules passed TypeScript checkJs with
  strict=false. Existing JS modules were checked with syntax/lint and real
  integration tests rather than claiming full static typing.
- No dependency or lockfile changes. No external APIs were used in tests.

Acceptance mapping: the source-refresh integration file covers assigned item
and quantity changes, driver cargo, address changes, catalog definitions,
obsolete review, JSON round trips, delivery completion, retired lines, explicit
equipment removal, transactional rollback, recorded pickup, recorded travel,
concurrent driver start, completed returns, and stale editor cargo. Existing
SOR suites cover disabled flags, Admin policies/signatures, splits, billing
disposition, reference collisions, cancellation, independent return dates,
queue retries, lost-update prevention, and fleet/catalog lock ordering.

RED evidence: the first run failed eight of nine new scenarios. Additional
adversarial runs exposed completed-travel destination changes and two stale
source-line/removal cases before their fixes. One old lifecycle expectation was
changed explicitly to allow refreshing an existing billed/delivered return;
the no-historical-backfill assertion remains. An initially mislocated test edit
was corrected; final assertions and implementation ran together in the final
fresh verification above.

Existing unrelated baseline findings remain visible: the legacy Custom Order
harness fails on both the captured baseline and candidate with exactly
`The server-side TO feed must include open Custom Orders.` Its static regex
predates the live server's array-based type check. The existing `prefer-const`
warning at dispatch-custom-order-repository.js:718 is unchanged. Neither was
silently removed or repaired as part of this task. The full unrelated MBT and
browser suites were outside this focused server-side change; driver job
materialization and HTTP/admin behavior are exercised by the selected suite.

Operational repair preceded the general change. SOR00248-Return, its assigned
plan, and derived catalog were verified as item 10750 (S1932-7 / 7.8m), with
review cleared and assignment preserved. Before-state records are in
sor_configuration_audit and dispatch_plan_snapshot_history. Deployment and
post-release verification records are retained under
`server/deployments/sor-return-source-refresh-20261023`.

Released at 2026-10-23 19:27 UTC. The app is healthy, its configuration and
dependency containers are unchanged, and all 807 runtime source files match
the captured baseline plus the five validated changes. Normal worker
reconciliation drained both SOR00248 and the remaining obsolete SOR00225
warning. At 19:28 UTC, SOR00248's source, return, assigned plan, and canonical
catalog all contained item 10750, quantity 1; pickup readiness allowed it and
the original plan 367 / truck T1 / load assignment remained intact. Final
running and stopped-container checks showed only the four production
containers and no disposable test resources.
