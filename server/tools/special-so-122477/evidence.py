"""Render measured SO confirmation evidence without disclosing operational snapshots."""
import datetime
import hashlib
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[3]
ART = ROOT / 'server/test-artifacts/special-so-122477'
STATE = pathlib.Path('/home/ubuntu/operatorapp-deploy-backups/special-so-122477-20261010')
load = lambda name: json.loads((ART / name).read_text())
manifest = load('manifest.json')
final, shuffled = load('final-summary.json'), load('shuffled-summary.json')
coverage, static = load('changed-coverage.json'), load('static-comparison.json')
assert not final['newFailures'] and not shuffled['newFailures']
assert not coverage['uncovered'] and not static['newTypes'] and not static['newLint']
focused = [r for r in load('final.json') if 'special-so-creation' in r['file']]
assert all(r['exitCode'] == 0 for r in focused)
mutations = load('mutations/results.json')
assert all(r['killed'] for r in mutations)
assert '# pass 1\n# fail 0' in (ART / 'worker-webhook.log').read_text()
verified = sorted(STATE.glob('verify-*.private.json'))[-1]
recovered = sorted(STATE.glob('recover-*.private.json'))[-1]
verification = json.loads(verified.read_text())['summary']
recovery = json.loads(recovered.read_text())['summary']
assert verification['verified'] and recovery['recovered']
assert verification['netSuiteWrites'] == recovery['netSuiteWrites'] == 0
sources = {name: value['after'] for name, value in manifest['changes'].items()}
assert all(hashlib.sha256((ROOT / 'server' / name).read_bytes()).hexdigest() == value for name, value in sources.items())
evidence = {
    'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'specApproval': 'not obtained (autonomous run)',
    'explicitUserRule': 'Confirm SO number and successful creation; do not check content',
    'sourceHashes': sources, 'baselineImages': manifest['baseImages'],
    'focused': {'files': len(focused), 'tests': sum(r['tests'] for r in focused), 'passed': sum(r['pass'] for r in focused)},
    'regressions': final, 'orderIndependence': shuffled, 'changedCoverage': coverage,
    'static': static, 'mutations': mutations, 'workerRegression': {'beforeFailed': True, 'afterPassed': True},
    'deployed': load('deployed.json'), 'recovery': recovery, 'verification': verification,
    'replayCommand': 'bash server/tools/special-so-122477-gauntlet.sh',
    'sourceArchive': load('source-contexts.json'),
    'limits': ['Existing special-order tests and compiler diagnostics remain; comparison requires zero new failures.',
               'Automatic checks cover SO creation/recovery; later PO and reviewed adjustment operations still resolve their own identities.',
               'Production recovery exercises the read-only NetSuite boundary and real local repository; no live creation smoke test was performed.'],
    'iterations': ['Corrected an initial read-only diagnostic SuiteQL alias and retained failure logs.',
                   'Corrected test fixtures for enquiry UOM, case-line/inventory foreign keys, and audience-specific cost visibility; assertions retained.',
                   'Added the explicit null marker-location argument after static analysis caught its omission.',
                   'Replaced three legacy verification assertions to reflect the user-requested confirmation rule.'],
    'skipped': {'dependencyAudit': 'No dependency change; existing pinned tooling reused.',
                'migrationRollback': 'No migration or schema change.',
                'newBrowserTests': 'No UI or browser code change.'}
}
(ART / 'evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
text = f"""# SO creation confirmation evidence

SOB122477 is linked to SPREQ-000063 through its original request marker and
operation. SO creation and recovery confirm its NetSuite identity and number
without comparing customer, yard, items, quantities, UOM, prices, or discounts.
NetSuite writes during recovery: **0**. Historical request rows and submission
marker were preserved. Both application and webhook-worker patches are deployed
and local/public health checks pass.

- New regression tests: **{evidence['focused']['passed']}/{evidence['focused']['tests']}** passed.
- Broad special-order suite: {final['tests']} tests in {final['files']} files;
  **0 new failures**, with {final['baselineFailedFiles']} pre-existing failing files.
- Shuffled execution: {shuffled['tests']} tests; **0 new failures**.
- Changed executable lines: **{coverage['covered']}/{coverage['executable']}** covered.
- Manual mutants: **{sum(not r['propertyOnly'] for r in mutations)}** killed;
  **{sum(r['propertyOnly'] for r in mutations)}** also killed by properties alone.
- Worker webhook regression failed before and passed after the minimal guard.
- Static analysis: **0 new type errors or lint warnings**; existing compiler
  diagnostics: {static['baselineTypes']} baseline / {static['finalTypes']} final.

The user explicitly changed the confirmation rule. Written spec approval was
not obtained (autonomous run). Source hashes, measured results, prior fixture
corrections, and limits are in [evidence.json](evidence.json).

Replay with `bash server/tools/special-so-122477-gauntlet.sh`. It uses the archived
source context and the standard bounded disposable Compose runner. Teardown
removes test containers, databases, volumes and networks even after failure.
The archive contains source code, not production credentials or databases.
The read-only deployed check is `python3 server/tools/special-so-122477/run.py verify`.

Behavior mapping:

| Requirement | Check |
| --- | --- |
| SO number confirms creation, with no content verification | special-so-creation-confirmation unit tests |
| Changed memo/customer/yard cannot hide the request-marked SO | special-so-creation-marker tests and seeded properties |
| Missing/ambiguous identity cannot link or resubmit | confirmation guard tests and mutants |
| Mirror differences cannot turn SO creation into attention | real repository and worker webhook tests |
| Native PO resolves identities at its own boundary | real repository PO-claim test and existing regression suite |
| SOB122477 is linked without a NetSuite write | private before/recovery/verification audits; public summaries above |

Dependencies, migrations and browser code were unchanged. No live SO was created
for testing. Existing failures limit confidence in unrelated Special Request
features; the change is held to zero additional failures.
"""
(ART / 'EVIDENCE.md').write_text(text)
print(json.dumps({'evidenceSaved': True, 'focusedPassed': evidence['focused']['passed'],
                  'newFailures': len(final['newFailures']), 'changedLinesCovered': coverage['covered'],
                  'linked': verification['salesOrderRef'], 'request': verification['requestRef']}))
