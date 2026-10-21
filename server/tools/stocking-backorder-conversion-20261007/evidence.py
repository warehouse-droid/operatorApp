"""Render the task evidence from verified final-run and deployment artifacts."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

SERVER = Path(__file__).resolve().parents[2]
TOOLS = Path(__file__).resolve().parent
OUT = SERVER / 'test-artifacts/stocking-backorder-conversion-20261007'


def load(name):
    return json.loads((OUT / name).read_text())


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


summary = load('summary.json')
deployed = load('deployed.json')
cleanup = load('cleanup-final.json')
for key, root in [('manifest', SERVER), ('testManifest', SERVER), ('toolManifest', TOOLS)]:
    assert all(sha(root / name) == value for name, value in summary[key].items()), key + ' changed after final run'
assert sha(SERVER / 'package-lock.json') == summary['dependencyLockHash']
assert load('initial-state.json')['lockfileHash'] == summary['dependencyLockHash']
assert summary['newFailures'] == []
assert summary['focused']['fail'] == summary['reversed']['fail'] == 0
assert summary['types'] == summary['lint'] == summary['whitespace'] == 'pass'
assert summary['changedLines']['missing'] == []
assert all(row['killed'] for row in summary['mutations'])
assert deployed['deployed'] and deployed['health'] == 'healthy'
assert deployed['files'] == summary['manifest']
assert deployed['productionRequestsConvertedDuringValidation'] == 0
assert not cleanup['taskContainers'] and not cleanup['taskNetworks'] and not cleanup['taskVolumes']
assert not cleanup['disposableTests'] and cleanup['productionHealth'] is True

focused, reverse = summary['focused'], summary['reversed']
baseline, candidate = summary['regression']['baseline'], summary['regression']['candidate']
coverage = summary['changedLines']
mutants = summary['mutations']
types = summary['typeComparison']
report = f"""# Stocking → Backorder conversion evidence

Generated {datetime.now(timezone.utc).isoformat()}.

Spec approval: not obtained (autonomous run). The user selected **Whole request** and **SCM**, and authorized implementation and deployment after passing checks. This report demonstrates the stated executable criteria; it does not substitute for independent review of the criteria.

SCM can convert an entirely open, uncommitted Stocking Transfer or Purchase in place. The request keeps its ID/STREQ reference, requesting Sales store, customer, remarks, saved material descriptions, quantities, UOM, pack quantities and individual receiving yards. SCM confirms vendors and Pickup/Delivery in the dialog. The request starts the existing Backorder stock-review workflow. Existing TO/PO/SO commitments and closed lines prevent conversion.

## Final checks

| Layer | Observed result |
| --- | --- |
| Focused real HTTP, Chromium, workflow and property suites | {focused['pass']}/{focused['tests']} pass; {focused['fail']} failures; {focused['skipped']} skipped |
| Affected shared-suite baseline | {baseline['tests']} tests; {baseline['pass']} pass; {baseline['fail']} failures; {baseline['skipped']} skipped |
| Affected shared-suite candidate | {candidate['tests']} tests; {candidate['pass']} pass; {candidate['fail']} failures; {candidate['skipped']} skipped |
| New shared-suite failures | {len(summary['newFailures'])} |
| Changed executable lines | {coverage['covered']}/{coverage['total']} executed; annotation-only lines identified separately |
| Manual plausible mutants | {sum(row['killed'] for row in mutants)}/{len(mutants)} killed |
| Applicable mutants rerun against properties alone | {sum(row['propertyKilled'] for row in mutants)} killed |
| Reverse file order | {reverse['pass']}/{reverse['tests']} pass; {reverse['fail']} failures |
| Types | Baseline {types['baseline']}, candidate {types['candidate']}; {types['newErrors']} new errors |
| Lint, syntax, changed whitespace and secret scan | Passed |
| Packaged imports and deployed source hashes | Passed; {len(deployed['files'])} runtime files |
| Live application | Healthy; configuration preserved; {deployed['liveBackordersVerified']} existing Backorders checked read-only |
| Disposable test resources | All removed; production health passed |

Branch observations are recorded in `changed-coverage.json`; full branch coverage is not claimed. Existing failures/skips are retained verbatim in `regressions.json` and the baseline/candidate TAP logs. Dependency auditing is not repeated because no dependency or lockfile changed. No schema change, NetSuite order creation, or conversion of production requests occurred during validation. Real integration tests exercise transaction locks, an actual concurrent commitment, rollback injection, authenticated roles, and stale Stocking endpoints; external NetSuite writes are denied in the isolated environment.

Shared Backorder browser fixtures wait for initial queue and vendor-directory loading before interacting. The tests do not claim preservation of edits across a late vendor-directory redraw on the existing Backorder page. The observed startup race and dependent completion assertion are retained in `initial-vendor-browser-loading-failure/`; only fixture initialization changed, with workflow assertions and timeouts preserved.

## Acceptance mapping

| SPEC criterion | Evidence |
| --- | --- |
| 1: SCM-only whole conversion, same request and submission details | API: `SCM converts the entire…`, `only SCM can convert…`; Chromium Transfer/Purchase dialog |
| 2: eligibility, revisions, committed/terminal rows and atomic rejection | API invalid revision/terminal/commitment tests; seeded eligibility properties; concurrent commitment |
| 3: saved material values, regular items, independent vendors/yards, no prices | API saved-master and Delivery tests; 600 generated material cases; receiving-yard API and Chromium tests |
| 4: original Sales access, preserved audit and retired source rows | API whole-conversion snapshots/history and role tests; audit-history and Sales-yard mutants |
| 5: fulfillment validation, new enquiry, no native orders | API invalid inputs and Delivery tests; real dialog; external-write trap and before/after snapshots |
| 6: existing Backorder sequence and legacy-action guards | Shared workflow suites; stale Stocking endpoint test; old acknowledgement→new review/PO notification test |
| 7: atomic conversion, no duplicate and raced commitment retained | API simultaneous conversion, concurrent locked SO commitment, injected event failure rollback |
| 8: actual UI, escaping, cancel, errors, busy and audience | Chromium dialog, stale revision, Sales absence and material-edit tests; browser coverage logs/screenshots |

The first RED API attempt had an invalid pack-quantity fixture; it is retained separately and is not claimed as behavioral RED. Corrected API, browser and property RED logs exist at the artifact root. Later failures exposed database profile/retirement ordering, original submission date, preview authorization, fulfillment validation, delivery visibility, stale Stocking resolve actions, cross-yard Sales edits and notification read-state incompatibility; they were corrected and rechecked. Fixture corrections are appended visibly in SPEC.md. The first final pass detected all 15 faults but exposed a reporting filename collision: its stage summary overwrote the detailed mutation JSON. The reporting label was separated, array validation added, and final verification repeated against unchanged runtime source. The earlier pass is retained in `verification-report-format-failure/`. Assertions were not weakened to accept failures.

## Reproduce and identify the source

Run from the repository root:

```sh
python3 server/tools/stocking-backorder-conversion-20261007/run.py all
```

The runner uses the standard bounded isolated Compose configuration under `mbbs-tests.slice`, registers teardown before startup and removes its disposable database, volumes, networks and containers on exit. `summary.json` identifies runtime, tests, tooling and the unchanged dependency lockfile by SHA-256. Test tooling: Node {summary['node']}; {json.dumps(summary['versions'], sort_keys=True)}. Manual mutation commands and final evidence generation are persisted alongside the runner. Deployment uses the narrow tested source overlay, app-only replacement and an automatic rollback on failed verification.

Deployed application image: `{deployed['image']}`. Production configuration and the other three production services were preserved. Final `docker ps` and `docker ps -a` appear in `cleanup-final.json`. No test databases were retained.
"""
(TOOLS / 'EVIDENCE.md').write_text(report)
(OUT / 'evidence-generation.json').write_text(json.dumps({'evidence': str(TOOLS / 'EVIDENCE.md'), 'verified': True}, indent=2))
print(json.dumps({'evidence': str(TOOLS / 'EVIDENCE.md'), 'verified': True}))
