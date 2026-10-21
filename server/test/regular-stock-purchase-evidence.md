# Regular Stocking Purchase implementation evidence

The approved behavior is in [regular-stock-purchase-spec.md](regular-stock-purchase-spec.md). Purchase requires manual SCM review, preserves requested and reviewed quantities, rounds the accepted quantity upward to whole pallets, and changes the request to Accepted when added to proposals. Stable request-item demand and quantity allocations retain ownership through independent loads, merges with ordinary demand, splitting, recalculation, vendor replies and real PO synchronization. Only receipts fulfill the request; explicit releases close the released requirement without fabricating receipts.

Final implementation verification completed on 2026-09-30 against fresh PostgreSQL on an internal Docker network. All nine gauntlet layers passed, with zero new regression failures. No production orders or data were used in those tests. The release was deployed to https://test.mbbsoperation.com on 2026-09-30 at 22:37:46 UTC, including migration `245_regular_stock_purchase.sql`, the application, and the PO-sync webhook worker.

| Layer | Final result |
|---|---|
| Database migration | All migrations, including 245, applied successfully to a fresh database |
| Static checks | 26 JavaScript files checked; zero new lint diagnostics; 75 existing diagnostics retained; strict Purchase-domain TypeScript check passed |
| Full regression | 49 suite files, 302 tests; 301 passed and one recorded baseline failure |
| Randomized regression | Seed 20260930; 302 tests; 300 passed and two recorded baseline failures; zero new failures |
| Purchase tests | All 31 new tests passed in the full regression |
| Properties | Four properties, 500 generated cases each: upward rounding, original/reviewed quantities, FIFO quantity/receipt conservation and micro-unit boundaries |
| Manual mutation checks | 8/8 plausible bugs caught; six arithmetic/allocation mutants also caught independently by the property suite; restored suites passed |
| Browser execution | All nine checks passed; zero page errors; real submission, authorization, SCM acceptance, proposal grouping, receipt reconciliation and release endpoints |
| Changed-line coverage | 592/592 changed executable JavaScript lines; changed branches 499/590; no missing source files |
| Secrets and dependencies | Changed-line diff and 12 new paths scanned; no high-confidence secret findings; no dependencies added by this task |

The existing regression failures are `src/smart-scm-harness.js` with `Expected active item_master input`, and, in randomized order, `src/smart-scm-vendor-alternative-harness.js` with `is out of range for type integer`. Both are in the repository's recorded baseline. The regression runner rejects any other failure. Raw ordered and randomized logs are retained separately.

| Approved specification | Executable evidence |
|---|---|
| 1. Purchase/Transfer choice and manual review | `regular-stock-purchase-domain.test.js`, `regular-stock-purchase.test.js`, browser composer checks |
| 2. Current-yard evidence, unavailable data and yard access | Integration scoped-refresh test, browser yard switching and unauthorized-yard checks |
| 3. Reviewed quantity and upward pallet rounding | Domain/property tests, missing-policy test, browser SCM adjustment from 175 requested to 125 reviewed and 200 accepted |
| 4. Atomic, revision-protected acceptance and vendor grouping | Integration concurrent replay, stale revision, vendor-yard grouping, truck capacity and overweight rollback tests |
| 5. Independent/merged/split/recalculated load ownership | Load integration grouping, FIFO allocation, split/recalculation, manual editing, vendor partial-confirmation and planning-run carry tests; real browser grouping |
| 6. Actual PO commitment and exact remainder/release | Delayed and incomplete PO sync, unknown UOM, reduced/cancelled/reopened PO, exact 125-unit remainder and mixed-load release tests |
| 7. Direct PO trace and informational incoming POs | Matching ordinary/request item PO test, informational PO test, browser English/Chinese PO number/reference tables |
| 8. Receipt caps and completion | Generated allocation properties, shared-item FIFO receipt tests, browser completion with ordinary PO quantity still open and release without receipt |
| 9. Existing workflows, authorization and translations | Existing Stock Request/Regular regression suites, Purchase conversion/rejection guards, browser role checks and Transfer/Pickup controls |

Integration and property tests are under `test/mbt/integration`, `test/mbt/property` and `test/mbt/unit`. Screenshots cover the mobile composer, desktop SCM review, merged proposal, and English/Chinese mobile PO trace. Browser inventory reads and event-stream transport are simulated; financial mutations and request/proposal endpoints run against the actual application and isolated PostgreSQL. No live NetSuite PO creation was exercised. An independent agent review was omitted because this session prohibits delegation.

Reproduce every layer from the server directory:

```sh
python3 tools/regular-stock-purchase-check.py
```

The entry point creates and removes its own database container and network, enforces the isolated-test flag and disabled direct NetSuite access, runs the ordered and randomized suites sequentially, and fails on new test failures, surviving mutants, new static diagnostics, incomplete changed-line coverage, secret findings or source changes during verification. It uses the existing isolated runner/database containers and `mbbs-regular-v2:test` / `mbbs-regular-v2:e2e` images. These can be built with `Dockerfile.test` targets `test-base` and `test-e2e`. Image digests and individual file hashes are recorded in the report.

Tool versions: Node 20.20.2, PostgreSQL 18, Playwright 1.62.1, c8 12.0.0, ESLint 10.8.0, TypeScript 7.0.2 and fast-check 4.9.0.

Verified source-tree SHA-256: `d16916cd5aa7fa541f7ca8af7a08a179a8752ab0d7e1620673a1e818f6503679`. The scoped patch preserves all workspace edits that preceded this task. No checkpoint commit was created.

Machine-readable results, logs, screenshots and coverage are in `test-artifacts/regular-stock-purchase/`: `gauntlet.json`, `regression-ordered.json`, `regression-randomized.json`, `static.json`, `changed-lines.json`, `mutations.json` and `browser-report.json`.

Deployment evidence is in `deployments/regular-stock-purchase-20260930/`. The frozen, verified Purchase delta was merged over each current live image, preserving newer live changes. The app changes 22 files; the worker changes four files for PO synchronization. Both complete runtime source trees and unchanged package files were checked. Candidate validation passed fresh migrations, the full regression suite with zero new failures, all nine browser checks, and the actual worker's partial receipt, cancellation/reopening, transactional receipt and replay checks. These tests used an isolated database and made no NetSuite calls.

Before cutover, all checked executing operations were idle. The migration ran in a transaction with hashes and counts confirming existing stock requests, request lines, SCM proposals, proposal lines, PO headers and PO lines were unchanged. Both services retained their existing runtime configuration. Live verification confirmed health, exact candidate image IDs and complete source hashes, no service restarts, ten public health/asset checks, and three protected endpoints returning 401 to anonymous requests. Read-only database checks passed in both services; no smoke-check orders were created or modified. The database and Ollama containers were retained.

Deployed app image: `sha256:0cf0a4616da52ca90dc208b536418ef69f0040fb6519a3fa6a0d18239d60f825`.

Deployed worker image: `sha256:3f46e6f55811599318479823de31ee3a66be3a9b1f6d11e505f333ff9a930736`.

`result.json`, `migration-result.json`, `candidate-checks.json`, `public-check.json` and `live-check.json` contain the release results. Pinned prior-image rollback configuration is retained; the additive migration is retained if images are rolled back.
