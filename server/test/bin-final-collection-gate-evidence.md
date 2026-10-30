# Final collection waiting state — evidence, 2026-10-23

Spec: [bin-final-collection-gate-spec.md](bin-final-collection-gate-spec.md).
Spec approval: not obtained (autonomous run). Tier 3 for assignment consistency
and preservation of existing plans. No dependencies, migrations or commits added.

Deployed `mbbs-operator-app:bin-final-collection-gate-20261023` over
`mbbs-operator-app:dispatch-sales-pickup-20261023`, preserving that concurrent
release. All seven runtime files match the validated candidate. Application
configuration and the other three production services were preserved; the prior
image is retained for rollback. Runtime manifest digest:
`8f3b3236cd90c944a764915f9e81ea4eab967b9c49b3a2cb1e84360481416c19`
(SHA-256 of sorted compact JSON sourceHashes in the validation record).

The final fresh run finished at `2026-10-23T20:26:38.683Z`: **351/351 tests in 82
BIN workflow/planning/cargo/driver files passed**, **7/7 focused tests passed in
reverse file order**, and **7/7 deliberate mutants were killed**. Three mutants
were independently killed by the property tests. Changed JavaScript coverage was
**56/56 mapped lines**, with **40/41 scoped branches** executed. Syntax checks
covered five JavaScript files. Strict types, lint, complexity and diff-secret
checks passed with zero new errors; the type baseline also had zero errors.
Two new property tests exercise 650 seeded cases. Real Chromium exercised native
dragging, computed color, searching, route editing, refresh and successful saving.

| Requirement | Executable evidence |
| --- | --- |
| Final Collection remains visible, light red and cannot be dragged while work remains | `bin-final-collection-browser.test.js`: visible card, computed RGB color, native drag, selected action and search; integration test covers an unconfigured Collection |
| All exchange legs must finish, including Collection/dump/return | `bin-final-collection.test.js`: replacement Delivery alone still blocks; completing Collection unlocks and preserves the exact replacement bin |
| Ignore other rentals and cancelled work; allow exchange Collection legs | Integration isolation/cancellation cases and generated status/reference properties |
| Reject direct, board and forged-history assignments atomically | Integration rejection cases compare the entire plan, visit revision and claims; guard-removal and client-history mutants fail |
| Route editing and customer-owned data survive | Integration dump-site edit preserves the bin and windows; Chromium opens the actual editable route popup; existing cargo/window regressions pass |
| Refresh eligibility when another job completes | Same-page Chromium refresh retains the lock after one completion, then removes the red state and permits a saved drag after both finish |
| Preserve older assignments and bin changes | Historical release fixture retains its release assertions; historical cross-date bin-selection test retains both-lease, rollback, bin identity and publication assertions |

RED evidence: after correcting a fixture's step/visit completion order, all four
new integration cases failed on missing holds/rejections and the new browser
case failed because dragging was allowed. Existing tests that expected immediate
Collection eligibility were explicitly revised in the spec for the new policy.
Historical plan setups use the existing low-level assignment primitive without
weakening their lease, rollback or execution assertions. Those tests exposed a
real interaction with bin re-selection's temporary withdraw/rebuild cycle. The
implementation now uses the original server-locked visit when rebuilding the same
plan; fabricated request history cannot bypass the new-assignment gate. A fixture
comparison also needed to preserve fast-check objects' prototypes. All these
changes preceded the final fresh run; no failing test was skipped.

The adversarial checks cover stale/direct submissions, forged prior assignments,
partial plan writes, incorrect status filtering and loss of the visible/drag lock.
There is no claim of exhaustive concurrency interleavings or branch coverage;
one scoped branch was not executed. The full unrelated application suite was not
run. Dependency/license audits and migration rollback rehearsal were inapplicable
because those inputs did not change. Existing historical low-level assignment
behavior remains intact; the hold is enforced by current MBT planning commands.

Live verification used a read-only transaction: **BIN00002C** remains tentative,
revision 5, unplanned, and waits for **BIN00002X-1C** and **BIN00002X-1D**.
Its dispatchable flag is false and Collection route editing remains enabled.
Origin HTTP routes, served JavaScript/CSS hashes and both cache keys match the
release. Authenticated browser behavior was verified in isolated Chromium;
public-edge authenticated browser access was not independently verified.

All runs used the standard bounded disposable runner under `mbbs-tests.slice`.
Containers, test databases, volumes, networks, logs, coverage and mutation copies
were removed automatically, including failed runs. Final `docker ps` and
`docker ps -a` show only the four production containers, all task test projects
have no remaining containers/volumes/networks, and application health passes.
Only concise source evidence and operational release/rollback records remain.

Reproduce from the repository root using the operational candidate and baseline:

```sh
DISPATCH_SOURCE_SKIP_BUILD=1 \
DISPATCH_SOURCE_RUNTIME="$PWD/server/deployments/bin-final-collection-gate-20261023/candidate" \
DISPATCH_SOURCE_MIGRATIONS="$PWD/server/deployments/bin-final-collection-gate-20261023/candidate/migrations" \
bash docker/run-bin-final-collection-checks.sh
```

The runner invokes persisted static, suite, mutation and changed-line coverage
tools. Release guards, rollback and source verification are in
`tools/bin-final-collection-release.py`; live order verification is in
`tools/bin-final-collection-live-check.mjs`.

Recorded toolchain: Node v20.20.2, TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0,
fast-check 4.9.0, Playwright 1.62.1 and pg 8.21.0.
