# Shared Dispatch/BIN planner verification

This correction replaces the separate BIN planner with the actual Dispatch
planner at `/mbt/planning`: the same `dispatch.js`, `dispatch.css`, order-card
renderer, driver lanes, load controls, timing, maps, undo/redo, save queue and
confirmation flow. A BIN adapter supplies its orders, tabs and commands.
The Dispatch top bar contains the date-preserving BIN Planning link. Cross-mode
loads and truck switches show an explicit Read only label and grey background.

The [executable specification](bin-planner-reuse-spec.md) records the user's
requirements and subsequent clarifications. Detailed spec approval was not
separately obtained; implementation and deployment were already authorized.
The old-coder workflow was applied because this change uses shared edit leases,
transaction fences and driver publication. No dependencies or commits were added.

## Final verification

Fresh run: **27 September 2026, 06:59:18–07:05:30 UTC**. The verification entry
point exited 0 with zero unexpected failures. The broader Dispatch suite retains
its four previously classified failures; it is not entirely green.

| Check | Result |
| --- | --- |
| BIN feature suite, isolated PostgreSQL and real Chromium | 59/59 tests, 19 files |
| Existing BIN, driver and Front Desk compatibility | 155/155 tests, 37 files |
| Broader Dispatch selection | 228 passed, 4 known failures, 232 tests in 37 files |
| Retired-confirm repair | 11/11 tests |
| Feature suite in reverse file order | 59/59 tests |
| Nine backend `bin-planning-*` modules | 1,200/1,200 lines and statements; 90/90 functions; 684/739 branches (92.55%) |
| Randomized properties | Five properties, 1,000 cases each; seeds 9272026–9272028 and 20260927–20260928 |
| Manual mutation | 9/9 faults killed; 3 applicable validation faults also killed with only randomized property tests selected; 12 executions |
| Syntax, lint and scoped types | 11 syntax checks; zero lint errors and changed MBT type errors; 254 existing imported-graph diagnostics |
| Secret scan | 82 scoped files, zero unexpected findings; two exact reviewed false positives |

No tests were skipped or cancelled in the full selections above. The separate
property-only mutation invocations intentionally exclude the example test.
Mutation runs use disposable source copies and verify that original files remain
unchanged. The faults cover duplicates, ordinary-load protection, negative
timings, unnecessary restaging, timing loss, expired leases, invalid empty-draft
starts, abandoned event streams and premature return publication.

All 82 frozen source/test/tool files remained unchanged during the final run.
Their aggregate SHA-256 is
`6804a9574f594493c32ab3ebd7736d33132d503d11d07db79da476098a1b996e`.
This identifies the manifest scope, not the entire dirty checkout. This evidence
document is outside that manifest.

## Behavior and evidence

| Requirement | Executable evidence |
| --- | --- |
| Actual shared planner and pool; top-bar link; labelled grey context | `bin-planning-browser.test.js`, saved screenshots |
| Native card/whole-load drag, indivisible visit steps, + Load/+ Return, preview, undo/redo, search | Browser workflow and ordering properties |
| Dispatch calculation, Google estimates, overrides, start yard and lane order persist | Browser reload assertions, board integration and metadata validation tests |
| Atomic save, idempotency, current revisions, shared session lease | Board, commands, HTTP and race tests |
| Ordinary Dispatch saves with MBT disabled and zero MBT requests | Browser and disabled-MBT compatibility tests |
| Legacy fleet aliases preserve ordinary work | Two board integration regressions |
| Rapid date changes cannot restore an older date/feed | Controlled out-of-order real bootstrap requests in the browser |
| BIN returns publish only after confirmation, then require reconfirmation after edits | Return integration tests, real Dispatch HTTP handler and browser confirmation |
| Return origin uses the final BIN site's address | Return integration and browser driver-route assertions |
| Leaving a page during event authentication cannot leak a heartbeat | Blocked PostgreSQL session lookup and aborted real HTTP request |

The browser also checks a second session cannot edit the date, automatic load
inheritance, rejection of occupied-truck moves, completed-save journal cleanup,
confirmation status, zero page errors and axe assertions. It exercises the real
Express application and database. Only the external Google route-estimate
boundary is stubbed; its nonzero route durations pass through the real timing,
save and reload workflow. Screenshots were inspected for layout and read-only
presentation.

Observed failing checks drove fixes for computed metadata persistence, JSONB
comparison order, numeric fleet IDs, undo/redo after acknowledgements, stale date
responses, route-refresh saving, legacy truck aliases and return publication.
The abandoned-event request reproduced an orphaned 25-second heartbeat before
the response-close guard. Return checks failed with zero published driver jobs
after confirmation before release handling was added. An initial return test
assumed a distinct return stop type; it was corrected to Dispatch's existing
travel job with a `return-` stop ID and reproduced the same failure. The browser
then exposed the missing origin for canonical BIN stops; server-derived address
metadata now connects them to Dispatch's return calculation.

An early combined invocation put multiple fixture files into one database and
failed a driver-lane ordering assertion. The normal runner gives each file a
fresh database clone; both the final and reversed runs pass. No application rule
was weakened to accommodate that invocation.

## Reproduction and limits

From the repository root:

```sh
python3 server/tools/bin-planner-reuse-gauntlet.py
```

The runner reuses local image `mbbs-bin-planning-test:20260927`, PostgreSQL 18 and
the existing Playwright browser cache. Node 20.20.2, TypeScript 7.0.2, ESLint
10.8.0, c8 12.0.0, fast-check 4.9.0 and Playwright 1.62.1 are provided by that
existing tooling. Internal networks, read-only source mounts and disabled
external writes isolate tests from production. This requires the documented
local images/cache; it is not a fresh-machine bootstrap.

The four Dispatch failures match the exact names and completed-file counts
recorded in [prior evidence](mbt-bin-planning-evidence.md). That earlier comparison
was not a clean pre-task Git baseline. The full imported TypeScript graph still
has 254 diagnostics outside the changed MBT modules. Neither a clean project-wide
test suite nor a clean project-wide type check is claimed.

Coverage measures the nine backend planning modules, not all legacy changed
lines or browser branches. The browser is uninstrumented, axe color-contrast
checks are excluded, and no mobile matrix, external Google-provider integration,
load benchmark or exhaustive mutation campaign was run. Existing unrelated
worktree edits are preserved and excluded from the scoped deployment overlay.

Raw receipts:

- [Run summary and hashes](../test-artifacts/bin-planner-reuse/final/result.json)
- [Test counts](../test-artifacts/bin-planner-reuse/final/test-counts.json)
- [Coverage](../test-artifacts/mbt-bin-planning/checks/reuse-final-coverage/coverage/coverage-summary.json)
- [Mutations](../test-artifacts/bin-planner-reuse/mutations/results.json)
- [Pool screenshot](../test-artifacts/mbt-bin-planning/checks/reuse-final-coverage/bin-planning-pool-ui.png)
- [Shared planner screenshot](../test-artifacts/mbt-bin-planning/checks/reuse-final-coverage/bin-planning-shared-ui.png)

Final per-layer logs are in `test-artifacts/bin-planner-reuse/final/`. The earlier
passing run before the additional return regression is retained separately in
`test-artifacts/bin-planner-reuse/before-return-fix/`. It is superseded by the
final hash and results above. [Deployment receipts](bin-planner-reuse-deployment-evidence.md)
record the verified live release at 07:20 UTC.
