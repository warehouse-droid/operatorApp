# Operator Receiving split balance verification

Spec: [receiving-split-balance-spec.md](receiving-split-balance-spec.md).
Tier 3. Spec approval: not obtained (autonomous run). The user authorized the
correction and deployment; no separate spec review occurred.

The defect was reproduced against the saved implementation: POB03684 displayed
16 source lines instead of its three unsplit balances, and stale confirmations
could include fully assigned lines. The correction reads active SCM split
reservations by exact source row for both display and confirmation. It bounds
availability by recorded receipt progress and remaining parent capacity, without
adding a split receipt twice. It does not change PO rows, split ledgers, receipt
recording, webhook ingestion, roles, or NetSuite posting adapters.

## Acceptance mapping

| Spec | Executable evidence |
| --- | --- |
| Three balances: 108 / 304 / 228 SQFT | `POB03684 exposes only the three unsplit balances...`; actual repository output replayed in Chromium |
| Same selected-card count, page and confirmation | `receiving-split-balance-ui.test.js`; browser shows 3 lines on one page and sends exactly those three IDs |
| Exact row, repeated SKU, active/cancelled and multiple splits | `cancelled splits release exact-line capacity...`; `multiple active splits accumulate...`; generated SQL fixtures |
| Child quantities and source rows preserved | Incident test compares every source/child row and ledger before/after reads; browser visits all 14 child lines |
| No duplicate deduction of remote split receipts | `parent split capacity and cached split receipts overlap...`; 60 generated scenarios, seed 20260922, plus explicit examples |
| Parent local receipts reduce only its own capacity | `parent local receipts reduce unsplit capacity...`; adjacent follow-up receipt/idempotency tests |
| Stale confirmation cannot exceed available balance | `confirmation caps the parent's partially split line...` requests 999 pallets and checks receipt quantities and exact source keys |
| SO reservations remain receivable | Seven existing `operator-receiving-allocations.test.js` tests, including its generated property |
| PO/TO/CO identity and yard boundaries remain intact | Nine existing `operator-receiving-identity.test.js` tests; stored SO/TO direct source tests |
| Receipt recording, deduplication, rollback and concurrency | Existing follow-up integration, unit and concurrent-finalization suites |
| Aggregate, Sales map and prior line-display changes preserved | Exact candidate tests, captured-live overlay scope, live source/asset hashes and read-only probes |

## Recorded verification

Artifacts: `server/test-artifacts/receiving-split-balance/`.
Release artifacts: `server/test-artifacts/receiving-split-balance-deployment-20260922/`.

- RED: initial incident run had 5 assertion/property failures and 1 existing
  passing behavior. After adding the card/multiple-split tests: 7 failures, 1
  pass. The already-working remote-receipt overlap behavior failed under the
  deliberate double-subtraction mutant; it is meaningful regression protection.
- Final focused run: **56 tests passed, 0 failed**, including the eight new tests.
  A seeded shuffle of the same 12 test files also passed.
- Mutation: **5/5** deliberately incorrect implementations killed by the incident
  suite; **5/5** killed again by the property test alone. Loader mutations never
  write to runtime files; the gauntlet checks source hashes before and after.
- Changed-line coverage: **35/35** lines reported by c8/diff covered in the
  helper, repository and Operator client. The new
  helper has **7/7** branches covered. Across all changed locations, branch
  coverage is **12/17**; uncovered wrapper branches are recorded in
  `coverage.json`, not claimed as fully covered.
- Static checks: syntax passed; **0 new lint findings**, **0 new type
  diagnostics**, **0 secret findings**. The existing repository/import graph
  has **428** unchanged TypeScript diagnostics. Browser legacy lint findings
  are compared against the saved source, rather than silently ignored.
- Real Chromium execution: parent **3** lines, child **14** lines, confirmation
  page **3** correct IDs, **0** browser errors, **0** live API calls and **0**
  receipt submissions. Screenshot: `operator.png` in the focused artifacts.
- Exact captured-live candidate: **56** receiving tests, **3** page-confirmation
  contracts, and **35** Aggregate/Sales map tests passed; candidate browser passed.
  The historical cache-version page contract is excluded from that focused
  selection and remains included in the full existing-failure comparison.
- Read-only production query: **14** split ledger groups, **2.634 ms** execution
  on this run (`query-plan.log`); this is a spot check, not a throughput claim.
- Full regression: **569 files, 3,021 tests; 2,995 passed, 25 existing failures,
  1 existing skip, 0 new failures**. The initial comparison used the earlier
  baseline and reported the cache-literal failure described below; comparison
  against the independently verified baseline addendum passed. Runtime hashes
  match the focused run and every runtime file predates the full run's start.
- Deployed at **2026-09-22 20:48:19 UTC**. All **5** runtime file hashes and **6**
  local/public asset fetches match the candidate; health returned **200**. Live
  POB03684 exposes exactly **108, 304, 228 SQFT**; child #11619-1 keeps its **14**
  original quantities. SO11663 remains completed with **0** open lines.
  Incident source quantities/split ledgers, application configuration and other
  services are unchanged. Preflight had **0** active posts, fulfillments or
  Dispatch editors. **0** live receipts were submitted by verification.

The first browser harness assertion incorrectly required every form quantity to
be numeric. Existing selected inputs serialize as strings; the harness now
requires exactly `[1, 1, "1"]`, without weakening the one-pallet bound or
changing the application. Static checks initially exposed two nullable-map type
errors; using an empty map for non-PO paths resolved them. The earlier full run
was stopped and restarted after that source correction; its incomplete output
is not counted as passing evidence.

The fresh read-only pre-release snapshot found SO11663 completed by the operator
since the earlier display fix (`receipt_status=received`, zero open lines).
The live verification therefore requires it to remain completed with zero open
lines, instead of asserting its obsolete ten-line state. POB03684 still has the
original 16-line display and its child still has 14 before this deployment.

## Reproduction and limits

Run from the workspace root:

```bash
python3 server/tools/receiving-split-balance-gauntlet.py
```

This uses the existing `field-sales-check-2941306:latest` image
(`sha256:a213a201d54066121bc474fd418fe25417cc595bfc4be21abd3cefcd0cd6e6a2`),
an isolated PostgreSQL database and read-only source mounts. Recorded tools:
Node 20.20.2, Playwright 1.62.1, fast-check 4.9.0, c8 12.0.0, ESLint 10.8.0,
TypeScript 7.0.2. `--focused` and `--full-only` reproduce each independent half.
The full-suite baseline is `test/receiving-split-balance-existing-baseline.json`.
It includes an independently reproduced addendum to the earlier Aggregate
baseline: the previous deleted-line release had already advanced Operator's cache
version. The unchanged `operator-delivery-refresh.test.js` still requires the
old Aggregate version literal. Replaying both the saved pre-change workspace
and captured live assets reproduces the same failure. No test was weakened.
`tools/receiving-split-balance-cache-baseline.py` reproduces that evidence;
`--compare-only` compares a completed full log against the corrected baseline
and rejects runtime sources modified after the run began.

Release commands are `python3 server/tools/receiving-split-balance-deploy.py`
with `prepare`, `build`, `check`, `apply`, and `verify`. `apply` requires matching
source hashes, all verification gates and no active receipts/fulfillments or
Dispatch edit lease. It retains a rollback image and restores it if verification
fails. The release has five runtime files and no migration. Source-state identity
and candidate image digest are in the release manifest.

New dependencies, dependency/license audits and schema rollback rehearsal:
not applicable; no dependency or schema changed. No commits or resets were made
in the shared worktree. New functions are two small read/projection helpers;
the existing receiving write paths and posting integrations remain in place.
No live receiving transaction was used as a test.

This correction does not repair the separate external Item Receipt webhook
configuration or reconstruct receipts missing from the local cache. Aggregated
remote receipt counters do not identify which child received a quantity; the
projection uses known split capacity and recorded receipt bounds. Existing
posting validation remains responsible for submission, including changes after
the page was loaded; no new cross-system transaction guarantee is claimed.

Deployed image: `mbbs-operator-app:receiving-split-balance-20260922-v1`
(`sha256:8b5bae2d2ffb226fb071881f4455d3d59a52b88331720059a52299a0db4dc165`).
Runtime source hash: `9ec72fac59188fe7d5086d267e3230617b32efd2887e8045d79d2b490d2a80b1`.
HTML/service-worker cache-version strings are configuration changes outside the
reported c8 scope; syntax, matching asset references, browser loading and exact
live/public asset hashes validate them. No service-worker behavior was changed.
