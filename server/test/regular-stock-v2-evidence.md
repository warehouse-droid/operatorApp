# Regular stock request v2 — implementation evidence

Implementation authorized by “Implement the plan”; requirements are recorded in [the executable specification](regular-stock-v2-spec.md). Verification tier: 3, using the [old-coder skill](/home/ubuntu/.codex/skills/old-coder/SKILL.md).

Implementation checks below were performed locally without production changes. Following the user's explicit “deploy” instruction, migration 239 and the scoped app/worker release were deployed on 2026-09-29. See [deployment evidence](../deployments/regular-stock-v2-20260929/README.md). No live NetSuite test order was created.

Follow-up: the reported SOB121631 header issue and PALLET/discount/subtotal/delivery-fee rules were corrected in the [subsequent one-file release](../deployments/regular-stock-line-routing-20260929/README.md). Its [fresh evidence](regular-stock-header-evidence.md) supersedes the adapter's original source hash below; the remaining v2 runtime files were preserved.

## Result

Final fresh run on 2026-09-29, after the last runtime and test edit:

| Layer | Result |
| --- | --- |
| New regular-stock, legacy stock-request and neighboring SCM suites | **149 passed; 0 new failures**; 2 known fixture-dependent harness failures |
| Same files executed individually in reverse order | **149 passed; 0 new failures**; same 2 known failures |
| Browser against the real app and PostgreSQL | **10 scenarios passed; 0 page errors** |
| Executable added/changed JavaScript lines | **934/934 covered**; no missing files |
| Branches whose start is in changed code | **730/837 covered**; branch gaps remain visible in the report |
| Mutation testing | **5/5 killed** by combined unit/property tests and **5/5 killed by properties alone**; clean restoration passed |
| Property testing | 850 generated cases per run, seed `29673445`, plus explicit boundary/DST cases |
| Syntax, lint and types | 22 runtime JS files checked; **0 new diagnostics**; 85 unchanged legacy diagnostics; strict parser/domain types passed; test/tool lint passed |
| Migration | Upgrade from legacy defaults and transactional rollback passed against isolated PostgreSQL |
| Secrets / dependencies | 0 findings in task runtime additions; no dependency changes |

Coverage merges Node execution, the server exercised by Playwright, and browser coverage captured before navigation discards earlier scripts. It measures only this task's additions in [the captured patch](regular-stock-v2.changes.patch). Blank, comment-only and delimiter-only lines are separately recorded, not counted as executable statements. The repository-wide MBT percentage is not used as a substitute for changed-line coverage. Full branch coverage is not claimed.

Runtime source-tree SHA-256: `aed214fdc956e94b78d3b4609868895419be08d411d2adf9465b14667f6bee4f`.
The file hashes are in `test-artifacts/regular-stock-v2/source-manifest.json`; the 30-file runtime scope is [listed here](../tools/regular-stock-v2-files.json). Existing unrelated worktree changes were preserved. No checkpoint commits were created.

## Acceptance mapping

| Behavior / failure mode | Evidence |
| --- | --- |
| Optional customer, mandatory method and two arrival fields; Toronto normalization and DST rejection | `regular-stock-domain.test.js`, `regular-stock-request.test.js`, `regular-stock-http.test.js`, browser form/edit/invalid-date scenarios |
| Available minus aggregated demand must be at least safety; configurable lead time, exact 200/201 and five-hour boundaries | Domain, service and property suites; safety/lead/duplicate-demand mutants; browser settings save |
| Safety evidence per SCM line; original approval retained; no new local holds | Service and handoff suites; browser verifies 800 safety and 799 remaining |
| Per-line stock/PO/reject decisions, rejection reason, closed all-rejected case, revisions and concurrent decisions | Service and HTTP suites |
| Whole-SO routing, exact material identities/quantities/customer/yard, ambiguous rows and split rows | Domain, NetSuite adapter and property suites; browser clears stale SO choices |
| Real SO location PATCH, order mirroring, TO confirmation and canonical SO dependency allocation | `regular-stock-external-workflow.test.js` uses real application, adapter, confirmation and repository code; only HTTP transport is intercepted |
| Retry after partial external success, no duplicate transfers, worker exclusion despite expired lease, printer failure independent of commitment | Handoff and external-workflow suites; real dependency link survives retry and partial-backorder allocation |
| Preferred gap calculated after commitment, inbound counted once, 301 EA rather than 400 EA, placed PO immutable | Handoff and replenishment suites |
| One shared item/source group, separate pinned loads, paused planning bypass, vendor children, residual later demand, zero-gap visibility | Replenishment suite and browser priority-load scenario |
| Carry through subsequent runs and both planning phases until explicit Release; release/rebuild race | Replenishment concurrency and two-phase tests; browser Release action |
| Missing policy blocks order requests, no material substitution in priority loads, no replenishment before every TO commits | Replenishment guard tests |
| SCM review alert; requester-only unread Sales decisions; bounded acknowledgements and session clearing | HTTP/service tests and browser alert/deep-link/logout scenarios |
| English/Chinese, mobile SO entry, input/focus retained during redraws | Browser scenarios and screenshots |
| Legacy/special compatibility and database upgrade | Existing `test:stock-requests` suite, neighboring SCM harnesses, migration test |

New tests are under `test/mbt/{unit,integration,property}/regular-stock*`. Browser assertions and the five actual mutation operators are persisted in [the browser runner](../tools/regular-stock-v2-browser.mjs) and [mutation runner](../tools/regular-stock-v2-mutations.mjs).

## Reproduce

From the repository root with Docker access:

```sh
sudo python3 server/tools/regular-stock-v2-gauntlet.py
```

The entry point builds the pinned test images, starts the dedicated `mbbs-regular-v2` tmpfs PostgreSQL project, applies migrations only there, and runs every layer. It mounts the current code read-only. NetSuite credentials and external execution are disabled in the test environment. The external-workflow tests reject every unexpected network destination and use only a fake `.invalid` host at the transport boundary.

The final run used the existing isolated containers:

```sh
sudo python3 server/tools/regular-stock-v2-gauntlet.py --reuse
```

Versions: Node 20.20.2, PostgreSQL 18, Playwright 1.62.1, TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0, fast-check 4.9.0. Docker base digests and npm lockfile are unchanged. No host Node installation or additional library was needed.

Machine-readable results, TAP logs, coverage, mutation results and screenshots are in `server/test-artifacts/regular-stock-v2/`. `gauntlet.json` records exit code 0 for every layer. The same directory contains saved RED and pre-edit baseline logs.

## Failures investigated

The two existing harness failures were reproduced using the captured pre-edit source, not waived as new failures:

- `src/smart-scm-harness.js`: `Expected active item_master input.` The disposable database has no active uploaded item-master input.
- `src/smart-scm-vendor-alternative-harness.js`: `value "9800000001050" is out of range for type integer`. This harness derives an integer fixture ID from the maximum inventory ID; the stock-request fixtures use larger bigint IDs. The exact numeric value can vary as fixtures accumulate.

The runner accepts only these named harnesses with their recorded error fingerprints. Every other failure remains blocking. Successful unrelated harnesses and the legacy stock-request suite remain included.

Development checks caught and corrected quantity rounding to whole pallets, residual demand after a placed PO, staged vendor-child carry, concurrent NetSuite snapshot changes, stale SO line choices, paused-item data disappearing during PO-phase approval, printer failures masking committed TOs, and arrival-input focus/validation races. The initial safety mutation retained an epsilon and did not express the intended integer-boundary bug; it was replaced with an actual strict inequality, then all five real mutations were rerun against both suites. Browser timing/locale fixtures were corrected without relaxing the behavioral assertions.

## Operational limits and rollout

- NetSuite contracts were tested with intercepted HTTP responses; no real NetSuite account or printer was contacted. Account-specific permissions, UOM data and actual remote latency still require sandbox/rollout verification.
- There is no stated performance SLA; dedicated load benchmarking was not added. Transaction and retry races are covered explicitly.
- Strict type checking covers the typed parser/domain core. Existing untyped application modules retain syntax/lint plus integration coverage.
- Deployment must include additive migration **239** and the runtime files/assets. The new lead-time setting defaults to **5 hours**, editable under Smart SCM Settings. Existing live-execution controls continue to govern SO/TO writes.
- Pre-v2 requests keep the legacy workflow. Releasing a priority requirement stops its forced carry; it does not create or cancel a purchase order.
- The implementation retains approvals without local stock holds; NetSuite performs the stock commitment. Post-commitment inventory refresh drives PO replenishment. A confirmed TO can proceed while its ticket remains available for SCM print retry.

These results establish the specified local behavior and contract handling; they do not claim that unexpressed requirements or live account behavior have been proven.

Follow-up: [Sales confirmation, exact quantity errors and structured-error display](regular-stock-confirmation-evidence.md), deployed in [the final release](../deployments/regular-stock-confirmation-v2-20260929/README.md). This supersedes the original domain/handoff and Sales UI hashes; the header/non-stock adapter remains unchanged.
