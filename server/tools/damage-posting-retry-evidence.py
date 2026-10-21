"""Compare controlled regression runs and the exact deployable damage source."""
import collections
import difflib
import hashlib
import json
from pathlib import Path
import re
import sys

SERVER=Path(__file__).resolve().parents[1]
OUT=SERVER/'test-artifacts/damage-posting-retry-20261001'
RELEASE=SERVER/'deployments/damage-posting-retry-20261001'
FILES=json.loads((SERVER/'tools/damage-posting-retry-files.json').read_text())
def save(name,value):
    (OUT/(name+'.json')).write_text(json.dumps(value,indent=2)+'\n')
    print(json.dumps(value))

def changed():
    result={}
    for file in FILES:
        if not file.endswith('.js'): continue
        before=RELEASE/'before'/file
        source=RELEASE/'candidate'/file
        old=before.read_text().splitlines() if before.exists() else []
        new=source.read_text().splitlines()
        lines=[]
        for operation,_,_,start,end in difflib.SequenceMatcher(a=old,b=new,autojunk=False).get_opcodes():
            if operation in ['replace','insert']: lines.extend(range(start+1,end+1))
        result[file]={'sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'lines':lines}
    save('changed-lines',result)

def suite(label):
    text=(OUT/(label+'-full.log')).read_text()
    files=re.findall(r'^\[isolation\] MBT main (\d+)/(\d+) (.+)$',text,re.M)
    assert files and len(files)==int(files[-1][1]) and files[-1][0]==files[-1][1],label+' incomplete'
    ending=re.search(r'Isolated MBT main run failed in (\d+)/(\d+) file\(s\): (.*)',text)
    failures=ending[3].split(', ') if ending else []
    assert ending or 'Isolated MBT main run passed' in text,label+' summary missing'
    if ending: assert len(failures)==int(ending[1])
    totals={key:sum(map(int,re.findall(r'^ℹ '+key+r' (\d+)$',text,re.M))) for key in ['tests','pass','fail','cancelled','skipped']}
    failed_tests=[]
    for section in re.split(r'^\[isolation\] MBT main \d+/\d+ ',text,flags=re.M)[1:]:
        file=section.splitlines()[0]
        failed_tests.extend(file+' :: '+name for name in re.findall(r'^✖ (.+) \([\d.]+ms\)$',section,re.M))
    return {'files':len(files),'fileNames':[row[2] for row in files],'failedFiles':failures,
            'failedTests':sorted(set(failed_tests)),'totals':totals,
            'timeouts':json.loads((OUT/(label+'-timeouts.json')).read_text())}

def compare():
    before,after=suite('baseline'),suite('final')
    for label in ['baseline','final']:
        setup=(OUT/(label+'-fixture-setup.log')).read_text()
        expected=sorted(file.name for file in (OUT/('comparison-'+label)/'migrations').glob('*.sql'))
        verified=OUT/(label+'-fixture-verified.json')
        if verified.exists():
            data=json.loads(verified.read_text());assert data['fullyMigrated'] and data['migrations']==len(expected)
        else:
            assert sorted(re.findall(r'^Applied (.+)$',setup,re.M))==expected and 'error:' not in setup, 'Require fully initialized fixture logs'
    assert before['fileNames']==after['fileNames'],'Full suites must use the same test files'
    result={'baseline':before,'final':after,
            'newFailures':sorted(set(after['failedFiles'])-set(before['failedFiles']))+
                          sorted(set(after['failedTests'])-set(before['failedTests'])),
            'resolvedFailures':sorted(set(before['failedFiles'])-set(after['failedFiles']))}
    (OUT/'comparison.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'files':after['files'],'baselineFailedFiles':len(before['failedFiles']),
                      'finalFailedFiles':len(after['failedFiles']),'newFailures':result['newFailures'],
                      'baselineTotals':before['totals'],'finalTotals':after['totals']}))
    assert not result['newFailures'],'New regressions require investigation'

def types():
    def errors(label):
        return [re.sub(r'\(\d+,\d+\)','(line,column)',row) for row in (OUT/('types-'+label+'.log')).read_text().splitlines() if 'error TS' in row]
    old,new=errors('baseline'),errors('final')
    added=list((collections.Counter(new)-collections.Counter(old)).elements())
    save('types-comparison',{'baseline':len(old),'final':len(new),'newDiagnostics':added})
    assert not added

def supply():
    for file in ['package.json','package-lock.json']:
        assert (RELEASE/'candidate'/file).read_bytes()==(RELEASE/'before'/file).read_bytes()
    candidates=[]
    for file in FILES:
        old=RELEASE/'before'/file
        for line in difflib.unified_diff(old.read_text().splitlines() if old.exists() else [],(RELEASE/'candidate'/file).read_text().splitlines()):
            if line.startswith('+') and not line.startswith('+++') and re.search(r'AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|eyJ[\w-]{10,}\.[\w-]{10,}\.',line): candidates.append(file)
    save('supply',{'newDependencies':0,'packageFilesUnchanged':True,'secretCandidates':candidates,
                  'capabilityChange':'Retain actor/yard drafts in IndexedDB; existing authorized stock writes atomically include a transfer memo receipt. Supersession uses the existing audit table.',
                  'dependencyAudit':'Not repeated because the dependency set is unchanged.'})
    assert not candidates

def source():
    hashes=json.loads((RELEASE/'source-tree.json').read_text())
    save('source-state',{'sourceTreeSha256':hashlib.sha256(json.dumps(hashes,sort_keys=True,separators=(',',':')).encode()).hexdigest(),
                         'files':len(hashes),'manifest':'deployments/damage-posting-retry-20261001/source-tree.json'})

def report():
    checks=json.loads((OUT/'candidate/checks.json').read_text())
    comparison=json.loads((OUT/'comparison.json').read_text())
    types_result=json.loads((OUT/'types-comparison.json').read_text())
    coverage=json.loads((OUT/'candidate/changed-coverage.json').read_text())
    state=json.loads((OUT/'source-state.json').read_text())
    live=json.loads((OUT/'live-verified.json').read_text())
    deployed=json.loads((RELEASE/'result.json').read_text())
    mutants=json.loads((OUT/'candidate/mutations.json').read_text())
    assert checks['sourceHashes']==json.loads((RELEASE/'manifest.json').read_text())['sourceHashes']
    assert not coverage['missed'] and not comparison['newFailures'] and all(row['killed'] for row in mutants)
    executable=sum(row['executable'] for row in coverage['results'])
    covered=sum(row['covered'] for row in coverage['results'])
    total=comparison['final']['totals']
    text=f'''# Damage stock posting and retained retry evidence — Tier 3

Spec approval: not obtained (autonomous run). Scope and historical reconciliation
were explicitly authorized by the user. The acceptance specification is
`test/damage-posting-retry-spec.md`.

Source tree: `{state['sourceTreeSha256']}` ({state['files']} files).
Released image: `{deployed['imageId']}`. Only fourteen runtime files changed,
with no migrations or dependencies. Unrelated concurrent changes were retained
by overlaying this patch on the live parent and checking its hashes before release.

Re-run entry point: `python3 tools/damage-posting-retry-verify.py run` (isolated
Docker services and the captured source copies required). Artifact collection
alone uses `collect` while its test runner exists. Neither command publishes
the app or writes live stock.
Focused and mutation commands are persisted in `tools/damage-posting-retry-check.mjs`.
The full suite uses frozen before/after copies containing the same current tests
and unrelated source; only the fourteen runtime files differ. Initial/interrupted
logs remain separate from the final comparison. Node {checks['node']};
{', '.join(name+' '+version for name,version in checks['versions'].items())}.

| Acceptance | Verification | Result |
| --- | --- | --- |
| P1/P2 | Realistic description-stripping create/append contracts, atomic REST payload and committed audit-before-write checks | pass |
| P3/P4 | Lost response, restart, parallel retry, adversarial receipt/snapshot/quantity/UOM/reason/location cases | pass |
| P5 | Isolated recovery rehearsal and live recovery receipt; retain duplicate evidence, link existing Pisa without another movement | pass |
| D1–D4 | Real Chromium reload, five large photos, failed IT retry, unknown submit, partial upload reuse, cache errors and actor/yard changes | pass |
| D5 | Actual local-status HTTP route without NetSuite reads; service worker and every offline asset fetched from the app | pass |
| C1–C3 | Read-only description handling, stock fields and additional-line receipt properties | pass |
| Existing behavior | Photo ZIP, Control editing, operator counting and priority queue contracts | pass |

| Layer | Actual final result |
| --- | --- |
| Exact candidate focused tests | {checks['focused']['pass']}/{checks['focused']['tests']} passed, {checks['focused']['fail']} failed, {checks['focused']['skipped']} skipped |
| Reverse test order | {checks['reordered']['pass']}/{checks['reordered']['tests']} passed |
| Full regression | {comparison['final']['files']} identical files per run; {len(comparison['baseline']['failedFiles'])} baseline / {len(comparison['final']['failedFiles'])} final failed files; zero new file/test failures |
| Completed full-test summaries | {total['pass']} passed, {total['fail']} failed, {total['skipped']} skipped, {total['cancelled']} cancelled |
| Type comparison | {types_result['baseline']} baseline / {types_result['final']} final existing diagnostics; zero new |
| Lint and syntax | Zero new lint findings; twelve runtime JavaScript files parse |
| Changed executable lines | {covered}/{executable} covered; zero misses, V8/Istanbul mapping |
| Manual mutations | {len(mutants)}/{len(mutants)} plausible mutants killed; receipt, snapshot and stock-quantity mutants killed by properties alone |
| Properties | 250 snapshot/JSONB-order cases, 250 memo-replacement cases, 150 Control corruption cases, plus existing photo, naming and Control properties |
| Supply chain | No new dependencies, unchanged package files, zero secret candidates |
| Live execution | September Pisa remains 10 PC with original 9 PC and photo; October Pisa linked once; October UCARA 27.09 SQFT on exactly one line; September UCARA superseded with photo |
| Live downloads | Original image bytes and line/SKU ZIP names verified in September and October |
| Deployment | Public/local health 200, anonymous damage API 401, source/asset hashes, unchanged configuration and other services |

Live October review: {live['october']['totalMs']} ms; September:
{live['september']['totalMs']} ms. Individual external-service observations are
not a latency guarantee. Local entry recovery avoids history queries entirely.

Known limits:

- The whole repository suite and type check contain existing failures; neither
  is globally green. Complete failures and diagnostics are in `comparison.json`
  and the baseline/final logs. The same 60-second test-file watchdog applies to
  both runs and records each intervention; timed-out files have no final summary.
- An earlier broad comparison used incompletely initialized test databases and
  was discarded. Its logs are retained with `uninitialized` in their names.
  The final helper completes migrations before cloning and verifies every
  migration filename, preventing the setup race found during this run.
- Changed executable lines run, but branch coverage is not complete. Browser
  behavior, HTML and cache URLs are verified through Chromium and HTTP checks.
- One candidate run hit a screenshot-capture timeout in the existing count
  browser test after its functional assertions. The unchanged test passed in
  isolation, and the full candidate and reverse-order runs passed on rerun.
  The failure is retained in `candidate-screenshot-timeout`; no assertion or
  timeout was loosened. The upload-context race was reproduced separately,
  fixed and checked by a dedicated mutation before freezing the final source.
- NetSuite description is read-only in this account. Confirmation requires the
  durable memo receipt, unchanged prior stock lines and exactly one matching
  addition. Unknown outcomes remain blocked for recheck instead of resending.
- Device storage can be unavailable or cleared. This is surfaced to the operator;
  the in-memory draft is retained and accepted reports remain on the server.
- Historical September linking preserves the user-approved manual change from
  9 PC/R2 to 10 PC/R3. The original report and photo remain unchanged.
- Dependency vulnerability/license auditing was not repeated because dependency
  files are unchanged. Private live backups are kept out of this report.
- No git commit was made in the shared dirty workspace.
'''
    (SERVER/'test/damage-posting-retry-evidence.md').write_text(text)
    print(json.dumps({'evidence':'test/damage-posting-retry-evidence.md','deployed':True}))

if __name__=='__main__':
    {'changed':changed,'compare':compare,'types':types,'supply':supply,'source':source,'report':report}[sys.argv[1]]()
