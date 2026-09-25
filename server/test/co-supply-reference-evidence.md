# CO direct-supply reference verification

2026-09-17. Tier 3. Spec approval: not obtained (autonomous run).
The user's requested behavior is recorded in [the spec](co-supply-reference-spec.md).
The spec was not independently reviewed before implementation; the checks below
provide evidence within that scope, not a guarantee of every possible workflow.

The CO Operator projection now retains fully direct-supplied Trevista with the
normal SO notice and zero yard requirement. The existing normal SO projection
and write guard are reused. Canonical transport quantities are not restored.
Only `src/co-operator-linked-supply.js` and `src/delivery-repository.js` changed
in the release image. Existing unrelated working-tree changes were preserved.

## Final checks

All counts below were obtained after the final runtime edit.

| Layer | Result |
| --- | --- |
| Original bug reproduction | Initial run: 10 tests, 8 failures, 2 pre-existing passes. Final baseline replay: 5 repository tests, 4 expected assertion failures, 1 loaded-state pass; no collection/import failures. |
| Focused and adjacent tests | 79 passed, 0 failed. Includes normal SO PO/TO behavior, CO cargo preservation, handoff, linking, packing, refresh and concurrency checks. |
| Complete `npm test` | Baseline and final each: 2,580 tests, 2,578 passed, 1 skipped, 1 existing failure across 505 files. Zero new failures. |
| Type checking | Baseline and final: 233 existing diagnostics; zero new diagnostics. |
| Lint / complexity / syntax | Scoped ESLint: zero errors or warnings; new functions use the existing complexity limit of 12. Node syntax, Python compilation, shell syntax and `git diff --check` passed. |
| Changed-line coverage | 37/37 changed lines mapped by c8 executed: projection 33/33, repository integration 4/4. New projection statement, branch and function coverage: 100%. |
| Manual mutations | 5/5 killed: hide reference, ignore allocation, double subtraction, remove packing guard, reinterpret loaded cargo. No syntax/import failures counted as kills. |
| Property-only mutation | 2/5 killed (ignore allocation, double subtraction). The UI/API wiring, write guard and loaded-state mutants survive the quantity property alone and are killed by dedicated tests. |
| Generated quantities | 200 cases, seed 88381102: all five units conserve original = direct + required, preserve residual and packing, and are immutable and idempotent. |
| Adversarial cases | Negative, infinite and nonnumeric original/residual quantities reject. Stale smaller originals cannot reduce current cargo. Rejected confirmation and absolute updates leave CO ownership, packing, confirmations and audit unchanged. |
| Suite order | The same 79 focused tests passed with reversed file order and an isolated database clone per subprocess. Full suite uses its existing per-file database isolation; no full-suite randomized run was added. |
| Browser | Real Chromium renders actual Operator row/panel functions and CSS with repository data: Active has Trevista reference + PALLET 6; Packed has the five packed lines. Reference has the notice, correct breakdown and zero packing controls; PALLET retains confirmation and steppers. |
| Secrets / capabilities | Secret scan passed: 16 new paths plus changed-line diff, no high-confidence findings. No dependencies, migrations, or new runtime network/filesystem/subprocess/environment capabilities. Dependency audit/license checks were not rerun because the dependency set is unchanged. |

Existing full-suite failure (unchanged):
`P3.12: browser specs share one worker-owned database-pool lifecycle`
in `test/mbt/infrastructure/p3-gauntlet-contract.test.js`.
The comparison helper also lists expected application error log messages; those
are not additional failing tests.

Initial check corrections are recorded in the append-only spec: the batch test
now asserts the exact existing server message, and the browser asserts the
existing `-` display for zero. Numeric API requirements remain zero. Initial lint
found a shadowed test variable; it was renamed without changing assertions.
Initial type checking found untyped quantity keys; explicit key types resolved
them. No application message or formatter was changed to satisfy a test.

## Acceptance mapping

| Spec | Executable evidence |
| --- | --- |
| 1–2: visible reference and six residual pallets | `test/dispatch/integration/co-supply-reference.test.js`, first case; unit full/partial cases; Chromium row/panel assertions. |
| 3: preserve Packed/Active behavior | Existing `co-direct-to.test.js` Packed/Active and fully packed cases; new repository snapshot and mixed-batch cases; browser Packed list. |
| 4: reject packing reference | New integration confirmation and absolute-update cases verify 409/code and exact rollback snapshots; mixed batch verifies one rejected reference and six packed pallets. |
| 5: preserve source, allocation and cargo behavior | New read-only source/canonical snapshots; existing CO manifest/driver and normal SO linked-quantity tests; production read-only verifier checks pickup/drop and unchanged revisions. |
| 6: immutable projection and valid quantities | New unit property, adversarial quantities and ordinary-line cases; five mutation checks. |
| 7: loaded and reversible links | New loaded unit/repository cases; existing CO creation, refresh, mode-change and unlink cases. |
| 8: actual UI controls | `tools/co-supply-reference-browser.mjs`, screenshots and `browser.json`. This renders actual functions in Chromium; it is not an authenticated whole-page navigation test. |

## Reproduction and source identity

From `server/`, run `bash tools/co-supply-reference-gauntlet.sh fresh` with the
recorded Docker images available. It reconstructs the pre-change source using
`test/support/co-supply-reference-baseline.patch`, replays the bug, runs both full
suites, and executes all scoped gates. This session used `finish` after launching
the same baseline/final full-suite commands while constructing the gauntlet.
`finish` verifies frozen runtime hashes before using those complete suite logs.

Artifacts are under `test-artifacts/co-supply-reference/`, including
`gauntlet-passed.json`, `checks.json`, full/type baseline and final logs, changed
coverage, mutation logs, reversed-order logs, Chromium screenshots, and release
prepare/apply logs. Mutation uses an import loader and never rewrites runtime
files; the final source hashes are checked again after all gates.

Runtime SHA-256:

- `src/co-operator-linked-supply.js`: `24edd337412c6064cb563f8689ca1aa1b6e3e6952ed788ab4865e25f26232fcd`
- `src/delivery-repository.js`: `2def98264638af1447b4f7a57934806190f5fa2219a7c9a6199cc3b10de612c1`

Installed tools: Node 20.20.2, fast-check 4.9.0, c8 12.0.0, ESLint 10.8.0,
TypeScript 7.0.2, Playwright 1.62.1. No packages were installed.

Docker image identities:

- Test: `sha256:0a5ee3f2197eb21d9959c4cd71d12917e7ce5e7b112c02845681ec9eea7c460c`
- Chromium: `sha256:07e28b566ad289128bd7443b604c3427c69e4c54cd6c2b36ecb016efceef510b`
- PostgreSQL: `sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15`

Production packing writes were exercised only in disposable databases. Live
verification uses a read-only transaction and tests real CO/SO/TO and Dispatch
views without creating packing or repairing orders.

## Live release

Deployed and verified: `mbbs-operator-app:co-supply-reference-20260917-v1`, image
`sha256:a16f2d23f98c0584b710449cdaf1847e06147b8f55aa946a024d88b5a9918edd`.
The app is healthy; worker, database and Ollama containers were unchanged. The
candidate booted successfully against an isolated database before cutover.

The running app returns seven displayed CO-SOA08838 lines, including Trevista
with original/direct TO 52.25 SQFT and zero yard requirement. Its five packed
lines remain visible in Packed; Active retains Trevista and six remaining
pallets. PALLET shows original 7, linked 1, required 6. Load validation passes.
The physical CO manifest still has six lines with no Trevista. TOB01102 appears
once in pickup details; customer drop still has Trevista 52.25 and PALLET 7.
Dispatch revisions remain 44 and 35.

Canonical source lines, CO header/lines, TO lines, dependencies, allocations and
plan snapshot digest matched exactly before and after deployment:
`b5dacfb401e346780f09ccbe9c562fad01eb103af9a64b547417ff2efeb43639`.
There was no data repair, migration or packing reset in this release.

Release commands: `sudo -n python3 tools/co-supply-reference-deploy.py prepare`,
then `apply`. Read-only re-verification uses the same helper's `verify` mode.
Private rollback/configuration records are stored under
`/home/ubuntu/operatorapp-deploy-backups/co-supply-reference-20260917`.
