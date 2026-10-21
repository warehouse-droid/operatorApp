# SCM Stock Check — implementation and evidence

**Correction, October 14, 2026:** The pilot below proved cart acceptance and
restoration, but did not verify the Availability column. Its earlier stock
confirmation was incomplete. The application now presents that historical job
as **Availability unverified**, preserving its raw audit record. New stock
confirmations require the exact cart row to report Available or In Stock;
production schedules are reported separately with their vendor ETA. See
[the availability correction evidence](stock-check-availability-evidence.md).
The remaining measurements below describe the original release.

Implemented the requested SCM module with Product Pickup Points, Test Stock Check,
and Vendor Setup. Vendors have separate encrypted, named accounts and a selected
login. Unilock Ontario is the first tested adapter; other vendor methods remain
pending until implemented and tested.

Tier 3. **Spec approval: not obtained (autonomous run).** The user authorized this
module and live pilot; the specification was written for review without pausing
implementation. This evidence gives bounded confidence, not proof of all behavior.
Acceptance specification: [stock-check-spec.md](stock-check-spec.md).

## Live evidence

- Deployment verified 2026-10-14T06:09:51.249801+00:00; all three SCM routes return 200 and application health
  passes. Only the application container changed; database, webhook worker, and
  Ollama identities/settings were verified unchanged. Runtime image:
  `sha256:2af78e7b2f0255c2ea9b0adb1e741b410ab7f3ff3d8940cd1cb244d7791070f6`.
- Saved 618 exact Unilock colour/size variants: 190 Ayr,
  84 Gormley, 54 Pickering, 99 Georgetown. The remaining
  191 are retained for review: 24 Chicago labels and
  167 missing labels. No category-based pickup guess is made. Endura Coping
  Oat Beige `177ECS0163703-0` is saved as Pickering.
- The selected named Unilock login is configured and verified. The encrypted
  account key is retained in application data with mode 0600; secrets are absent
  from source, job payloads, returned account objects and recorded failure text.
  The live anonymous stock-check API returns 401.
- Authorized live job `3de7631b-f79d-4cc2-a199-0b0ea77c23db` confirmed **5 pallets** of Beacon Hill Smooth
  XL 6 cm Granite Fusion, exact SKU `0262XL0631907-0`, at Ayr on
  `10/16/2026`. All 14 recorded steps passed.
  The cart reached 10 bundles: 5 existing + 5 tested. The original 5 and saved
  October 15 date were restored and independently reread by the checker.
  Two real JPEGs are stored in the authenticated SCM result. The cart overview
  image shows 10 bundles and the selected pickup/date; the product image shows
  the selected variant. Stock confirmation also checks the full parsed cart.

## Acceptance-to-test mapping

| Specification | Executed verification |
| --- | --- |
| 1: SCM module and navigation | Browser catalog/setup/test flows through actual app routes; release route checks |
| 2: Vendor logins and private secrets | Vault unit/property tests; PostgreSQL multiple-account/ownership tests; setup browser flow; router authorization/body tests |
| 3: Separate vendor methods | Repository rejects pending methods; setup browser displays pending adapter state |
| 4–5 and B–C: Exact selected labels/SKUs | DOM fixture tests distinguish selected Pickering from generic Ayr; catalog all-colour/dedup/space-SKU tests; live 618-variant capture |
| 6 and G: SCM edits survive refresh | PostgreSQL edit/reset/dedup/stale-revision tests; catalog browser flow; native test of corrected Pickering with displayed Chicago retained |
| 7: Tracked refresh/cancel | Catalog progress/partial-result tests; repository queue/cancellation tests; runtime interrupted-job tests |
| 8: Exact variant and pallets | Domain quantity/search tests and properties; actual browser exact variant and five-bundle job flow |
| 9 and D–E: Pickup and earliest native date | Native bound callback/calendar/blank-input/Order Summary fixtures; live Ayr October 16 check and date restoration |
| 10, A and F: Full cart quantity proof | Native positive/shortage/system-error/AJAX fixtures; exact increment/UOM/cart signature domain tests/properties; real cart increment |
| 11: Steps and protected screenshots | Router evidence authorization/path tests; runtime private image/error tests; actual browser blob-image assertions; saved live JPEGs |
| 12: Preserve cart; no checkout; serialize | Native restore/cancel/cleanup-failure/checkout fixtures; real PostgreSQL worker-lock test; live restoration steps |

## Final validation

All module measurements below were refreshed after the last implementation edit.
The two existing-suite runs compare the retained pre-change application with the
candidate shared wiring. They span the final native-adapter fixes; legacy source
and shared wiring were unchanged throughout. The final module runs cover those
adapter fixes separately.

- `STOCK_CHECK_SOURCE_ROOT=./server/deployments/stock-check-20261014/candidate bash server/tools/stock-check-tests.sh final`:
  **67 pass, 0 fail** (real PostgreSQL and Chromium).
- Same runner, stage `final-shuffled`: **67 pass, 0 fail**;
  file order shuffled with seed 20261014 and saved in artifacts.
- Stage `property`: 6 properties with 150 generated cases each. Five plausible
  domain/vault mutants killed **5/5 by unit tests and 5/5 by properties alone**.
  Stage `runtime-mutant`: **4/4** additional worker/recovery/redaction mutants
  killed. Source hashes were unchanged after mutations. The lock mutant first
  triggered the queued-status assertion, then its blocked worker was killed at
  the 30-second child deadline; that timeout is recorded separately.
- Stage `static`: ESLint (including complexity 16/depth 5), check-JS TypeScript
  for domain/vault, and diff secret scanning completed with zero reported
  lint/type errors or high-confidence secret findings. Type coverage is limited
  to those modules; the rest is JavaScript with runtime/behavior tests.
- Node coverage: **840/977 lines
  (85.97%)**, **414/519
  branches (79.76%)**. UI browser coverage:
  **143/147 lines**, **127/172
  branches**. These are measured module totals, not 100% changed-line coverage.
  Serialized `page.evaluate` DOM/calendar functions execute in Chromium but are
  not instrumented as Node source. Browser DOM instrumentation and several
  defensive/error branches remain coverage gaps; no complete-coverage claim is
  made and no assertion was weakened to raise a score.
- Existing MBT regression runs: **973 files each**; baseline
  **5694 reported tests / 123 failing files**,
  candidate **5674 reported tests / 124 failing files**.
  The raw candidate run had **1 extra timeout file**,
  with no named assertion failure. That unchanged scrolling fixture was repeated
  alone against both versions, keeping its assertions and 90-second deadline:
  **20/20 passed in each run**. Its seven tested public source files are byte
  identical. The shared-budget timing failure is classified separately, with
  the original failure retained. **0 unresolved new failing files and 0 new
  named failing cases.** Full failing names are
  retained verbatim in `regressions.json` and the baseline/candidate logs.
  Pre-existing browser timeouts are bounded at 90 seconds per file, so reported
  test counts omit files that never produced their test totals. This is the
  MBT suite; other standalone dispatch/PDF suites were not rerun.
- `bash server/tools/stock-check-audit.sh`: **0 new advisory IDs**. Existing
  production dependency findings remain: baseline
  8, candidate
  9 affected package
  entries, including a pre-existing critical entry. The extra minimatch entry
  references an existing brace-expansion advisory, rather than a new advisory.
  Promoted pinned Playwright and playwright-core use Apache-2.0 licenses.
- Stage `boot-green`: exact final image started healthy with synthetic data;
  disposable app/database/network were removed afterward.

## Failures found and corrected

Behavioral RED logs record the original missing module behavior and later native
portal failures. The live date input was blank, `beforeShowDay` required its
input binding, Order Summary held the saved date, and Add to Cart completed in
a popup without navigation. Fixtures reproduced these before the fixes. The
SCM unknown-label correction also failed before its fix. Failed live attempts
remain visible for SCM review; the final pilot succeeded.

The first overlay image copied protected source files with incorrect ownership
and failed startup. The release automatically rolled back to the healthy original
image; `COPY --chown=node:node` and the isolated boot guard corrected it.
An early regression comparison was invalid because sudo dropped the source-root
environment variable. Those workspace-only logs were retained as diagnostics
and excluded. Both genuine runs now explicitly pass the source variable through
sudo and assert/save the resolved before/candidate mounts.

## Reproduction and limits

Run `bash server/tools/stock-check-gauntlet.sh` from the repository root, followed
by `python3 server/tools/stock-check-evidence.py`. The entry point runs module,
shuffle, static, property, mutation, dependency, build/boot and existing-regression
layers. It requires the retained captured source and pinned test image/toolchain
in this workspace, Docker, and the installed mbbs-tests.slice budget. A fresh
checkout needs those baseline/toolchain artifacts; this is not a standalone CI
bootstrap. No live vendor credentials are used in disposable tests.

Node v20.20.2; PostgreSQL 18 test image pinned by Compose digest. Recorded tool
versions: playwright 1.62.1, pg 8.21.0, express 4.22.2, c8 12.0.0, eslint 10.8.0, typescript 7.0.2, fast-check 4.9.0, axe-core 4.12.1.
Candidate manifest hash: `0fec3734537fee770761bdc77a31d0ffb08875c9d91b15689c3c4fa042ad8289`. Published source hash (excludes
Dockerfile): `af3b4a5e6e47bd6c754dba6e218b6ff058d98739b4efa0512386e0ce7a74071d`. Changed paths are retained in
`evidence-summary.json`; unrelated captured production source is preserved.
No git commit or checkpoint cadence was requested.

Known limits: other vendor adapters and automatic fallback-location stock
attempts are not implemented yet. A conflicting existing cart pickup stops for
SCM review. Our workers are serialized globally; concurrent cart edits by a
person on the vendor website are outside that lock. A process crash cannot run
its finally cleanup, so interrupted jobs retain their baseline and require SCM
review. Live inventory results are timestamped observations and can change.

Host cleanup is registered before each test launch. Every isolated Compose
project is torn down with volumes/orphans removed; one-off containers use --rm.
Final Docker/container/network/volume and production-health evidence is saved
in `test-artifacts/stock-check/final-host-cleanup.json`. Production data,
operational screenshots/audits, and rollback images are retained.

## Subsequent scrolling correction

The initial-release results above are historical. The deployed scrolling correction and its 69 passing checks are recorded in [stock-check-scroll-evidence.md](stock-check-scroll-evidence.md); initial measurements and logs are retained in `test-artifacts/stock-check/initial-release-evidence`.
