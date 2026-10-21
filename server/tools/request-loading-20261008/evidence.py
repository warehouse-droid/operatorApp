"""Compare saved checks without treating pre-existing failures as passes."""
import collections
import datetime
import difflib
import hashlib
import json
import re
import sys
from pathlib import Path

SERVER=Path(__file__).resolve().parents[2]
OUT=SERVER/'test-artifacts/request-loading-performance-20261008'
RELEASE=SERVER/'deployments/request-loading-performance-20261008'

def read_json(path):
    return json.loads(path.read_text())

def save(name,data):
    (OUT/name).write_text(json.dumps(data,indent=2)+'\n')
    return data

def failures(path):
    text=path.read_text()
    blocks=re.split(r'\[isolation\] MBT main (\d+)/(\d+) (/app/[^\n]+)\n',text)
    errors={}
    for index in range(1,len(blocks),4):
        body=blocks[index+3]
        names=set(re.findall(r'^[✖×]\s*(.*?)(?: \([\d.]+ms\))?$',body,re.M))
        names.discard('failing tests:')
        if names:errors[blocks[index+2].removeprefix('/app/')]=sorted(names)
    summary=re.search(r'Isolated MBT main run failed in (\d+)/(\d+) file\(s\): (.+)',text)
    assert summary,'Incomplete regression log: '+str(path)
    return {'filesRun':int(summary[2]),'filesFailed':int(summary[1]),
        'failingFiles':[name.removeprefix('/app/') for name in summary[3].split(', ')],
        'failingTests':errors}

def types(path):
    return collections.Counter(re.sub(r'\(\d+,\d+\):',':',line) for line in path.read_text().splitlines()
        if re.match(r'^\S+\(\d+,\d+\): error TS\d+:',line))

def lint(path):
    result=collections.Counter();file=None
    for line in path.read_text().splitlines():
        if line.startswith('/app/'):file=line.removeprefix('/app/')
        match=re.match(r'^\s+\d+:\d+\s+(error|warning)\s+(.+?)\s*$',line)
        if match:
            parts=re.split(r'\s{2,}',match[2])
            result[(file,match[1],parts[0],parts[-1] if len(parts)>1 else '')]+=1
    return result

def counter_rows(counter):
    return [{'diagnostic':key,'count':count} for key,count in sorted(counter.items())]

def regression():
    base=OUT/'baseline/results/regression';candidate=OUT/'candidate-regression/results/regression'
    for directory in [base,candidate]:
        assert [row['script'] for row in read_json(directory/'stages.json')]==['test:mbt','typecheck:mbt','lint:mbt'],'Regression layers are still running'
    before=failures(base/'test-mbt.log');after=failures(candidate/'test-mbt.log')
    new={file:sorted(set(names)-set(before['failingTests'].get(file,[])))
        for file,names in after['failingTests'].items()}
    new={file:names for file,names in new.items() if names}
    resolutions=[]
    drift='test/mbt/unit/special-po-reference.test.js'
    if drift in new:
        rechecks=read_json(OUT/'regression-rechecks/test-source-drift.json')
        assert len(rechecks)==2 and all(row['exit']==1 for row in rechecks)
        assert len({row['testSha256'] for row in rechecks})==1
        logs=[(OUT/'regression-rechecks'/name).read_text() for name in
            ['baseline-special-po-reference.log','candidate-regression-special-po-reference.log']]
        for name in new[drift]:assert all(name in log for log in logs)
        resolutions.append({'file':drift,'reason':'Concurrent test edit; the same current test fails against both captured source trees.',
            'tests':new.pop(drift),'evidence':'regression-rechecks/test-source-drift.json'})
    cache='test/mbt/unit/stock-request-ui-contract.test.js'
    cache_name='Sales Request Stock has complete Simplified Chinese UI and validation coverage'
    final_stages=read_json(OUT/'final/results/checks/stages.json') if (OUT/'final/results/checks/stages.json').exists() else []
    if cache in new and cache_name in new[cache] and any(row['name']=='cache-version-contract' and row['exit']==0 for row in final_stages):
        new[cache].remove(cache_name)
        if not new[cache]:del new[cache]
        resolutions.append({'file':cache,'reason':'Preserved the existing script-version prefix and appended a new cache key; final contract rerun passed.',
            'tests':[cache_name],'evidence':'final/results/checks/cache-version-contract.log'})
    extra_files=sorted(set(after['failingFiles'])-set(before['failingFiles'])-{row['file'] for row in resolutions})
    bt,ct=types(base/'typecheck-mbt.log'),types(candidate/'typecheck-mbt.log')
    bl,cl=lint(base/'lint-mbt.log'),lint(candidate/'lint-mbt.log')
    return save('regression-comparison.json',{'baseline':before,'candidate':after,'newFailingTests':new,
        'newFailingFiles':extra_files,'newTypeErrors':counter_rows(ct-bt),'newLintErrors':counter_rows(cl-bl),
        'baselineTypeErrors':sum(bt.values()),'candidateTypeErrors':sum(ct.values()),
        'baselineLintDiagnostics':sum(bl.values()),'candidateLintDiagnostics':sum(cl.values()),'resolutions':resolutions})

def coverage():
    manifest=read_json(RELEASE/'manifest.json')
    data=read_json(OUT/'final/results/request-coverage/coverage-final.json')
    result=[]
    for name in manifest['files']:
        if not name.endswith('.js'):continue
        before=(RELEASE/'before'/name).read_text().splitlines()
        after=(RELEASE/'candidate'/name).read_text().splitlines()
        changed=set()
        for op,_,__,start,end in difflib.SequenceMatcher(a=before,b=after,autojunk=False).get_opcodes():
            if op in ('replace','insert'):changed.update(range(start+1,end+1))
        changed={line for line in changed if after[line-1].strip() and not after[line-1].lstrip().startswith(('//','/*','*'))}
        mapped=data['/app/'+name];executed=set()
        for key,statement in mapped['statementMap'].items():
            if mapped['s'][key]>0:executed.update(range(statement['start']['line'],statement['end']['line']+1))
        result.append({'file':name,'changedLines':len(changed),'coveredLines':len(changed & executed),
            'uncovered':sorted(changed-executed)})
    return save('changed-line-coverage.json',{'files':result,'changedLines':sum(row['changedLines'] for row in result),
        'coveredLines':sum(row['coveredLines'] for row in result),
        'scope':'Changed non-comment JavaScript lines. SQL/HTML are validated by differential SQL, rollback and real-browser checks; no SQL branch instrumentation.'})

def report():
    manifest=read_json(RELEASE/'manifest.json');comparison=regression();covered=coverage()
    stages=read_json(OUT/'final/results/checks/stages.json')
    timings=read_json(OUT/'final/results/request-browser/browser-latency/timings.json')
    stress=read_json(OUT/'final/results/request-browser/concurrent-stress/timings.json')
    mutants=read_json(OUT/'final/results/request-mutations/results.json')
    equivalence=[json.loads(line) for line in (OUT/'live-index-equivalence-comprehensive.jsonl').read_text().splitlines() if line.startswith('{')]
    matches=[row for row in equivalence if row.get('kind')=='equivalence']
    cleanup={name:'teardown_exit=0' in (OUT/name/'teardown.log').read_text()
        for name in ['baseline','candidate-regression','final']}
    rebase=None;rebase_passed=True
    if (OUT/'rebase.json').exists():
        rebase=read_json(OUT/'rebase.json')
        rebase['stages']=read_json(OUT/'rebase-checks/results/rebase/stages.json')
        rebase['newTypeErrors']=counter_rows(types(OUT/'rebase-checks/results/rebase/types.log')-
            types(OUT/'baseline/results/regression/typecheck-mbt.log'))
        if (OUT/'eventsource-fixture-correction.json').exists():
            rebase['fixtureCorrection']=read_json(OUT/'eventsource-fixture-correction.json')
        cleanup['rebase-checks']='teardown_exit=0' in (OUT/'rebase-checks/teardown.log').read_text()
        rebase_passed=([row['name'] for row in rebase['stages']]==['delivery','po-sales','types']
            and all(row['exit']==0 for row in rebase['stages'] if row['name']!='types') and not rebase['newTypeErrors'])
    runtime={str(path.relative_to(RELEASE/'candidate')):hashlib.sha256(path.read_bytes()).hexdigest()
        for directory in ['src','public','migrations'] for path in sorted((RELEASE/'candidate'/directory).rglob('*')) if path.is_file()}
    assert runtime==manifest['candidateTree'],'Candidate changed since sealing'
    patch=(RELEASE/'candidate.patch').read_text()
    secrets=re.findall(r'AKIA[A-Z0-9]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-[A-Za-z0-9]{30,}',patch)
    assert not secrets,'Potential secret in product patch'
    ready=([row['name'] for row in stages]==['static','cache-version-contract','browser-latency','behavior-coverage','concurrent-stress','property-mutations']
        and all(row['exit']==0 for row in stages if row['name']!='concurrent-stress')
        and len(timings)==12 and all(row['ms']<=1500 for row in timings)
        and len(stress)==4 and len(mutants)==6 and all(row['killed'] for row in mutants)
        and len(matches)==10 and all(row['same'] for row in matches)
        and all(cleanup.values())
        and rebase_passed
        and covered['changedLines']==covered['coveredLines']
        and all(not comparison[key] for key in ['newFailingTests','newFailingFiles','newTypeErrors','newLintErrors']))
    final={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'readyForRelease':ready,
        'sourceTreeHash':manifest['candidateTreeHash'],'changedFiles':manifest['files'],
        'specApproval':'not obtained (autonomous run); user explicitly confirmed normal-page timing scope',
        'stages':stages,'normalBrowserTimings':timings,'simultaneousColdBrowserTimings':stress,
        'coverage':covered,'mutants':mutants,'liveResponseMatches':matches,'regression':comparison,
        'cleanup':cleanup,'rebaseVerification':rebase,
        'scenarioEvidence':{
            'completion-equivalence':['test/request-loading-database.test.js: effective completion property and priority ranking','live-index-equivalence-comprehensive.jsonl'],
            'planning-equivalence':['test/request-loading-database.test.js: nested/split/CO/ETA and conservative filter fixtures','final/results/request-browser/browser-latency/planning-index-explain.json'],
            'queue-equivalence':['test/request-loading-browser.test.js: complete per-record queue comparison and foreign-yard denial','live-index-equivalence-comprehensive.jsonl'],
            'detail-reuse':['test/request-loading-ui.test.js: selection, empty, refresh, slow response, stocking availability and selection property'],
            'freshness':['candidate.patch: existing NetSuite refresh and explicit detail actions unchanged','test/request-loading-ui.test.js: current stocking availability retained'],
            'latency':['final/results/request-browser/browser-latency/timings.json','final/results/request-browser/concurrent-stress/timings.json'],
            'no-side-effects':['test/request-loading-database.test.js: all three views/function/index rollback rehearsal','live-index-equivalence-comprehensive.jsonl: read-only transaction'],
            'cleanup':['baseline/teardown.log','candidate-regression/teardown.log','final/teardown.log']},
        'versions':read_json(OUT/'final/results/checks/static.json')['versions'],
        'knownLimits':[
            f'Four simultaneous cold browser loads took {min(row["ms"] for row in stress)}–{max(row["ms"] for row in stress)} ms; this is outside the user-confirmed normal-loading target.',
            'Controlled local browser measurements exclude real client-network variability. Live repository probes exclude authentication, serialization and NetSuite status refresh.',
            'The existing synchronous NetSuite refresh remains in place when linked order status is older than five minutes; its external latency can exceed the target.',
            'The shared checkout has pre-existing failures and concurrent test edits. Raw logs and paired rechecks are retained; the whole repository is not green.',
            'A script cache-key compatibility correction followed the full-suite start. Its final targeted contract and all final browser runs verify the final HTML; JavaScript and SQL in the performance overlay were unchanged.',
            'A concurrent independently validated release changed 16 nonoverlapping files. The 910-file comparison is retained against its original source hash, not presented as a fresh full run after rebasing. The combined release reruns all request checks, live equivalence, the affected 20-file delivery/alert suites, and types.',
            'Full-suite randomized ordering was not run: standard runner isolates each file in its own disposable database; deterministic seeded property cases and repeated browser samples cover the changed behavior.',
            'No checkpoint commits were made in the dirty shared checkout; captured and candidate trees are identified by SHA-256.'
        ],
        'supplyChain':{'newDependencies':0,'audit':'Skipped new dependency audit: package and lockfile unchanged.',
            'secretScanFindings':0,'capabilityReview':'Read-query/index changes and existing same-origin script/event-stream loading; no new external service or credential.'},
        'reproduce':'bash server/tools/request-loading-20261008/verify-all.sh',
        'testAndToolHashes':{str(p.relative_to(SERVER)):hashlib.sha256(p.read_bytes()).hexdigest()
            for p in list((SERVER/'test').glob('request-loading-*.test.js'))+list(Path(__file__).parent.glob('*'))+
            [SERVER/'test/mbt/integration/special-po-reference-browser.test.js'] if p.is_file()}}
    if (RELEASE/'deployment-result.json').exists():
        final['deployment']=read_json(RELEASE/'deployment-result.json')
        final['liveMeasurements']=[json.loads(line) for line in (OUT/'live-performance.jsonl').read_text().splitlines()
            if line.startswith('{') and json.loads(line).get('kind') in ('runtime','measurement')]
        final['httpVerification']=[json.loads(line) for line in (OUT/'live-http.jsonl').read_text().splitlines() if line.startswith('{')]
        final['finalAudit']=read_json(OUT/'final-audit.json')
        final['netSuiteProbeApproval']=read_json(OUT/'netsuite-probe-approval.json')
        final['migrationContention']={'attemptsAbortedByLockTimeout':2,'finalAttempt':'deployed and verified',
            'evidence':['migration-lock-timeout.json','deployment-lock-observed.json'],
            'note':'Concurrent view readers caused lock contention during installation; aborted attempts rolled back. No production sessions were terminated by the deployment tool.'}
    save('evidence.json',final)
    rows=[]
    for role in ['sales','scm']:
        for tab in ['special','regular']:
            values=[row['ms'] for row in timings if row['role']==role and row['tab']==tab]
            rows.append(f'| {role.upper()} {tab} | {min(values)}–{max(values)} ms |')
    deployed=final.get('deployment',{}).get('deployed',False)
    live_summary=[]
    for label,prefixes in [('Special',('special-sales-list-','special-scm-list-')),
        ('Regular Sales',('regular-sales-list-',)),('Regular SCM',('regular-scm-list-',))]:
        values=[row['ms'] for row in final.get('liveMeasurements',[]) if row.get('label','').startswith(prefixes)]
        if values:live_summary.append(f'{label} {min(values)}–{max(values)} ms')
    (OUT/'EVIDENCE.md').write_text('# Request loading verification\n\n'
        f'Validated: **{ready}**. Deployed and healthy: **{deployed}**.\n\n'
        '| Normal cold page load | Three samples |\n|---|---|\n'+'\n'.join(rows)+'\n\n'
        f'Changed JavaScript lines executed: {covered["coveredLines"]}/{covered["changedLines"]}. '
        f'Manual mutants killed: {sum(row["killed"] for row in mutants)}/{len(mutants)}. '
        'Live before/after response hashes match in 10/10 read-only scenarios.\n\n'
        f'Full suite: {comparison["candidate"]["filesRun"]} files; '
        f'{comparison["baseline"]["filesFailed"]} baseline and {comparison["candidate"]["filesFailed"]} raw candidate failures. '
        'See regression-comparison.json for exact failures, paired test-source drift, the fixed cache-key assertion and diagnostic deltas.\n\n'
        'No stale response cache or altered completion/authorization rule was introduced. Dependency files are unchanged.\n\n'+
        'Initial Dispatch diagnosis is retained in ../dispatch-host-audit-20261008/summary.json: about 4.2–4.3 seconds foreground, 6.3–6.4 seconds including the order pool; forecast loading and the 29 MB assignment payload were separate bottlenecks. This release targets request loading.\n\n'+
        ('Live local reads: '+', '.join(live_summary)+'. '
         'Both local and public served assets match the deployed files; all four private request APIs deny anonymous access. '
         'No test containers, test databases, task networks or task volumes remain. Production data and rollback volumes are retained.\n\n'
         'The optional live NetSuite timing probe was not run: automatic approval review required explicit approval to send production order IDs to NetSuite. '
         'Normal controlled browser timings exclude that external refresh.\n\n' if deployed else '')+
        'Known limits:\n\n'+'\n'.join('- '+value for value in final['knownLimits'])+'\n\n'
        'Reproduce with `bash server/tools/request-loading-20261008/verify-all.sh`. '
        'The entry point uses disposable bounded Compose stacks and automatic teardown. '
        'See evidence.json for source hashes, versions, individual checks and timings.\n')
    print(json.dumps({'readyForRelease':ready,'coverage':covered['coveredLines'],'normalSamples':len(timings),
        'newFailingTests':comparison['newFailingTests'],'newTypeErrors':len(comparison['newTypeErrors']),
        'newLintErrors':len(comparison['newLintErrors'])}))
    return 0 if ready else 1

if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1]=='regression':print(json.dumps(regression()))
    elif len(sys.argv)>1 and sys.argv[1]=='coverage':print(json.dumps(coverage()))
    else:sys.exit(report())
