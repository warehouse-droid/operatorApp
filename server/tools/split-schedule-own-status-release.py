#!/usr/bin/env python3
"""Release: PO/TO Schedule shows a PO split's own status, not its parent's, when the split is newer
than the parent's reconciliation snapshot.

SN1404201 (split of POB04164, created 2026-11-04, directly linked on 2026-11-05 to the planned group
GOA-11004S3-11041S3-11280) showed Direct ship on PO Split but Hold on PO/TO Schedule. POB04164 was last
reconciled on 2026-10-31, so its snapshot had no target for SN1404201. enrichScmScheduleWithReconciliation
then fell back to the parent's source_residual target (Hold) via sourceRef and, because the row is a
split, preferred that over the split's own Direct ship.

Change:
  src/scm-reconciliation-repository.js  enrichScmScheduleWithReconciliation: a PO split matches only its
    own reconciliation target (as the schedule SQL and PO Split already do). Without one it keeps its own
    calculated status and reads "unreconciled" until the next reconciliation adds its target.
No migration; an app rollback restores the previous behaviour.

Steps: patch -> prepare -> validate -> build -> deploy (verifies; rolls the app back on failure) -> verify.
The candidate is the live copy plus only the edit below (strict context, no fuzz).
"""
import json,os,runpy,signal,subprocess,sys
from pathlib import Path

previous=runpy.run_path(str(Path(__file__).with_name('special-scm-line-details-release.py')))
prev=previous['prev']
split,sor,base=prev['split'],prev['sor'],prev['base']
SERVER,REPO,APP=base['SERVER'],base['SERVER'].parent,base['APP']
OUT=SERVER/'deployments/split-schedule-own-status-20261105'
PATCH=OUT/'change.patch'
# Kept beside the tool: server/deployments is subject to copy retention, tools/ is not.
CODE_PATCH=Path(__file__).with_name('split-schedule-own-status-release.code.patch')
FILES=['src/scm-reconciliation-repository.js']
IMAGE='mbbs-operator-app:split-schedule-own-status-20261105'
ROLLBACK='mbbs-operator-app:split-schedule-own-status-rollback-20261105'
TARGET_FILES=['test/scm-split-schedule-status/split-own-status.test.js']
EXPECTED_TARGET=3
# Live must fail exactly this (the new behaviour) and nothing else in the target file
# (the runner also reports a file-level 'FILE EXIT' failure for the file containing it).
NEW_TESTS={
  "test/scm-split-schedule-status/split-own-status.test.js :: a direct-linked split newer than its held parent's snapshot shows Direct ship on PO/TO Schedule"}
REGRESSION=[f'test/{name}.test.js' for name in '''
dispatch/integration/direct-linked-po-group-lifecycle dispatch/integration/direct-linked-po-lifecycle
dispatch/integration/direct-linked-po-replay dispatch/integration/dispatch-review-pool-repair
dispatch/integration/scm-direct-ship-schedule dispatch/integration/scm-manual-split-authority.red
dispatch/integration/scm-po-split-editing dispatch/integration/scm-po-split-status-consistency.red
dispatch/integration/scm-search-vendor-completion dispatch/integration/scm-vendor-completion-http
dispatch/integration/scm-schedule-split-parity dispatch/integration/dispatch-po-split-link-target
dispatch/integration/scm-pob03658-split-driver-lifecycle.red dispatch/integration/scm-po-stale-line-pallet-conservation.red
dispatch/frontend/scm-po-split-ui
mbt/integration/scm-cancelled-split-schedule mbt/integration/scm-schedule-search mbt/integration/scm-schedule-status-http
mbt/integration/scm-po-split-ref-reuse mbt/integration/scm-reconcile-review-automation.red
mbt/integration/scm-split-receipt-allocation.red mbt/unit/scm-split-po-status-evidence-precedence.red
'''.split()]
# (file, live text, released text): each live text must occur exactly once in the live copy.
EDITS=[
  ('src/scm-reconciliation-repository.js','''    match ||= byTarget.get(`${kind}:${text(row.orderRef).toLowerCase()}`)
      || byTarget.get(`${kind}:${text(row.sourceRef).toLowerCase()}`);
    if (!match && kind === "PO") {''','''    // A PO split takes reconciliation status only from its own target, as the
    // PO/TO Schedule query and PO Split do. A family snapshot taken before the
    // split existed has no target for it, and the parent's residual target is a
    // different order: borrowing it showed the parent's Hold over the split's
    // own Direct ship. Such a split stays unreconciled until the next run.
    const exactTargetOnly = kind === "PO" && row.isScmSplit === true;
    match ||= byTarget.get(`${kind}:${text(row.orderRef).toLowerCase()}`)
      || (exactTargetOnly ? null : byTarget.get(`${kind}:${text(row.sourceRef).toLowerCase()}`));
    if (!match && kind === "PO") {'''),
]
MARKERS={'src/scm-reconciliation-repository.js':'exactTargetOnly'}
UNRELATED=('aiChat','ai-chat','AiChat','client-error-reporter','autoRetry','adminRepost')
MAX_CHANGED_LINES=12
for scope in (split,sor):scope.update(OUT=OUT)
split.update(PATCH=PATCH,FILES=FILES,IMAGE=IMAGE,ROLLBACK=ROLLBACK)
base.update(OUT=OUT,FILES=FILES,IMAGE=IMAGE,ROLLBACK=ROLLBACK)
prev.update(OUT=OUT,FILES=FILES,TARGET_FILES=TARGET_FILES,REGRESSION=REGRESSION)
save,sha=base['save'],base['sha']
base['apply_migration']=lambda:{'migration':None}

def make_patch():
    """Capture live, apply exactly EDITS to a copy of each live file and store the resulting patch."""
    sor['capture']()
    live,staged=OUT/'live-before',OUT/'patch-stage'
    subprocess.run(['rm','-rf','--',str(staged)],check=True)
    texts={name:(live/name).read_text(encoding='utf-8') for name in FILES}
    for name,old,new in EDITS:
        assert texts[name].count(old)==1,(name,'live text not found exactly once',old[:120])
        texts[name]=texts[name].replace(old,new)
    parts=[]
    for name in FILES:
        target=staged/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_text(texts[name],encoding='utf-8')
        result=subprocess.run(['diff','-u','--label',f'a/server/{name}','--label',f'b/server/{name}',str(live/name),str(target)],
          capture_output=True,text=True)
        assert result.returncode==1,(name,result.stderr)
        parts.append(f'diff --git a/server/{name} b/server/{name}\n'+result.stdout)
    subprocess.run(['rm','-rf','--',str(staged)],check=True)
    CODE_PATCH.write_text(''.join(parts));PATCH.write_bytes(CODE_PATCH.read_bytes())
    check=subprocess.run(['patch','-p2','--fuzz=0','--dry-run','--batch','-d',str(live)],stdin=PATCH.open('rb'),capture_output=True,text=True)
    assert check.returncode==0,('Patch does not apply to live',check.stdout[-3000:])
    print(json.dumps({'patch':str(PATCH),'files':len(FILES),'edits':len(EDITS)}))

def prepare():
    state=sor['capture']()
    live,candidate=OUT/'live-before',OUT/'candidate'
    subprocess.run(['rm','-rf','--',str(candidate)],check=True)
    subprocess.run(['cp','-a',str(live),str(candidate)],check=True)
    with PATCH.open('rb') as patch:
        subprocess.run(['patch','-p2','--fuzz=0','--no-backup-if-mismatch','--batch','-d',str(candidate)],stdin=patch,check=True)
    differs=prev['changed_files'](live,candidate)
    assert differs==sorted(FILES),('Candidate must differ from live in exactly the release files',differs)
    diff,changed=[],0
    for name in FILES:
        one=subprocess.run(['git','diff','--no-index','--',str(live/name),str(candidate/name)],capture_output=True,text=True).stdout
        lines=[line for line in one.splitlines() if line[:1] in '+-' and line[:3] not in ('+++','---')]
        added=[line for line in lines if line.startswith('+')]
        assert any(MARKERS[name] in line for line in added),name
        assert not any(word in line for line in added for word in UNRELATED),f'{name}: unrelated work in candidate'
        changed+=len(lines);diff.append(one)
    assert changed<=MAX_CHANGED_LINES,('Release diff is larger than this change',changed)
    (OUT/'release.patch').write_text(''.join(diff))
    for path in [candidate,*candidate.rglob('*')]:path.chmod(0o755 if path.is_dir() else 0o644)
    save(OUT/'prepared.json',{'baseImage':state['app']['imageRef'],'patchSha256':sha(PATCH),'conflicts':[],
      'moduleBasis':{name:'live plus change.patch' for name in FILES},
      'sourceHashes':{name:sha(candidate/name) for name in FILES}})
    print(json.dumps({'baseImage':state['app']['imageRef'],'files':len(FILES),'changedLines':changed}))

def lint(art):
    """Syntax-check the changed module and ESLint the new test against the candidate sources."""
    tree=OUT/'candidate'
    mounts=[]
    for name in ('src','public','migrations'):mounts+=['-v',f'{tree}/{name}:/app/{name}:ro']
    checks=' && '.join([*(f'node --check {name}' for name in [*FILES,*TARGET_FILES]),
      'node_modules/.bin/eslint --config eslint.mbt.config.js --max-warnings=0 '+' '.join(TARGET_FILES)])
    result=subprocess.run(['docker','run','--rm','--network','none','--label','com.mbbs.lifecycle=disposable-test',
      '--cgroup-parent=mbbs-tests.slice','--init','--cpus','1','--memory','1g','--memory-swap','1g','--pids-limit','256','--read-only',
      '--tmpfs','/tmp:size=128m',*mounts,'-v',f'{SERVER}/test:/app/test:ro','-w','/app',prev['TEST_IMAGE'],'sh','-c',checks],
      capture_output=True,text=True,timeout=600)
    (art/'lint.log').write_text(result.stdout+result.stderr)
    assert result.returncode==0,('Lint failed',(result.stdout+result.stderr)[-4000:])

def validate():
    if not os.environ.get('MBBS_TEST_ARTIFACT_DIR'):
        raise SystemExit(subprocess.run([sys.executable,str(REPO/'docker/retention/retention.py'),'run','--',sys.executable,__file__,'validate']).returncode)
    signal.signal(signal.SIGTERM,lambda *_:sys.exit(143))
    prepared=base['ensure_sources']();art=Path(os.environ['MBBS_TEST_ARTIFACT_DIR']);os.chmod(art,0o777)
    subprocess.run(['python3','docker/verify-memory-limits.py'],cwd=REPO,check=True,capture_output=True)
    tests={name:sha(SERVER/name) for name in [*TARGET_FILES,*REGRESSION]}
    lint(art)
    results=prev['suite'](art)
    live,cand=results['live'],results['candidate']
    pick=lambda tree,files,kind:sorted(f'{f} :: {n}' for f in files for n in tree.get(f,{}).get(kind,()))
    checks={
      'liveTarget':{'passed':len(pick(live,TARGET_FILES,'passed')),'failed':pick(live,TARGET_FILES,'failed')},
      'candidateTarget':{'passed':len(pick(cand,TARGET_FILES,'passed')),'failed':pick(cand,TARGET_FILES,'failed')},
      'live':{'passed':len(pick(live,REGRESSION,'passed')),'failed':len(pick(live,REGRESSION,'failed'))},
      'candidate':{'passed':len(pick(cand,REGRESSION,'passed')),'failed':len(pick(cand,REGRESSION,'failed'))},
      'missingFiles':sorted(f for f in [*TARGET_FILES,*REGRESSION] if f not in cand or f not in live),
      'newFailures':sorted(set(pick(cand,REGRESSION,'failed'))-set(pick(live,REGRESSION,'failed'))),
      'liveOnlyFailures':sorted(set(pick(live,REGRESSION,'failed'))-set(pick(cand,REGRESSION,'failed'))),
      'preexistingFailures':sorted(set(pick(cand,REGRESSION,'failed'))&set(pick(live,REGRESSION,'failed'))),
      'testHashes':tests}
    save(OUT/'validation-checks.json',checks)
    ok=(checks['candidateTarget']['passed']==EXPECTED_TARGET and not checks['candidateTarget']['failed']
        and {f for f in checks['liveTarget']['failed'] if not f.endswith(' :: FILE EXIT')}==NEW_TESTS and not checks['missingFiles'] and not checks['newFailures']
        and checks['candidate']['passed']>=checks['live']['passed']>0)
    assert ok,('Validation failed',json.dumps({k:v for k,v in checks.items() if k!='testHashes'},indent=1)[-8000:])
    assert {name:sha(SERVER/name) for name in tests}==tests,'Tests changed during validation'
    assert base['ensure_sources']()==prepared,'Candidate changed during validation'
    save(OUT/'validation.json',{'passed':True,'sourceHashes':prepared['sourceHashes'],
      'baseImageId':json.loads((OUT/'capture.json').read_text())['app']['imageId'],'checks':checks,'cleanupVerified':True})
    print(json.dumps({'validation':'passed','liveTargetFailed':checks['liveTarget']['failed'],
      'candidateTargetPassed':checks['candidateTarget']['passed'],'live':checks['live'],'candidate':checks['candidate'],
      'liveOnlyFailures':checks['liveOnlyFailures'],'preexistingFailures':checks['preexistingFailures']}))

def build():
    # A `docker builder prune` hung since 2026-08 is ignored, as the other release tools do.
    running=subprocess.run(['pgrep','-af',r'docker(-buildx)? (buildx )?build( |$)|compose .* build( |$)'],capture_output=True,text=True).stdout.strip()
    assert not running,('Another docker build is running; overlapping builds crashed dockerd on 2026-11-03',running)
    split['build']()

def deploy():
    captured=json.loads((OUT/'capture.json').read_text())['app']['imageId']
    assert json.loads((OUT/'validation.json').read_text()).get('baseImageId')==captured==base['metadata'](APP)['imageId'],\
        'Validation was not run on the current live image; patch, prepare and validate again'
    active=base['db']("SET default_transaction_read_only=on; SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing');")
    assert active=='0','A NetSuite posting is running; retry deployment after it finishes'
    base['deploy']()
    state=json.loads((OUT/'capture.json').read_text())
    (OUT/'rollback-command.txt').write_text(' '.join(base['compose'](state,OUT/'compose.rollback.json'))+'\n# No migration.\n')

# Read-only, rolled back: PO/TO Schedule (query + reconciliation pass) and PO Split must agree on SN1404201.
LIVE_CHECK=r'''
import { beginRollbackContext, closeDb, query } from "/app/src/db.js";
import { listScmSchedule } from "/app/src/dispatch-repository.js";
import { enrichScmScheduleWithReconciliation } from "/app/src/scm-reconciliation-repository.js";
const ref = "SN1404201";
const context = await beginRollbackContext();
let output = {};
try {
  await context.run(async () => {
    await query("SET TRANSACTION READ ONLY");
    const rows = await listScmSchedule({ exactRef: ref, kind: "PO", audience: "scm" });
    const [schedule] = (await enrichScmScheduleWithReconciliation(rows, {})).filter((row) => row.orderRef === ref);
    const [split] = await listScmSchedule({ kind: "PO", view: "blanket", exactRefs: [ref], statusProjectionOnly: true, audience: "scm" });
    output = { schedule: schedule?.calculatedStatus || "", poSplit: split?.calculatedStatus || "",
      reconciliation: schedule?.reconciliationStatus || "" };
  });
} finally {
  await context.rollback();
  await closeDb();
}
console.log(JSON.stringify(output));
'''

def verify():
    prepared=base['ensure_sources']()
    for name,expected in prepared['sourceHashes'].items():
        assert base['docker']('exec',APP,'sha256sum','/app/'+name).split()[0]==expected,name
    assert base['health'](),'Application is not healthy'
    code=int(subprocess.check_output(['curl','-sS','--max-time','15','-o','/dev/null','-w','%{http_code}',
      'http://127.0.0.1:3000/api/scm/schedule'],text=True))
    assert code in (401,403),f'/api/scm/schedule unauthenticated: {code}'
    observed=json.loads(base['docker']('exec','-i','-w','/app',APP,'node','--input-type=module',data=LIVE_CHECK.encode()).splitlines()[-1])
    assert observed['schedule'] and observed['schedule']==observed['poSplit'],('PO/TO Schedule and PO Split disagree',observed)
    save(OUT/'live-verification.json',{'healthy':True,'sourceHashesVerified':True,'scheduleApiStatus':code,'SN1404201':observed})
    print(json.dumps({'liveVerification':'passed','files':len(FILES),'SN1404201':observed}))
base['verify']=verify

if __name__=='__main__':
    {'patch':make_patch,'prepare':prepare,'validate':validate,'build':build,'deploy':deploy,'verify':verify}[sys.argv[1]]()
