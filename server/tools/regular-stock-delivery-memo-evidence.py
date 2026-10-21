"""Produce evidence from the final checks and verified test-site release."""
import hashlib
import json
from pathlib import Path

server = Path(__file__).resolve().parents[1]
out = server / 'test-artifacts/regular-stock-delivery-memo'
checks = json.loads((out / 'checks.json').read_text())
layers = json.loads((out / 'all-results.json').read_text())
summary = json.loads((out / 'all-regressions.log').read_text().splitlines()[0])
release = json.loads((server / 'deployments/regular-stock-delivery-memo-20260930/result.json').read_text())
assert all(row['exitCode'] == 0 for row in layers)
assert not summary['newFailures'] and release['deployed']
assert checks['sourceHashes'] == {file: hashlib.sha256((server / file).read_bytes()).hexdigest() for file in checks['sourceHashes']}
observed_failures = [name for row in json.loads((out / 'regular-stock-v2/tests-results.json').read_text()) for name in row['knownFailures']]
coverage = checks['coverage']
assert not coverage['uncovered'] and not coverage['missingFiles']
text = f'''# Delivery TO memo — evidence

Spec approval: not obtained (autonomous run). Tier 2. [Acceptance spec](regular-stock-delivery-memo-spec.md).

- {summary['passed']} regression tests passed, {summary['baselineFixtureFailures']} unchanged baseline fixture failures, zero new failures.
- Changed executable lines: {coverage['covered']}/{coverage['total']}; changed branches: {coverage['branches']['covered']}/{coverage['branches']['total']}.
- {len(checks['mutants'])}/{len(checks['mutants'])} manual mutants killed; SO-memo omission also killed by the property suite alone.
- {len(checks['suiteOrder'])} suites passed in shuffled order (seed {checks['shuffleSeed']}); project type checks passed, zero new lint diagnostics, syntax checks passed for all three changed files.
- Runtime source manifest SHA-256: `{checks['sourceTreeSha256']}`. Shared dirty workspace preserved; no commits made.
- Deployed `{release['image']}` at {release['at']}; image `{release['imageId']}`. App configuration, worker and dependencies preserved; no schema changes.

## Acceptance coverage

`test/mbt/integration/regular-stock-external-workflow.test.js` runs real application HTTP submission, repository, NetSuite adapter, approval, mirroring and print-queue code. Only the external HTTP transport is stubbed. Both normal creation and loss of the creation response assert the canonical SO memo, one TO, one print job and successful replay. The remote fixture only returns TOs whose actual memo marker or external ID matches the query. Existing legacy and Stocking cases continue to pass with marker recovery.

`test/mbt/unit/regular-stock-delivery-memo.test.js` checks 100 generated SO references/quantities (seed 121732), stable external identity, unchanged legacy/Pickup/Stocking memos and rejection of invalid/injected request identities. Existing domain tests retain duplicate and wrong-route recovery rejection; the complete related suite covers Base/Target direction, quantity/PALLET rules, approval and printing.

Mutants independently omit the SO memo, omit the recovery request identity, change the external-ID prefix and alter the legacy memo. All fail on behavioral assertions. Sources are restored and tests rerun after mutation.

## Reproduce

From `server/`, run `python3 tools/regular-stock-delivery-memo-check.py all`. This runs disposable migrations, focused tests, the full related suite with coverage, existing project type checks, lint, shuffled tests, properties, mutants, changed-line coverage and a scoped secret/capability scan. Existing Node test and PostgreSQL18 Docker images are used on an internal network with direct NetSuite access disabled. Toolchain: `{json.dumps(checks['toolchain'], sort_keys=True)}`.

Deploy using `python3 tools/regular-stock-delivery-memo-deploy.py prepare`, then `apply`; `verify` repeats read-only deployed checks. The release verifies the complete runtime source tree and health, pins the previous image for rollback, and waits for no active operations. Only the three runtime files in `tools/regular-stock-delivery-memo-files.json` are overlaid. Generate this report using `python3 tools/regular-stock-delivery-memo-evidence.py`.

The read-only NetSuite schema probe `tools/regular-stock-delivery-memo-netsuite.mjs` confirmed support for the external-ID query. The deployed checks validate payload behavior and read any recent saved Delivery transfers. No live TOs were created or amended, and no live print jobs were submitted.

## Failures and limits

The initial RED run failed both HTTP memo scenarios, the generated memo property and invalid identity rejection (four failures); it is retained in `test-artifacts/regular-stock-delivery-memo/red.log`. Assertions were retained through the fix. The existing legacy memo assertion was already green and its negative sensitivity was verified by the legacy-memo mutant.

The accepted pre-existing failure baseline lists `src/smart-scm-harness.js` ("Expected active item_master input") and `src/smart-scm-vendor-alternative-harness.js` ("is out of range for type integer"). The final run observed {len(observed_failures)} of these: `{', '.join(observed_failures)}`; the other previously failing fixture passed in this run. The accepted baseline file remains unchanged. No new dependencies or package changes; dependency/license audits were not rerun. No new network destination or credential capability. No new functions or schema complexity.

Browser checks were skipped because no UI files changed; actual HTTP execution covers this backend-only change. Existing project type checks apply to its annotated modules; the legacy JavaScript adapters are not fully statically typed. External failure tests simulate the transport boundary; a real TO creation and physical printing were deliberately not performed. Historical TO memos are not bulk-updated.

Final layer timings:
''' + '\n'.join(f"- {row['layer']}: exit {row['exitCode']}, {row['seconds']} seconds" for row in layers) + '\n'
path = server / 'test/regular-stock-delivery-memo-evidence.md'
path.write_text(text)
print(json.dumps({'evidence': str(path), 'tests': summary, 'coverage': coverage, 'mutants': len(checks['mutants'])}))
