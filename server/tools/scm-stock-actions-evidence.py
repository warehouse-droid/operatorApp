"""Record the scoped SCM actions release and executable evidence."""
import difflib
import hashlib
import json
from pathlib import Path
import re
import sys

SERVER=Path(__file__).resolve().parents[1]
ARTIFACT=SERVER/'test-artifacts/scm-stock-actions-20261006'
RESULTS=ARTIFACT/'results/scm-stock-actions-20261006'
RELEASE=SERVER/'deployments/scm-stock-actions-20261006'
read=lambda path:json.loads(path.read_text())
sha=lambda body:hashlib.sha256(body).hexdigest()


def validate():
    manifest=read(RELEASE/'manifest.json')
    final=read(RESULTS/'final-validation.json')
    gauntlet=read(RESULTS/'gauntlet.json')
    regression=read(RESULTS/'regression-comparison.json')
    layout=read(RESULTS/'smart-font-layout.json')
    assert final['passed'] and gauntlet['passed'] and layout['passed']
    assert final['gauntletAt']==gauntlet['at'] and final['layoutAt']==layout['at']
    for name,digest in final['sourceHashes'].items():
        assert digest==manifest['candidateTree'][name],name
    assert set(manifest['files'])<=set(final['sourceHashes'])
    actual={str(path.relative_to(RELEASE/'candidate')):sha(path.read_bytes())
            for directory in ['src','public','migrations']
            for path in (RELEASE/'candidate'/directory).rglob('*') if path.is_file()}
    assert actual==manifest['candidateTree']
    assert sha(json.dumps(actual,sort_keys=True).encode())==manifest['candidateTreeHash']
    assert not regression['newFailures'] and len(regression['baselineFailures'])==17
    assert 'teardown_exit=0' in (ARTIFACT/'teardown.log').read_text()
    production={'mbbs-operator-app-app-1','mbbs-operator-app-db-1','mbbs-operator-app-webhook-worker-1','mbbs-operator-app-ollama-1'}
    for name in ['docker-ps.log','docker-ps-a.log']:
        assert {line.split()[0] for line in (ARTIFACT/name).read_text().splitlines()}==production
    imports=[]
    patterns=[r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',r'\bAKIA[0-9A-Z]{16}\b',r'\bghp_[A-Za-z0-9]{30,}\b',r'\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b']
    for name in manifest['files']:
        before=RELEASE/'before'/name
        old=before.read_text().splitlines() if before.exists() else []
        new=(RELEASE/'candidate'/name).read_text().splitlines()
        for line in difflib.unified_diff(old,new):
            if not line.startswith('+') or line.startswith('+++'):continue
            assert not any(re.search(pattern,line[1:]) for pattern in patterns),name
            if re.search(r'\bimport\b|\brequire\(',line):imports.append({'file':name,'addedImport':line[1:].strip()})
    for name in ['package.json','package-lock.json']:
        assert (RELEASE/'before'/name).read_bytes()==(RELEASE/'candidate'/name).read_bytes()
    (RELEASE/'capability-review.json').write_text(json.dumps({'passed':True,'reviewedFiles':len(manifest['files']),
        'newDependencies':[],'credentialPatternMatches':0,'addedImports':imports,
        'complexityReview':'Transition splits eligibility, child creation and ledger command; one existing waitlist transaction. Small shared dialog and origin predicate. Font preference changes CSS and controls without a render. No remote order calls.'},indent=2)+'\n')
    validation={'passed':True,'at':final['at'],'candidateTreeHash':manifest['candidateTreeHash'],
        'validatedReleaseFiles':len(manifest['files']),'validatedRuntimeFiles':len(actual),
        'regressionSuites':regression['suites'],'regressionTests':regression['tests'],
        'preExistingFailures':len(regression['baselineFailures']),'newFailures':0,
        'changedLinesCovered':gauntlet['coverage']['covered'],'changedLinesTotal':gauntlet['coverage']['total'],
        'mutantsKilled':sum(m['killed'] for m in gauntlet['mutants']),'fontLayoutChecks':len(layout['measurements']),
        'finalEvidence':str(RESULTS/'final-validation.json')}
    (RELEASE/'validation-passed.json').write_text(json.dumps(validation,indent=2)+'\n')
    print(json.dumps(validation))
    return manifest,final,gauntlet,regression,layout,validation


def evidence():
    manifest,final,gauntlet,regression,layout,validation=validate()
    deployed=read(RELEASE/'deployment-result.json')
    cutover=read(RELEASE/'cutover.json')
    leases=read(RELEASE/'editing-lease-result.json')
    versions=', '.join(f'{name} {version}' for name,version in read(ARTIFACT/'tool-versions.json').items())
    assert deployed['candidateTreeHash']==manifest['candidateTreeHash'] and deployed['imageId']==manifest['candidateImageId']
    command='SCM_STOCK_ACTIONS_SOURCE_ROOT="$PWD/deployments/scm-stock-actions-20261006/candidate" bash tools/scm-stock-actions-test.sh node tools/scm-stock-actions-final.mjs'
    gap_count=len(gauntlet['coverage']['uncovered'])
    failures='\n'.join('- '+name for name in regression['baselineFailures'])
    text=f'''Deployed SCM Reply alignment, per-line Convert to waitlist, and persistent Smart SCM A−/A+ font controls. Converted lines show the linked Waitlist to Sales and SCM; the SCM link opens and focuses the waiting request. Smart font size spans 80–160% in 10% steps and preserves current input while adjusting.

Spec approval was not obtained (autonomous run); the user's implementation/deployment authorization applies. Tier 3 covers stock commitment, concurrency and yard access. The executable [spec](SPEC.md) records requirements, failure model and RED fixture corrections. No dependency, migration or git commit changes. Unrelated dirty workspace changes are excluded by a zero-fuzz delta on the exact live source.

Validated runtime tree: `{manifest['candidateTreeHash']}`; deployed image `{deployed['imageId']}`. All {validation['validatedRuntimeFiles']} runtime files match the candidate; {validation['validatedReleaseFiles']} files change. Final validation completed {final['at']} after the last runtime edit. One unchanged repository file is also checked as a reference. The mounted candidate remains read-only throughout tests.

| Spec behavior | Evidence |
| --- | --- |
| Reply shares the existing SCM action row | Actual Chromium Transfer, Purchase and Pending TO parent-element checks; one Reply button; existing reply browser suites |
| Whole saved line becomes one linked Waiting request | Isolated PostgreSQL/HTTP Transfer and Purchase cases preserve exact decimal quantity, item, unit, original Sales requester and yard; untouched sibling line; last moved line completes source |
| Existing committed demand cannot move | Actual Purchase demand, TO line and SO ownership guards; resolved/closed/Pickup guard cases; existing Waitlist safety and Regular Stocking/Purchase suites |
| No duplicates or partial writes | Idempotent replay and conflicting-key case; five concurrent operations yield one child; injected retirement trigger failure rolls back child, revision, audit and receipt |
| Preserve origin Sales access without spoofing | Actual cross-yard detail/list/close; unrelated Sales forbidden; arbitrary Waitlist origin submission forbidden; 600 seeded positive/negative lineage and workflow cases |
| Private Sales update and visible result | Real HTTP alert points to child; shared UI moved status and linked request; real SCM browser customer selection and deep-link navigation |
| Font controls preserve work and remember each user's preference | Actual computed input size and DOM identity, value preserved, reload/tab persistence, disabled 80/160% bounds; no operational POST from controls |
| Full width and header alignment with different text sizes | {len(layout['measurements'])} geometry checks at 2560/1920/1440/600 px, expanded/collapsed sidebar, Overview/PO-TO/Settings and 80/100/160%; observed header size equals sticky-tab offset; screenshots retained |

| Layer | Result |
| --- | --- |
| Static | 15 JS syntax checks, no new baseline-relative lint diagnostics, strict access/reply domain types pass |
| Relevant regressions | {regression['suites']} suites, {regression['tests']} tests; {regression['tests']-17} passed, 17 exact live baseline failures, zero new failures; deterministic order seed 20261006 |
| Manual mutation | Five stock/access bugs killed in scratch copies; both access mutants also fail the generated property suite alone |
| Changed executable line coverage | {gauntlet['coverage']['covered']}/{gauntlet['coverage']['total']}, Node C8 plus actual browser V8; {gap_count} uncovered lines; missing-file list: {gauntlet['coverage']['missingFiles']} |
| Generated properties | 600 new lineage/origin/workflow cases; existing Stocking (1,700), Regular (850), Waitlist (1,600) properties also retained |
| Execution boundaries | Real isolated PostgreSQL transactions and HTTP; real Chromium rendering with test API responses; no remote operational requests, inventory release or PO/TO edits |
| Live release | App only, observed interruption {cutover['observedInterruptionSeconds']} s; configuration and worker/database/Ollama identities preserved; active edit leases retained: {leases['retained']} |

Persisted entry point from `server/`:

```bash
{command}
```

This runs static, regressions, coverage, properties, mutations, restored focused checks, font/layout and final source validation. For the recorded run, the completed gauntlet was reused only after matching every JS source hash, then the layout/final layer ran. Every test uses standard isolated Compose with `mbbs-tests.slice`, init and bounded memory/CPU/PID/tmpfs. Teardown was registered before startup. Both `docker ps` and `docker ps -a` show only the four production containers; test containers, databases, volumes and networks were removed. Production health passed after teardown. Test logs/screenshots/coverage remain; disposable databases do not.

Tool versions: {versions}. Cached bounded test image: `{(ARTIFACT/'test-image-id.txt').read_text().strip()}`; its ID matches the prior recorded version probe.

Validation limits: changed branch coverage is not separately mapped. The {gap_count} uncovered changed lines are enumerated in [coverage](results/scm-stock-actions-20261006/changed-line-coverage.json); they are not claimed as executed. No full-repository lint/types/test or new dependency audit/license scan, because dependencies remain unchanged and unrelated workspace scope is preserved. Rollback was not executed; the exact previous image and automatic rollback path remain available.

Failure history: initial customer and quantity fixture errors and one browser syntax error were corrected before the behavioral RED. Saved original UI and the transition stub reproduced missing action/font/transition behavior. Static verification found one new prefer-const diagnostic, fixed before candidate validation. Browser coverage collection was corrected to retain counters before linked-page navigation; the same four browser scenarios passed on unchanged runtime source. All assertions and the transaction/authorization guards remain active. Baseline Special failures below were established on the exact previous live image; final names match. Sixteen concern missing pallet-review setup (`SPECIAL_PO_PALLET_REQUIRED`), and one closure fixture expects `SPECIAL_CLOSURE_PENDING` but reaches `SPECIAL_PO_APPROVAL_REQUIRED`.

{failures}

Primary artifacts: [final](results/scm-stock-actions-20261006/final-validation.json), [gauntlet](results/scm-stock-actions-20261006/gauntlet.json), [regressions](results/scm-stock-actions-20261006/regression-comparison.json), [layout](results/scm-stock-actions-20261006/smart-font-layout.json), [baseline](baseline-special-regressions.log), [deployment](../../deployments/scm-stock-actions-20261006/DEPLOYMENT.md).
'''
    (ARTIFACT/'EVIDENCE.md').write_text(text)
    (RELEASE/'DEPLOYMENT.md').write_text(f'''Deployed `{deployed['image']}` / `{deployed['imageId']}` at {deployed['at']}. Runtime tree `{manifest['candidateTreeHash']}`; all {validation['validatedRuntimeFiles']} runtime files match. {len(manifest['files'])} scoped changes; no schema or dependency changes.

Reply shares the existing SCM action row. Convert to waitlist moves an eligible uncommitted Stocking line through existing-customer selection into one linked request, preserving quantity, requester and yard. The moved line is retired, siblings remain, and Sales receives an update. Smart SCM A−/A+ remembers 80–160% font size per operator/browser without rebuilding the page.

Preflight found no executing business operation or idle transaction. Active Dispatch editing leases were retained: {leases['retained']}. App-only cutover and verification took {cutover['seconds']} s; observed HTTP interruption {cutover['observedInterruptionSeconds']} s. Runtime configuration, worker, database and Ollama stayed unchanged. Local and external health/assets passed, menu ordering remained available, and anonymous reply/conversion/customer routes returned 401. No rollback was needed.

[Validation evidence](../../test-artifacts/scm-stock-actions-20261006/EVIDENCE.md): {regression['suites']} suites / {regression['tests']} tests, zero new failures relative to the 17 established baseline failures; five mutants killed; {len(layout['measurements'])} font/layout checks. Every disposable test resource removed; both inventories contain only production.

```bash
{command}
python3 tools/scm-stock-actions-evidence.py evidence
python3 tools/scm-stock-actions-release.py verify
```

Rollback: `mbbs-operator-app:scm-stock-actions-20261006-rollback` / `{manifest['app']['imageId']}`. Captured Compose configuration and release/rollback overlays are retained. Production, rollback and operational audit data are preserved.
''')
    print(json.dumps({'evidenceWritten':True,'deployedImageId':deployed['imageId']}))


if __name__=='__main__':
    {'validate':validate,'evidence':evidence}[sys.argv[1]]()
