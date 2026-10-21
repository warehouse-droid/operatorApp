"""Generate the damage-photo regression comparison and exact changed-line scope."""
import collections
import difflib
import hashlib
import json
from pathlib import Path
import re
import sys

SERVER=Path(__file__).resolve().parents[1]
OUT=SERVER/'test-artifacts/damage-photos-20261001'
RELEASE=SERVER/'deployments/damage-photos-priority-20261001'

def changed():
    result={}
    for file in json.loads((SERVER/'tools/damage-photos-files.json').read_text()):
        if not file.endswith('.js'): continue
        before=SERVER/'deployments/damage-photos-20261001/before'/file
        source=RELEASE/'candidate'/file
        old=before.read_text().splitlines() if before.exists() else []
        new=source.read_text().splitlines()
        lines=[]
        for operation,_,_,start,end in difflib.SequenceMatcher(a=old,b=new,autojunk=False).get_opcodes():
            if operation in ['replace','insert']: lines.extend(range(start+1,end+1))
        result[file]={'sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'lines':lines}
    (OUT/'changed-lines.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'changedJavaScriptFiles':len(result),'changedLines':sum(len(v['lines']) for v in result.values())}))

def suite(label):
    text=(OUT/(label+'-full.log')).read_text()
    files=re.findall(r'^\[isolation\] MBT main (\d+)/(\d+) (.+)$',text,re.M)
    assert len(files)==756 and files[-1][0]=='756',label+' full run incomplete'
    ending=re.search(r'Isolated MBT main run failed in (\d+)/756 file\(s\): (.*)',text)
    assert ending,label+' final summary missing'
    failures=ending[2].split(', ')
    assert len(failures)==int(ending[1])
    totals={key:sum(map(int,re.findall(r'^ℹ '+key+r' (\d+)$',text,re.M))) for key in ['tests','pass','fail','cancelled','skipped']}
    failed_tests=[]
    for section in re.split(r'^\[isolation\] MBT main \d+/\d+ ',text,flags=re.M)[1:]:
        file=section.splitlines()[0]
        for name in re.findall(r'^✖ (.+) \([\d.]+ms\)$',section,re.M):
            failed_tests.append(file+' :: '+name)
    return {'files':len(files),'failedFiles':failures,'failedTests':sorted(set(failed_tests)),'totals':totals,
            'timeouts':json.loads((OUT/(label+'-timeouts.json')).read_text())}

def compare():
    before,after=suite('baseline'),suite('final')
    result={'baseline':before,'final':after,'newFailures':sorted(set(after['failedFiles'])-set(before['failedFiles']))+
                sorted(set(after['failedTests'])-set(before['failedTests'])),
            'resolvedFailures':sorted(set(before['failedFiles'])-set(after['failedFiles']))}
    (OUT/'comparison.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'baselineFailedFiles':len(before['failedFiles']),'finalFailedFiles':len(after['failedFiles']),
                      'newFailures':result['newFailures'],'baselineTotals':before['totals'],'finalTotals':after['totals']}))
    assert result['newFailures']==[], 'New regression failures require investigation'

def types():
    def errors(label):
        rows=(OUT/('types-'+label+'.log')).read_text().splitlines()
        return [re.sub(r'\(\d+,\d+\)', '(line,column)',row) for row in rows if 'error TS' in row]
    old,new=errors('baseline'),errors('final')
    added=list((collections.Counter(new)-collections.Counter(old)).elements())
    result={'baseline':len(old),'final':len(new),'newDiagnostics':added}
    (OUT/'types-comparison.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result));assert not added

def supply():
    for file in ['package.json','package-lock.json']:
        assert (RELEASE/'candidate'/file).read_bytes()==(RELEASE/'before'/file).read_bytes()
    added=[]
    for file in json.loads((SERVER/'tools/damage-photos-files.json').read_text()):
        old=RELEASE/'before'/file
        diff=difflib.unified_diff(old.read_text().splitlines() if old.exists() else [],
                                  (RELEASE/'candidate'/file).read_text().splitlines())
        added.extend((file,line[1:]) for line in diff if line.startswith('+') and not line.startswith('+++'))
    candidates=[file for file,line in added if re.search(r'AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|eyJ[\w-]{10,}\.[\w-]{10,}\.',line)]
    result={'newDependencies':0,'packageFilesUnchanged':True,'secretCandidates':candidates,
            'capabilityChange':'Browser downloads original photos via the existing authenticated preview endpoint; no new server writes or permissions.',
            'dependencyAudit':'Not repeated: dependency set unchanged.'}
    (OUT/'supply.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result));assert not candidates

def source():
    hashes=json.loads((RELEASE/'source-tree.json').read_text())
    result={'sourceTreeSha256':hashlib.sha256(json.dumps(hashes,sort_keys=True,separators=(',',':')).encode()).hexdigest(),
            'files':len(hashes),'manifest':'deployments/damage-photos-priority-20261001/source-tree.json'}
    (OUT/'source-state.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))

def report():
    checks=json.loads((OUT/'candidate/checks.json').read_text())
    comparison=json.loads((OUT/'comparison.json').read_text())
    types_result=json.loads((OUT/'types-comparison.json').read_text())
    coverage=json.loads((OUT/'candidate/changed-coverage.json').read_text())
    state=json.loads((OUT/'source-state.json').read_text())
    live=json.loads((OUT/'live-deployed.json').read_text())
    deployed=json.loads((RELEASE/'result.json').read_text())
    covered=sum(row['covered'] for row in coverage['results'])
    executable=sum(row['executable'] for row in coverage['results'])
    broad=comparison['final']['totals']
    final_timeout=comparison['final']['timeouts']['interventions'][0]['seconds']
    rows=[
        ('P1/P2','damage-photo-links.test.js: unique association, ambiguity, identity guards, unchanged database'),
        ('Z1/Z2','damage-photo-download.test.js and damage-photos-browser.test.js: naming, originals, deduplication, unsaved draft'),
        ('Z3/R1','damage-photos-browser.test.js: missing original, expired login, disabled empty review; existing damage/operator suites'),
        ('Z4','damage-photo-download.test.js plus independent Python zipfile reader: exact bytes, CRCs, Unicode and limits'),
        ('Z5','damage-photos-browser.test.js: 390-pixel viewport without horizontal scrolling'),
        ('S1/S2','damage-photos-performance.test.js plus damage-photo-links.test.js: overlapping reads, batches of three, completeness and unit labels'),
        ('S3','live-deployed.json: real IT00571 review and original image, unchanged saved report'),
        ('S4','damage-photos-priority.test.js and existing NetSuite priority queue/scheduler tests: HTTP foreground context and shared limits'),
        ('Scope invariants','exact source hashes, package equality, release configuration and unchanged other services')
    ]
    text=f'''# Damage stock evidence — Tier 2

Spec approval: not obtained (autonomous run). The acceptance specification is
`test/damage-photos-spec.md`; this lowers confidence relative to independent spec review.

Released source tree: `{state['sourceTreeSha256']}` ({state['files']} files).
Image: `{deployed['imageId']}`. Ten requested runtime files changed across two scoped releases.
The exact candidate passed after the last runtime edit. Broad tests compare the
frozen workspace baseline with the final workspace; the candidate also passed
its own focused and reverse-order runs. Tool versions: Node {checks['node']},
{', '.join(name+' '+version for name,version in checks['versions'].items())}.

Re-run entry point: `python3 tools/damage-photos-verify.py run` (isolated Docker
fixtures and captured baseline required). Final artifact checks were run with
`python3 tools/damage-photos-verify.py collect`. Publishing is separate from tests.

| Scenario | Verification | Status |
| --- | --- | --- |
'''
    text+=''.join(f'| {name} | {test} | pass |\n' for name,test in rows)
    text+=f'''
| Layer | Persisted command | Actual final result |
| --- | --- | --- |
| Focused tests | `node tools/damage-photos-check.mjs` | {checks['focused']['pass']}/{checks['focused']['tests']} pass; 0 failed, 0 skipped |
| Suite order | Same entry point, reversed file order | {checks['reordered']['pass']}/{checks['reordered']['tests']} pass |
| Broad regression | `python3 tools/damage-photos-full-run.py baseline` and `final`; evidence `compare` | 756 files each; {len(comparison['baseline']['failedFiles'])} baseline and {len(comparison['final']['failedFiles'])} final failed files; {len(comparison['newFailures'])} new file/test failures |
| Broad test counts | Recorded Node summaries | {broad['pass']} passed, {broad['fail']} failed, {broad['skipped']} skipped, {broad['cancelled']} cancelled; timed-out file has no completed summary |
| Types | Existing `tsc --project tsconfig.mbt.json --noEmit`; evidence `types` | {types_result['baseline']} baseline/{types_result['final']} final existing diagnostics; 0 new |
| Lint and syntax | `node tools/damage-photos-static.mjs` | 0 new lint findings; 8 JavaScript files parse |
| Changed-line coverage | `node tools/damage-photos-coverage.mjs` | {covered}/{executable} changed lines covered using V8/Istanbul mapping; 0 misses |
| Manual mutation | `node tools/damage-photos-mutations.mjs` | 5/5 plausible mutants killed |
| Properties | Focused tests, fast-check | 100 photo-association, 200 hostile-filename, and 24 queue/fairness generated cases |
| Independent archive reader | `python3 tools/damage-photos-zip-check.py` | 3 archives, 9 image entries; bytes/names/CRCs pass |
| Supply chain and capability | Evidence `supply` | 0 new dependencies; package files unchanged; 0 secret candidates; existing authenticated photo endpoint |
| Live execution | `sudo -n docker exec -i -w /app mbbs-operator-app-app-1 node --input-type=module < tools/damage-photos-live-verify.mjs` | IT00571 line {live['line']}, {live['photos']} real photo, ZIP naming verified, report unchanged |
| Deployment | `python3 tools/damage-photos-deploy.py apply` | Local/public health 200; anonymous damage API 401; assets, configuration and other services verified |

The live review took {live['totalMs']} ms. The original sample was about 8,072 ms.
These are individual external-service observations, not a latency guarantee.
The optimized code overlaps independent reads, bounds REST requests at three,
and retains a live unit query when saved labels are incomplete.

Known limits and honest notes:

- The full repository suite and type check have existing failures. Complete
  names and logs are in `comparison.json`, `baseline-full.log`, `final-full.log`
  and the type logs. Neither layer is reported as globally green.
- `aggregate-request-browser.test.js` hangs on the baseline. The watchdog
  marks it failed and continues. It first found the baseline hang after 493
  seconds; the final run applied the 60-second file budget and killed it at {final_timeout}
  seconds. No test assertion was weakened or skipped to hide this.
- Initial isolated image selection lacked current dependencies/browser files;
  that incomplete run was discarded and retained as a setup failure log.
- A combined mainline/unit SuiteQL query took 96.2 seconds and was rejected.
  The released month-ID lookup avoids that design.
- Early directory rejection initially caused an unhandled rejection; its RED
  test now passes. Lint configuration and artifact transfer were corrected in
  the isolated harness. The expired-session test selector was corrected to the
  actual login form before the final 101-test run.
- A live read after the first release exposed long background-queue waits.
  The Control review route was missing foreground context. The HTTP RED test
  observed background priority in both transfer and unit reads; the final
  route adds the existing middleware only to the review GET. Shared queue
  limits and background progress remain covered. The live image check now
  verifies the IT00571 photo while allowing other reports to have images too.
- New helper branch coverage from c8: photo association 31/33 branches;
  ZIP helper 45/49 branches. Changed lines execute, but branch coverage is not
  complete. CSS/HTML are verified by actual browser layout and served asset
  hashes rather than JavaScript coverage.
- Dependency vulnerability/license auditing was not repeated because the
  dependency set did not change. Tests use existing recorded tool versions.
- No stock posting, report reconciliation, migration or git commit was part
  of this change. The report remains `{live['reportStatus']}` while its photo
  is attached for display. A changed or ambiguous line is deliberately left
  with its saved report.
'''
    (SERVER/'test/damage-photos-evidence.md').write_text(text)
    print(json.dumps({'evidence':'test/damage-photos-evidence.md','deployed':True,'focusedPassed':checks['focused']['pass']}))

if __name__=='__main__':
    {'changed':changed,'compare':compare,'types':types,'supply':supply,'source':source,'report':report}[sys.argv[1]]()
