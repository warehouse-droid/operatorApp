# Delivery TO memo — evidence

Spec approval: not obtained (autonomous run). Tier 2. [Acceptance spec](regular-stock-delivery-memo-spec.md).

- 270 regression tests passed, 1 unchanged baseline fixture failures, zero new failures.
- Changed executable lines: 11/11; changed branches: 10/10.
- 4/4 manual mutants killed; SO-memo omission also killed by the property suite alone.
- 4 suites passed in shuffled order (seed 296712441); project type checks passed, zero new lint diagnostics, syntax checks passed for all three changed files.
- Runtime source manifest SHA-256: `ba98037693efb222ee96c1d67cd389cc0f957f57c57a2898c25206f524c06ac1`. Shared dirty workspace preserved; no commits made.
- Deployed `mbbs-operator-app:regular-stock-delivery-memo-20260930` at 2026-09-30T03:38:24.012105+00:00; image `sha256:9f958067f02e7a498a5dbcab92b7229af60f0a47879bdb929c48793d3c344af8`. App configuration, worker and dependencies preserved; no schema changes.

## Acceptance coverage

`test/mbt/integration/regular-stock-external-workflow.test.js` runs real application HTTP submission, repository, NetSuite adapter, approval, mirroring and print-queue code. Only the external HTTP transport is stubbed. Both normal creation and loss of the creation response assert the canonical SO memo, one TO, one print job and successful replay. The remote fixture only returns TOs whose actual memo marker or external ID matches the query. Existing legacy and Stocking cases continue to pass with marker recovery.

`test/mbt/unit/regular-stock-delivery-memo.test.js` checks 100 generated SO references/quantities (seed 121732), stable external identity, unchanged legacy/Pickup/Stocking memos and rejection of invalid/injected request identities. Existing domain tests retain duplicate and wrong-route recovery rejection; the complete related suite covers Base/Target direction, quantity/PALLET rules, approval and printing.

Mutants independently omit the SO memo, omit the recovery request identity, change the external-ID prefix and alter the legacy memo. All fail on behavioral assertions. Sources are restored and tests rerun after mutation.

## Reproduce

From `server/`, run `python3 tools/regular-stock-delivery-memo-check.py all`. This runs disposable migrations, focused tests, the full related suite with coverage, existing project type checks, lint, shuffled tests, properties, mutants, changed-line coverage and a scoped secret/capability scan. Existing Node test and PostgreSQL18 Docker images are used on an internal network with direct NetSuite access disabled. Toolchain: `{"c8": "12.0.0", "eslint": "10.8.0", "fast-check": "4.9.0", "node": "v20.20.2", "playwright": "1.62.1", "typescript": "7.0.2"}`.

Deploy using `python3 tools/regular-stock-delivery-memo-deploy.py prepare`, then `apply`; `verify` repeats read-only deployed checks. The release verifies the complete runtime source tree and health, pins the previous image for rollback, and waits for no active operations. Only the three runtime files in `tools/regular-stock-delivery-memo-files.json` are overlaid. Generate this report using `python3 tools/regular-stock-delivery-memo-evidence.py`.

The read-only NetSuite schema probe `tools/regular-stock-delivery-memo-netsuite.mjs` confirmed support for the external-ID query. The deployed checks validate payload behavior and read any recent saved Delivery transfers. No live TOs were created or amended, and no live print jobs were submitted.

## Failures and limits

The initial RED run failed both HTTP memo scenarios, the generated memo property and invalid identity rejection (four failures); it is retained in `test-artifacts/regular-stock-delivery-memo/red.log`. Assertions were retained through the fix. The existing legacy memo assertion was already green and its negative sensitivity was verified by the legacy-memo mutant.

The accepted pre-existing failure baseline lists `src/smart-scm-harness.js` ("Expected active item_master input") and `src/smart-scm-vendor-alternative-harness.js` ("is out of range for type integer"). The final run observed 1 of these: `/app/src/smart-scm-harness.js`; the other previously failing fixture passed in this run. The accepted baseline file remains unchanged. No new dependencies or package changes; dependency/license audits were not rerun. No new network destination or credential capability. No new functions or schema complexity.

Browser checks were skipped because no UI files changed; actual HTTP execution covers this backend-only change. Existing project type checks apply to its annotated modules; the legacy JavaScript adapters are not fully statically typed. External failure tests simulate the transport boundary; a real TO creation and physical printing were deliberately not performed. Historical TO memos are not bulk-updated.

Final layer timings:
- migrations: exit 0, 6.71 seconds
- focused: exit 0, 5.88 seconds
- regressions: exit 0, 48.51 seconds
- constraints: exit 0, 34.01 seconds
