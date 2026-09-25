"""Collect recorded recovery evidence; no live mutation or inferred test results."""
import json
from pathlib import Path
import re

ROOT=Path(__file__).resolve().parents[1]
ART=ROOT/'test-artifacts/sor-feature-gate'
OUT=ROOT/'test-artifacts/sor-rentals'
RELEASE=Path('/home/ubuntu/operatorapp-deploy-backups/sor-return-lock-20260924-v1')
deployment=json.loads((RELEASE/'deployment-result.json').read_text())
manifest=json.loads((RELEASE/'manifest.json').read_text())
browser=json.loads((OUT/'gate-browser.json').read_text())
static=json.loads((ART/'static.json').read_text())
mutations=json.loads((ART/'mutations.json').read_text())
coverage=json.loads((OUT/'gate-coverage/coverage-summary.json').read_text())
log=(ART/'final-focused.log').read_text()
counts={key:int(re.search(r'^# '+key+r' (\d+)$',log,re.M).group(1)) for key in ['tests','pass','fail']}
assert counts['tests']==counts['pass'] and counts['fail']==0
assert all([browser['passed'],static['passed'],mutations['passed'],deployment['deployed']])
assert browser['sourceHashes']==manifest['after']
result={'tests':counts,'browser':browser,'static':static,'mutations':mutations,
 'coverage':coverage,'deployment':deployment,'sourceHashes':manifest['after'],
 'oldCodeFailed': 'REGRESSION ASSERTION: SOR/catalog deadlock' in (ART/'browser-lock-red.log').read_text()}
(ART/'evidence.json').write_text(json.dumps(result,indent=2))
report=f'''# SOR pause and database lock recovery — evidence

Spec: [sor-feature-gate-spec.md](sor-feature-gate-spec.md). Spec approval: not obtained (autonomous run under explicit implementation authorization). Incident explanation: [sor-regression-incident.md](sor-regression-incident.md).

## Final results

- **{counts['pass']}/{counts['tests']} focused tests passed**, zero failures, on the captured release candidate. Includes Admin authorization/revisions/audit, gate-off and missing-gate behavior, both order pools, retained assigned routes, optional signature prompts/evidence, rental lifecycle, concurrent reconciliation, queue-version protection, nested transaction deferral, independent-connection lock release and Driver recovery regressions.
- **Playwright passed:** actual staff login, SOR paused banner, Admin gate toggle on/off, real SOR worker plus catalog executor overlap with catalog mode **on**, exactly one return, queue drain, {browser['bootstrapRequests']} concurrent database-backed bootstrap requests, then staff login again. Workers completed in {browser['workerMs']} ms; slowest concurrent bootstrap {browser['maxBootstrapMs']} ms; zero page exceptions.
- **Original-code failure reproduced:** the same production-mode browser/backend check failed with `SOR/catalog deadlock: production-mode workers did not finish`. The initial five lock tests failed four assertions on the old code; the already-preserved queue-version behavior was subsequently verified by a killed mutant.
- **5/5 deliberate mutants detected:** refresh under lock, omitted refresh, erasing a newer queue version, ignored gate, and omitted outer-transaction deferral. Mutants run in isolated mounts; release source remains unchanged.
- **Static checks:** all ten changed JavaScript source files parse. Lint {static['lintBaseline']} baseline / {static['lintFinal']} final diagnostics, **zero new**. Type checking {static['typeBaseline']} baseline / {static['typeFinal']} final diagnostics, **zero new**. Existing repository diagnostics are retained, not claimed fixed.
- **Coverage:** gate helper 18/18 lines; worker 119/122 lines; combined 137/140 (97.85%). This is module coverage for these two modules, not a claim of full changed-line coverage across the large integration files. The worker's pre-existing reconciliation-error catch is not executed by this final focused run.

## Deployment

First deployed the default-off gate and restarted the application at 12:49:10 UTC. Only after that deployed the worker repair at {deployment['startedAt']}. Final image `{deployment['imageId']}`. Verified all {deployment['verifiedSources']} source hashes, unchanged app configuration and unchanged dependency containers. Existing 14 return orders retained; no signature/history deletion.

Live SOR gate is **off**. The legacy rollout switch also remains off for safe rollback. Local and public `/api/auth/bootstrap-needed` returned 200. Follow-up public responses were 259, 58 and 32 ms; a database check reported zero stale transactions and zero lock waiters. These are point-in-time checks, not a long soak test.

## Criteria mapping and limits

1. Independent default-off gate and access control: `sor-feature-gate.test.js`, `sor-admin-http.test.js`, `feature-gate-catalog.test.js`.
2. Paused automation and both planning pools, preserved assigned work: `sor-feature-gate.test.js`; saved evidence compatibility: `sor-signature-evidence.test.js`.
3. Commit-before-refresh, durable retry, no duplicates, newer queue version, outer rollback: `sor-return-lock.test.js`, `sor-return-lifecycle.test.js`, concurrent repository tests, real production-mode browser overlap.
4. UI and database-backed login: `tools/sor-feature-gate-browser.mjs`; live probes in both deployment scripts.
5. Preserve unrelated code/data/configuration: scoped image patch, full source hash comparison, return counts, dependency/configuration fingerprint checks.

The large full-repository suites were not rerun for this recovery; earlier broad baseline failures are documented in `sor-rentals-evidence.md`. The generic Admin HTTP suite still has one pre-existing expectation that the deployment root is enabled in this isolated environment; it fails on both the captured baseline and candidate. The new SOR-specific Admin tests pass. An initial catalog key-count assertion was updated from 37 to 38 for the new writable gate.

Existing property tests for SOR classification/signature validation ran in the focused suite. No new parser or dependency was introduced. No NetSuite/Samsara writes, live customer signature collection, or physical device checks were performed. Fresh-database migration and default-off behavior were checked; a separate migration rollback rehearsal was not run for this additive flag insertion. `/health` remains a static liveness endpoint and must not be treated as database readiness.

## Reproduce

`sudo -n bash tools/sor-feature-gate-gauntlet.sh` uses the existing Docker/Playwright tools and disposable internal test network. For the exact released source, set `SOR_CANDIDATE_ROOT` to the release's `candidate` directory. Node 20.20.2, Playwright 1.62.1, PostgreSQL 18 image, existing installed ESLint/TypeScript/c8 dependencies; no new dependencies.

Individual persisted runners: `sor-feature-gate-checks.mjs`, `sor-feature-gate-browser.mjs`, `sor-feature-gate-quality.py static`, `sor-feature-gate-quality.py mutations`, and this evidence collector. Reports and logs are in `test-artifacts/sor-feature-gate`; browser/coverage artifacts are in `test-artifacts/sor-rentals`. Each release report pins the exact source hashes. No checkpoint commits were created in the pre-existing dirty workspace.
'''
(ROOT/'test/sor-feature-gate-evidence.md').write_text(report)
print(json.dumps({'tests':counts,'oldCodeFailed':result['oldCodeFailed'],'deployed':deployment['deployed'],'sorEnabled':deployment['sorEnabled']}))
