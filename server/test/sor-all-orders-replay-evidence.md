# Isolated SOR replay and Driver PWA evidence, 24 September 2026

Result: all 137 captured SOR orders replay successfully with the real catalog worker enabled. All currently eligible 23 deliveries and 21 returns can be planned, confirmed and completed through the installed Driver PWA. A later source sync preserves every completed return. Live SOR remains paused; test addresses and test return creation were confined to disposable databases.

## Captured data and isolation

- Read-only snapshot at `2026-09-24T13:43:21.599293Z`: 137 headers, 365 lines, 130 item policies and 14 initial return orders, with associated SOR definitions, assignments and recorded execution.
- Snapshot SHA-256: `dd66b9a35be18d36ee9ed0aaa1dbcadccd2fd259a852351985892f0f15c21b1b`.
- PostgreSQL 18 and Node/Playwright run on an internal Docker network, with no published database port and external NetSuite/Samsara writes disabled. Original replay and Driver completion use separate test databases. No live order was edited or externally posted.
- Unrelated users, non-SOR orders/plans, inventory and historical catalog workload are omitted. This is a deterministic replay of captured SOR state and lock contention, not a complete production-load simulation.
- The release uses six scoped production files over the captured live image. Reports record the candidate source hashes, including unchanged Driver and server code.

## Database and catalog replay

| Check | Result |
| --- | --- |
| All captured orders with forced worker/catalog fleet-lock contention | 137 processed in 7 batches, 24.806 s |
| Unchanged header/line upserts, without creating a new order | 137 processed in 7 batches, 19.872 s |
| Concurrent database-backed bootstrap probes | 421 successful, maximum 75 ms |
| Actual staff login after each replay | HTTP 200 |
| Lock waiters after replay, new review flags, duplicate returns | 0 |
| Paused feature gate | Queue and returns unchanged |

The original pre-fix worker reproduces the fatal catalog/worker lock cycle in the same production catalog mode. Final replay preserves all initially open returns and creates seven eligible historical returns in isolation, resulting in 21 open returns. The unchanged-source second pass is idempotent.

Two additional defects were reproduced before repair: return definitions masqueraded as delivery splits, and stale return definitions inherited the delivery pickup, causing an extra managed pickup and planner-confirmation rejection. Focused regressions, the full HTTP planner test and mutation checks detect these defects. The detailed incident explanation and timing comparison are in [Operator evidence](operator-responsiveness-evidence.md).

## Planning and actual Driver PWA

- The real planner source feed supplies 23 eligible deliveries and 21 returns. Actual edit lease, create, save with revision/digest, and confirm APIs all succeed. Save took 929 ms and confirmation 821 ms in this fixture.
- Each of the 21 rental deliveries starts at 3445 Kennedy Road. Its initially undated return reverses the route and retains the same rental item identities and quantities.
- All 21 returns report not ready before delivery. The actual Driver Start button explains the dependency; the real authenticated Start API returns 409 for a premature collection. All 21 become ready after their deliveries complete.
- 16 Driver sessions complete 44 pickups, 44 dropoffs and 37 travel jobs, using real browser/server clocks and the normal ten-second confirmation guard. The two phases each run eight independent browsers concurrently.
- All 176 required photo uploads succeed and the corresponding evidence references are verified in saved job records. Only the external blob store is simulated; signed upload tickets and byte limits are checked. This run does not establish production R2 availability or object readback (0 reads were requested).
- Eight optional delivery signatures are saved with the customized terms; other stops complete without a signature. Pickup and return stops omit the signature button. Cancellation of the signature dialog is exercised.
- Mobile sizes 390×844 and 320×568 are checked for overflow, scrolling and an unobstructed Complete button. History and authenticated reload are checked for each Driver.
- No browser page errors, HTTP 500 responses or failed journeys. Driver report finished at `2026-09-24T14:25:08.233Z`.
- A subsequent real Admin-triggered reconciliation and catalog run processes all 137 again in 7 batches (15.709 s), with all 21 completed return rows byte-equivalent as JSON, no duplicates and no lock waiters. The isolated gate is then paused too.

## Dummy addresses and policy boundaries

The user authorized dummy addresses for testing. Only the isolated Driver database substitutes `900` through `904 Isolated Test Road, Toronto, ON`, respectively, for SOR00030, SOR00085, SOR00183, SOR00185 and SOR00147. SOR00030 is tested with its saved Delivery method despite its conflicting self-pickup memo. Real addresses/methods still need clarification before live execution.

SOR00107 is cancelled and correctly remains restricted. SOR00033 (`S4046E/Week`, Service) and SOR00147 (`SDLG-ER655H`, NonInvtPart) are delivery-only under their captured policies: neither has a matching rental hierarchy, Day/Month name or override. They are not classified as inventory sales by this evidence; the Admin item controls can change their auto-return policy.

Seven historical sources gain returns only in the isolated replay: SOR00030, SOR00043, SOR00059, SOR00085, SOR00111, SOR00112 and SOR00142. Historical eligibility, the incomplete item metadata above and actual site addresses should be reviewed before re-enabling SOR. The test does not change those decisions in live data.

## Reproduction and reports

Run `bash tools/operator-responsiveness-gauntlet.sh` with the captured candidate and private snapshot available. No new packages are needed. The reports are ignored private local artifacts:

- `test-artifacts/sor-rentals/all-orders-replay.json`
- `test-artifacts/sor-rentals/all-orders-driver.json`, plus per-Driver traces/screenshots
- `test-artifacts/sor-rentals/completed-returns-replay.json`
- `test-artifacts/sor-rentals/all-orders-before-lock-fix.log` and `all-orders-planning-red.log`
- `test-artifacts/operator-responsiveness/checks.json`

73 focused tests and 25 Operator browser tests pass; all 8 mutants are killed and 38/38 changed executable lines are covered. No new lint/type diagnostics. The broader global-order suite retains two failures also observed on the unchanged live baseline, so a fully green repository is not claimed.

## Live release

The verified six-file release was deployed at `2026-09-24T14:39:09.573546281Z`. Both live SOR switches remain off, and all 14 live return rows are unchanged. No test address or test completion was copied to live data. Deployment and public health evidence are in [Operator evidence](operator-responsiveness-evidence.md).

After verification, the owned disposable test database container and internal network were removed. The private snapshot, reports, source hashes, traces and screenshots remain available for reproduction.
