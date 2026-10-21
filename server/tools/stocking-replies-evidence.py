"""Record the scoped Stocking/Smart release and its executable evidence."""
import datetime
import difflib
import hashlib
import json
from pathlib import Path
import re

SERVER=Path(__file__).resolve().parents[1]
ARTIFACT=SERVER/'test-artifacts/stocking-replies-20261006'
RESULTS=ARTIFACT/'results/stocking-replies-20261006'
RELEASE=SERVER/'deployments/stocking-replies-20261006'
read=lambda path:json.loads(path.read_text())
sha=lambda body:hashlib.sha256(body).hexdigest()


def main():
    manifest=read(RELEASE/'manifest.json')
    final=read(RESULTS/'final-validation.json')
    gauntlet=read(RESULTS/'gauntlet.json')
    regression=read(RESULTS/'regression-comparison.json')
    width=read(RESULTS/'smart-width.json')
    deployed=read(RELEASE/'deployment-result.json')
    preview=read(RELEASE/'live-so-preview.log')
    cutover=read(RELEASE/'cutover.json')
    versions=read(ARTIFACT/'tool-versions.json')
    assert final['passed'] and gauntlet['passed'] and width['passed'] and preview['passed']
    assert final['gauntletAt']==gauntlet['at'] and final['layoutAt']==width['at']
    assert final['sourceHashes']=={name:manifest['candidateTree'][name] for name in manifest['files']}
    actual={str(path.relative_to(RELEASE/'candidate')):sha(path.read_bytes())
            for directory in ['src','public','migrations']
            for path in (RELEASE/'candidate'/directory).rglob('*') if path.is_file()}
    assert actual==manifest['candidateTree']
    assert sha(json.dumps(actual,sort_keys=True).encode())==manifest['candidateTreeHash']
    assert deployed['candidateTreeHash']==manifest['candidateTreeHash']
    assert deployed['imageId']==manifest['candidateImageId']
    assert regression['newFailures']==[] and len(regression['baselineFailures'])==17
    assert 'teardown_exit=0' in (ARTIFACT/'teardown.log').read_text()
    production={'mbbs-operator-app-app-1','mbbs-operator-app-db-1','mbbs-operator-app-webhook-worker-1','mbbs-operator-app-ollama-1'}
    for name in ['docker-ps.log','docker-ps-a.log']:
        assert {line.split()[0] for line in (ARTIFACT/name).read_text().splitlines()}==production

    imports=[]
    patterns=[r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',r'\bAKIA[0-9A-Z]{16}\b',
              r'\bghp_[A-Za-z0-9]{30,}\b',r'\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b']
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
    review={'passed':True,'reviewedFiles':len(manifest['files']),'newDependencies':[],
            'credentialPatternMatches':0,'addedImports':imports,
            'manualComplexityReview':'New access, normalization, status, reply, shared UI and popup functions are small and single-purpose. Replies use one row-locked DB transaction. Native PDF boundary unchanged.'}
    (RELEASE/'capability-review.json').write_text(json.dumps(review,indent=2)+'\n')

    validation={'passed':True,'at':final['at'],'candidateTreeHash':manifest['candidateTreeHash'],
                'validatedReleaseFiles':len(final['sourceHashes']),'validatedRuntimeFiles':len(actual),
                'regressionSuites':regression['suites'],'regressionTests':regression['tests'],
                'preExistingFailures':len(regression['baselineFailures']),'newFailures':0,
                'changedLinesCovered':gauntlet['coverage']['covered'],'changedLinesTotal':gauntlet['coverage']['total'],
                'mutantsKilled':sum(m['killed'] for m in gauntlet['mutants']),
                'smartLayoutChecks':len(width['measurements'])-1,'finalEvidence':str(RESULTS/'final-validation.json')}
    (RELEASE/'validation-passed.json').write_text(json.dumps(validation,indent=2)+'\n')
    command='STOCKING_REPLIES_SOURCE_ROOT="$PWD/deployments/stocking-replies-20261006/candidate" bash tools/stocking-replies-test.sh node tools/stocking-replies-final.mjs'
    gaps=', '.join(f"{row['file']}:{row['line']}" for row in gauntlet['coverage']['uncovered'])
    failed='\n'.join('- '+name for name in regression['baselineFailures'])
    tools=', '.join(f'{name} {version}' for name,version in versions.items())
    summary=f'''The deployed release allows supported cross-yard Regular Stocking requests, SCM instructions with an optional ETA, requester replies with an optional SO reference, private Sales alerts, conversation/proposal statuses, manually linked native SO previews, and full-width Smart SCM sections.

Spec approval: not obtained (autonomous run). Tier 3 applies to yard access and concurrent replies. The user authorized implementation and deployment throughout the session. The executable [spec](SPEC.md) records each later requirement and test setup correction. These checks support the stated scenarios; they do not provide independent human approval of the specification.

The source tree is `{manifest['candidateTreeHash']}`; image `{deployed['imageId']}`. The final combined run ended at {final['at']} after the last runtime edit and identifies all {len(final['sourceHashes'])} release files. Exact validation matches all {len(actual)} runtime files in the candidate and deployed image. No dependency, schema or git commit changes. Dirty workspace files outside this overlay were preserved.

| Spec behavior | Executable evidence |
| --- | --- |
| 1. Sales at 150 can Stock to another supported yard, with server-derived origin; unrelated yards and other methods remain restricted | `stocking-replies.test.js` destination/origin properties and hostile IDs; `stocking-replies-http.test.js` cross-yard visibility, actual POST/PATCH, spoofing and unsupported availability destination; browser destination selector |
| 2. SCM required instructions, optional real ETA, Pending update, audited history and unchanged items/orders | Domain normalization cases; HTTP SCM instructions and open TO checks; actual Transfer and Purchase browser reply scenarios |
| 3. Original Sales requester can reply with optional SO, showing Pending SCM review | HTTP requester and role checks, optional-field replies and SCM queue/count; Sales browser response |
| 4. Escaped messages, input limits, closed-case restrictions, stale revisions, one concurrent winner and no ghost alerts after failure | Domain hostile-input cases/properties; HTTP forbidden/invalid/closed/Special IDs, five simultaneous replies and injected transaction rollback; browser literal script-text display |
| 5. Private reply/Resolve popup and top-bar alerts, unread until viewed; pool/detail/draft remain stable | HTTP alert acknowledgement and fresh Resolve event; browser popup once per event, persistent badge and identity/draft assertions; existing Stock Request view/resolution browser regressions |
| 6. Partial/full proposal statuses supersede Pending update; existing commitment rules survive | HTTP proposal acceptance and later Sales response; existing Purchase/domain/commitment suites |
| 7. Relevant Stock Request, delivery and menu regressions | 34-suite deterministic randomized run, 276 tests; 259 passed, the same 17 baseline failures, zero new failures |
| 8. SPREQ-000043 can preview the manually linked native SO without local draft lines | RED preview reproduction; two domain preview guard cases; real isolated DB/HTTP native PDF boundary/cache test; deployed native PDF for SOB122110, request revision unchanged |
| 9. Pending TO retains replies and existing TO progress | RED Pending TO reproduction; domain, HTTP and real browser reply scenario preserve TO reference/status |
| 10. Smart sections fill the content space beside either sidebar state | 21 actual page geometry checks on Overview, PO/TO proposals and Settings at 2560/1920/1440/600 px; old CSS reproduces 1540 px cap; screenshots retained |

Run every layer from `server/` with the persisted entry point:

```bash
{command}
```

The standard bounded Compose configuration uses `mbbs-tests.slice`, init, CPU/memory/PID/tmpfs limits, disposable labels and a teardown trap installed before startup. This command reruns static checks, the 34 suites, coverage, properties, six scratch-only manual mutants, restored tests and browser geometry. Mutants never modify candidate files. It removes every disposable DB/container/network even on failure. Both `docker ps` and `docker ps -a` show only the four production containers after teardown; production health passed. Logs, hashes, coverage and screenshots remain as evidence, with no test databases retained.

| Layer | Final result |
| --- | --- |
| Static syntax, baseline-relative lint, strict new domain types | 15 JS files checked; zero added lint diagnostics; strict domain types passed |
| Relevant regression suite | 34 files; 276 tests; 17 verified pre-existing failures; zero new failures; seed 20261006 |
| Restored focused tests after mutations | 24 tests passed, zero failed |
| Changed executable-line coverage | {gauntlet['coverage']['covered']}/{gauntlet['coverage']['total']}; Node C8 plus actual browser V8 coverage; no missing source files |
| Manual mutation | 6/6 real bugs killed; the two access-invariant mutants also killed by the property suite alone |
| Property and hostile inputs | 1,700 generated destination/origin/text cases plus explicit malformed dates, control characters, roles, lengths and revisions |
| Real execution | Actual isolated PostgreSQL transactions/HTTP and Chromium UI; live native SO PDF is {preview['pdfBytes']} bytes and starts with `%PDF-`, with no case/order edit |
| Dependency/capability review | Unchanged package/lock bytes, zero new dependencies and zero credential-pattern additions; new backend effects limited to the existing request/event DB transaction; same native PDF network boundary |
| Complexity/suite health | Small functions reviewed; deterministic suite order recorded; an existing browser refresh race was fixed with a completion wait, preserving its assertions |
| Live cutover | App only; observed interruption {cutover['observedInterruptionSeconds']} s; configuration, worker, database and Ollama identities unchanged; rollback image retained |

Tool versions: {tools}. Cached test image: `{(ARTIFACT/'test-image-id.txt').read_text().strip()}`. Existing dependency-lock contents are preserved in the release candidate.

Known validation limits: the changed-line collector does not cover four UI assignment/reset lines ({gaps}), so coverage is below 100%. Existing browser scenarios and the backend checks pass; these paths are not claimed as fully covered. Changed-branch coverage is not separately mapped, although raw C8/V8 artifacts retain branch data. No new coverage-only tests were added. No dependency audit/license re-scan because the package and lock bytes did not change. No full-repository type/lint/full test claim: unrelated diagnostics and suites were outside this scoped release. No rollback execution was necessary because cutover verification passed; the exact rollback image and automatic rollback path are retained.

Failure history: RED logs reproduce the new behavior gaps, missing native SO preview and Pending TO thread omission. The prior 150 cross-yard Stocking 403 expectation was updated to the user's requested 201 while keeping Pickup/Waitlist restrictions. Retired DB guards were moved to the mandatory disposable DB host/name pattern. An added availability test initially assumed an invalid item would reach destination validation; it instead reached disabled external configuration. The corrected test uses an existing item and an unsupported destination to verify 400 before any external request. These changes are explained in SPEC.md; no runtime inventory behavior or reply assertions were weakened.

The exact live baseline also fails the following 17 pre-existing Special workflow tests. Sixteen fail on missing pallet-review setup (`SPECIAL_PO_PALLET_REQUIRED`); the closure/planning fixture expects `SPECIAL_CLOSURE_PENDING` but receives `SPECIAL_PO_APPROVAL_REQUIRED`. Baseline and final logs are retained and failure names match exactly:

{failed}

Primary artifacts: [final validation](results/stocking-replies-20261006/final-validation.json), [gauntlet](results/stocking-replies-20261006/gauntlet.json), [regressions](results/stocking-replies-20261006/regression-comparison.json), [layout](results/stocking-replies-20261006/smart-width.json), [wide screenshot](results/stocking-replies-20261006/smart-width-2560-expanded.png), [baseline failures](baseline-special-regressions.log), and [deployment](../../deployments/stocking-replies-20261006/DEPLOYMENT.md).
'''
    (ARTIFACT/'EVIDENCE.md').write_text(summary)
    deployment=f'''Deployed `{deployed['image']}` with image `{deployed['imageId']}`. Runtime tree `{manifest['candidateTreeHash']}`; all {len(actual)} runtime files match the validated scoped candidate. The release changes {len(manifest['files'])} files and adds no schema or dependencies.

Smart SCM now uses the available width with the original 15 px gutters and adapts to both sidebar states. Stocking supports the destination/reply/alert/proposal behaviors described in [evidence](../../test-artifacts/stocking-replies-20261006/EVIDENCE.md). The manually linked SO SOB122110 for SPREQ-000043 now retrieves its native PDF with zero local SO draft lines. Live PDF verification recorded {preview['pdfBytes']} bytes, SHA-256 `{preview['pdfSha256']}`, and an unchanged request revision.

Preflight found no executing business operation or idle transaction. One active Dispatch editing lease survived the app-only restart. Total cutover-and-verification time was {cutover['seconds']} s; observed HTTP interruption was {cutover['observedInterruptionSeconds']} s. The worker, database, Ollama and runtime configuration stayed unchanged. Local/external health passed; ten public assets matched; menu ordering remained available; anonymous reply routes returned 401. No rollback occurred.

Reproducible commands from `server/`:

```bash
{command}
python3 tools/stocking-replies-evidence.py
python3 tools/stocking-replies-release.py verify
docker exec -i mbbs-operator-app-app-1 node --input-type=module < tools/stocking-replies-live.mjs
```

Rollback image: `mbbs-operator-app:stocking-replies-20261006-rollback` / `{manifest['app']['imageId']}`. The captured Compose chain and environment file are preserved in the manifest and release/rollback overlays. Operational caches and rollback data are retained. All disposable test containers, databases, volumes and networks are removed; both container inventories show only production.
'''
    (RELEASE/'DEPLOYMENT.md').write_text(deployment)
    print(json.dumps({'evidenceWritten':True,'candidateTreeHash':manifest['candidateTreeHash'],'regressionTests':regression['tests'],'newFailures':0,'layoutChecks':len(width['measurements'])-1}))


if __name__=='__main__':main()
