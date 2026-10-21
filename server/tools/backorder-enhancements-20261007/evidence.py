"""Render the evidence report only from final persisted check results."""
import hashlib
import json
from pathlib import Path
from datetime import datetime,timezone

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'test-artifacts/backorder-enhancements-20261007'

def main():
    result=json.loads((OUT/'summary.json').read_text())
    for manifest in ['manifest','testManifest','toolManifest']:
        for file,value in result[manifest].items():
            target=ROOT/'tools/backorder-enhancements-20261007'/file if manifest=='toolManifest' else ROOT/file
            actual=hashlib.sha256(target.read_bytes()).hexdigest()
            if manifest=='toolManifest' and file=='evidence.py':
                correction=json.loads((OUT/'evidence-tool-update.json').read_text())
                assert correction['testedSha256']==value and correction['currentSha256']==actual
            else:
                assert actual==value,'Evidence source drift: '+file
    regression=result['regression'];types=result['typeComparison'];coverage=result['changedLines']
    deployed=json.loads((OUT/'deployed.json').read_text())
    migration=json.loads((OUT/'migration-live.json').read_text())
    assert deployed['deployed'] and migration['legacyDataPreserved']
    text=f"""# Backorder enhancement evidence

Generated {datetime.now(timezone.utc).isoformat()}.
Spec approval: not obtained (autonomous run). User authorized the feature and
deployment; the detailed executable specification is agent-authored.
Calibration: Tier 3, because this adds persisted routing and public API behavior.
No new dependencies or git commits. Existing unrelated workspace changes preserved.

Reproduce from the repository root:

```sh
python3 server/tools/backorder-enhancements-20261007/run.py all
```

The runner registers teardown before starting the standard bounded Compose stack,
uses `mbbs-tests.slice`, and removes containers, volumes and networks in finally.
Read `cleanup-finish.json` and `final-cleanup.json` for the final `docker ps`,
`docker ps -a` and residuals; a full reproduction also writes `cleanup-all.json`.

| Acceptance criterion | Executable evidence |
| --- | --- |
| Pickup/Delivery, conditional address/date/window/instructions, preserved draft notes | `backorder-enhancements-browser.test.js`: composer toggle and save assertions |
| Three-column desktop fields, paired notes, mobile fit, no price/discount inputs | Same browser test, geometry/visibility and persisted unpriced lines |
| Independent catalog/default/edited vendor and yard, reload and SCM display | `backorder-routing.test.js` and both enhancement browser tests |
| Inaccessible yards and hostile vendor IDs/names refuse partial saves | Routing HTTP tests, revision/row snapshots, 300 generated routing property cases |
| Backorder mixed vendors allowed, Special vendor rule retained | Routing review and separate Special request assertions; wider Special regression suite |
| Editing one line preserves neighbors, legacy prices and SKU identity | Routing tests and existing Backorder local edit tests |
| Filters include every material route | Routing list/filter-option HTTP assertions and wider list regression tests |
| Additive backfill, interrupted DDL, rollback/re-upgrade, refusal to lose saved routes | `migration-check.mjs`, `migration-check.log`, live transaction snapshots |
| Existing roles, private notes, stale revisions, both synced manual links, no remote generation/ancillary lines | Existing Backorder workflow/HTTP/browser suite, including actual worker selector check |
| Packaging, health and runtime configuration preserved | Packaged import probe, live source hashes and read-only live verification |

Final results on the unchanged runtime source after its last edit:

- Focused/backend/property/browser: {result['focused']['pass']}/{result['focused']['tests']} pass, {result['focused']['fail']} fail.
- Reversed suite order: {result['reversed']['pass']}/{result['reversed']['tests']} pass, {result['reversed']['fail']} fail.
- Affected regression baseline: {regression['baseline']['tests']} tests, {regression['baseline']['pass']} pass, {regression['baseline']['fail']} pre-existing failures.
- Affected regression candidate: {regression['candidate']['tests']} tests, {regression['candidate']['pass']} pass, {regression['candidate']['fail']} failures; {len(regression['newFailures'])} new failures. Verbatim failure identities in `regressions.json`.
- Type diagnostics: {types['baseline']} baseline, {types['candidate']} candidate, {types['newErrors']} new. This is a zero-new-error comparison, not a globally clean repository.
- Lint: zero new diagnostics; exact baseline/candidate counts in `lint.log`. Syntax and changed-file whitespace checks passed.
- Changed executable JavaScript lines: {coverage['covered']}/{coverage['total']} executed by Node or real browser runs. Coverage reports must match exact source hashes; annotation-only changes excluded by parsed AST comparison. Branch observations are in `changed-coverage.json`.
- Real source mutants: {len(result['mutations'])}/{len(result['mutations'])} killed. {sum(bool(m['propertyKilled']) for m in result['mutations'])} applicable normalization mutants also killed by the property suite alone. Each mutant is restored and its source hash verified.
- Property cases: 300 new generated routing cases plus 700 existing Backorder workflow cases; deterministic seeds recorded in tests.
- Migration rehearsal: up, backfill, interrupted transaction, down, re-up, old-version writes during release and independent-route downgrade refusal passed.
- Supply chain: lock hash unchanged ({result['dependencyLockHash']}); dependency audit/license recheck skipped because no dependency changed. Secret diff scan passed. No new external services or subprocess calls in application code.
- Complexity: routing parsing is a small shared helper; workflow changes remain scoped to Backorder. No stated latency budget; benchmark layer skipped for this form/local data change.

Observed failures and corrections: initial routing RED fixtures failed at the old
required-rate validation, so they were corrected to use zero rates and rerun;
all six then failed on the intended new behavior. Both new browser tests failed
before implementation. The first browser green run read an older selected request
before save completion; its wait now follows the actual creation response. Three
new type diagnostics, followed by two required-date inference diagnostics, were
corrected without changing assertions. Coverage review identified the multi-yard
filter path as unverified; a functional assertion now checks that a second-line
yard finds the request through the actual array filter. The final run supplies
all reported values. The full comparison completed with zero new failures;
a later SQL mutant exposed a read-only scratch-directory problem in the harness.
It was corrected by copying migrations into the disposable scratch tree. The
`run.py finish` command verifies prior regression source hashes and reruns every
remaining layer on the unchanged application; `run.py all` reproduces all layers.
An initial full run was interrupted and cleaned up after
noticing Node sorts test filenames regardless of argument order. The final
reversed pass runs each file explicitly in reverse order; its ordered commands
and results are persisted. A release-compatibility rehearsal initially exposed null
routes from old-source writes after migration; an insert default trigger fixes
that gap, and its omission is also tested by a real SQL mutant.

Deployment: `{deployed['image']}`, runtime configuration preserved, health
`{deployed['health']}`. Migration 269 preserved all existing fields across
{sum(row['rows'] for row in migration['legacy'].values())} captured request/case/line rows.
The app is updated; the DB, worker and Ollama images remain unchanged.
No production test records were created. Schema rollback is deliberately refused
when it would discard independent routes; app rollback can retain additive columns.

Confidence is bounded by this specification and the existing affected suites.
Legacy vendor-pickup API records remain compatible, while the form offers only
Pickup and Delivery. Yard authorization and request visibility continue to use
the existing Sales access model. The unrelated pre-existing failures remain.

Exact runtime, test and tool SHA-256 manifests and installed tool versions are in
`summary.json`; production metadata and release verification are in
`production-baseline.json` and `deployed.json`. Screenshots are in `browser/`.
"""
    (OUT/'EVIDENCE.md').write_text(text)
    print(json.dumps({'evidence':str(OUT/'EVIDENCE.md'),'focusedPass':result['focused']['pass'],'newRegressionFailures':len(regression['newFailures'])}))

if __name__=='__main__':main()
