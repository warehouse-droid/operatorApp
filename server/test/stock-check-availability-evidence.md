# Stock Check availability correction

Unilock accepts production items into its cart. Cart acceptance alone therefore
cannot establish immediate stock. New confirmations require the exact SKU,
full bundle increment, expected pickup/date, unchanged other cart lines, and
Available/In Stock on that same row. Production schedules retain their vendor
text and ETA and appear as In production. Missing, conflicting or unfamiliar
labels become a scrape failure for SCM review. Known production on the selected
product label/BNDL option is reported before Add to Cart, without adding a line.
Each operation records its step status and private screenshots. Cart evidence
scrolls the exact matching row into view so its Availability column is visible.

Tier 3. **Spec approval: not obtained (autonomous run).** User observations
authorized this correction. The append-only acceptance specification is
[Clarification I](stock-check-spec.md#clarification-i--vendor-availability-is-separate-from-cart-acceptance).

## Live validation

At 2026-10-14T14:19:36.565Z, the saved vendor login was used for a read-only portal inspection.
No Add to Cart, shipment, pickup, quantity or requested-date changes were made.

| Exact cart SKU | Existing bundles | Vendor Availability | Parsed status |
| --- | --- | --- | --- |
| 0262XL0631907-0 | 5 | Available | in_stock |
| 02U1183661507-0 | 2 | Production Scheduled for - 2026-10-20 | in_production |

The authenticated selected Urban product also reported
`Production Scheduled for - 2026-10-20`. The current parser classified it as
in_production with ETA **2026-10-20**, using its dedicated product label.
The portal's product availability was absent in an anonymous inspection;
authentication is required. Cart labels use the row's `_availability` element.

Historical job `3de7631b-f79d-4cc2-a199-0b0ea77c23db` now presents Availability unverified
with accepted quantity 5 and no verified stock
quantity. Its original database result is preserved for audit. The earlier
cart-only claim in [the original report](stock-check-evidence.md) is corrected.
The catalog still contains 618 saved variants.

## Executed checks

- Complete Stock Check tests: **83 passed, 0 failed**, including PostgreSQL,
  native portal fixtures and Chromium. Shuffled file order with seed 20261014:
  **83 passed, 0 failed**. Both runs mounted the reviewed isolated candidate.
- Eight properties, 150 generated cases each. Eight domain/vault mutants were
  killed by unit tests and again by properties alone. These include scheduled
  production becoming immediate stock, unknown labels becoming stock, and
  bypassing Availability after cart acceptance. Source was unchanged by mutation.
- A separate UI mutant that displays In production as Stock confirmed was
  killed by the browser result/ETA assertion (5 passed, 1 failed). The original
  browser RED had a queued-job timing race; it is not used as evidence of that
  assertion. Synchronization was corrected without weakening the assertions.
- Availability domain, real DOM, native stock, PostgreSQL legacy-result and
  property checks failed before their fixes; their RED and GREEN logs are
  retained. `parser-availability-red.log` accidentally ran units; the genuine
  DOM RED is `parser-availability-dom-red.log` (4 passed, 2 failed).
- Static lint, limited check-JS types and secret scanning passed. A complexity
  finding was corrected by extracting the availability helper; the existing
  complexity limit of 16 was retained. The exact release image started healthy
  with synthetic data in the bounded isolated Compose stack.
- Node coverage: 898/1044
  lines (86.01%), 459/568
  branches (80.8%). Serialized browser DOM/calendar
  functions execute in Chromium and have limited Node instrumentation. Defensive
  branches and complete changed-line coverage remain gaps; this is bounded
  evidence, not proof of every behavior.

Native fixtures verify accepted production carts retain ETA and restore the
baseline, early product production skips Add and restores settings, and unknown
Availability requires SCM review while restoring the cart. The UI verifies
production/ETA and the protected screenshot. Repository tests verify historical
positives become unverified without overwriting audit data. Existing quantity,
pickup/date, cleanup, encryption, authorization and scrolling tests still pass.

## Release and reproduction

Deployment verified 2026-10-14T14:18:35.509900+00:00; application health and all three Stock Check
routes passed. Only the application container changed. Shared application,
sidebar, menu and dependency files were pinned to their existing live bytes;
unrelated workspace changes were excluded. The six changed production paths
are recorded in `availability-evidence-summary.json`. Runtime image:
`sha256:709009628ddf65151d44aef1ecb64d2e553f91de9395cdd90591a6043245d860`. Candidate manifest hash: `8149019a863e1b5a28806cc539bfbc63fc740c7be243ed39ab565ceef51f1cf6`.

From the repository root, run the bounded registered-teardown runner with
`STOCK_CHECK_SOURCE_ROOT=./server/deployments/stock-check-20261014/candidate bash server/tools/stock-check-tests.sh final`
and `final-shuffled`; use stages `static`, `property`, `browser-availability-mutant`
and `boot-green` for the other layers. Mutation stage is intentionally nonzero.
Generate this report with `python3 server/tools/stock-check-evidence.py` after
read-only live validation and final cleanup. Captured candidate, pinned Docker
image/toolchain and installed mbbs-tests.slice are required. Disposable tests
use synthetic credentials and data. The full unrelated legacy suite was not
rerun for this six-file correction; its earlier findings remain historical.

All task-owned test containers, databases and unused networks were removed;
both docker ps and docker ps -a were checked. Production data and operational
audit records were retained. Other tasks' active test projects, if present, are
listed separately in the cleanup artifact and remain their owners' responsibility.

Known limits: Availability is vendor-reported status rather than an independent
warehouse count. ETA is a vendor production schedule and can change. Production
on a cumulative cart quantity with an existing matching line requires SCM review
of the requested increment. Concurrent human cart edits are outside the worker
lock; interrupted jobs still require review. Other vendor adapters remain pending.
