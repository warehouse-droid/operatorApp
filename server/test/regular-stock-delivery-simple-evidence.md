# Regular-stock Delivery evidence — 2026-09-29

Spec: `test/regular-stock-delivery-simple-spec.md`, including the user's final quantity clarification. Approval of a separate spec was not requested; the user supplied the route and quantity rules directly.

## Result

Deployed to https://test.mbbsoperation.com/sales/stock-requests at 2026-09-29T23:23:06.576656+00:00.

Base Yard is derived from the SO material line locations, independently of its header. Target Yard is the TO source. Only lines with a positive backorder qualify. Transfer each full line when available, otherwise its backorder; stop if even the backorder cannot be covered. Repeated items share an availability budget, reserving all minimum backorders before upgrading lines in SO order. PALLET is calculated from the selected quantities and item conversion factors, rounding up after aggregating each item. 3445 ↔ 2967 automatically approves, creates and queues printing; routes involving 150 or 12441 require SCM approval. Existing Pickup and Stocking workflows remain available.

## Executed checks

Command: `python3 tools/regular-stock-delivery-simple-check.py all`.

- Focused route, quantity, approval, concurrency and recovery checks: 27 passed.
- Relevant regular-stock, legacy stock-request and neighboring regression tests: 247 passed. Two pre-existing fixture failures remain: `smart-scm-harness.js` (active item-master fixture) and `smart-scm-vendor-alternative-harness.js` (integer-overflow fixture). No new failures.
- Browser: 6 checks passed, no page errors; desktop/mobile and Chinese labels, derived Base Yard, full-line/backorder/shortage preview, SCM approval and printer retry. Screenshots are in the artifact directory.
- Syntax, strict domain types, incremental lint and seeded shuffled suites passed. No dependency changes.
- Nine seeded mutants killed; seven domain mutants were also killed by the property tests alone.
- Changed executable lines: 366/366; changed branches: 334/366. No missing source files.
- Clarification RED run: seven expected failures before implementation. Concurrency RED run: the overlapping-stock test failed before the execution lock and passed afterward. Logs are preserved.

The HTTP execution test uses the real SO adapter, request transactions, TO creation/approval service, mirrors, SO dependency and print queue. Only the external NetSuite/printer transport is replaced. Tests run on an internal-only Docker network with disposable PostgreSQL.

## Release and limits

Fourteen runtime files were overlaid on the then-current deployed image. All 1,143 source/public/migration file hashes were verified; application configuration, worker and dependencies were preserved. No schema changes. The initial multi-layer image build hit Docker's layer limit; the successful release uses one overlay layer.

Deployed image: `sha256:dc4d75aa917f88355033971bd48290ebd9dea0a1b863962b4971a82adbbe002f`.
Source set digest: `8f62ed558e7e3768adc8cbf15c54e12970cebacb70e944c420f2cd2e44f50578`.

Post-release checks verified health, public asset hashes, approval routes, Base Yard derivation, quantity fallback and the shortage guard. Live NetSuite execution is enabled and yard printing is configured. Live verification was read-only: no NetSuite calls, orders or print jobs were created. Physical printer output was not exercised.

Exact runtime patch: `test/regular-stock-delivery-simple.changes.patch`. Logs, coverage, hashes, browser captures and mutation results: `test-artifacts/regular-stock-delivery-simple/`. Release manifest, source tree, public/live checks and rollback configuration: `deployments/regular-stock-delivery-simple-20260929/`.
