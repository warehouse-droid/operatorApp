#!/usr/bin/env python3
"""Release: a stock exchange may be received at any exchange yard, whatever yard took the order.

Stock exchange (Quality Issue R1-R5, monthly Inventory Transfer to "<yard> Return") was locked to the
yard that placed the Sales Order, like a stock return: an order placed at 2967 (SOA) could only be
exchanged at 2967. Operations exchange at whichever yard the customer comes to, so an exchange is now
admitted at 3445, 2967 or 150 for any order. The Inventory Transfer posts at the receiving yard
(e.g. 3445 -> 3445 Return, memo "3445 <year> <Mon> Exchange"), with the original SO on each line.
Normal stock returns keep the ordering-yard rule; PALLET returns are unchanged.

Changes:
  src/return-repository.js  submitReturnBatch: exchanges skip the ordering-yard restriction.
  src/server.js             POST /api/returns/orders/lookup: mode "exchange" skips it too.
  public/operator.js        the SO-prefix yard preflight skips exchanges; lookups send mode "exchange".
  public/operator.html, public/service-worker.js  operator.js version + cache name so PWAs update.
No migration; an app rollback restores the previous behaviour.

Steps: patch -> prepare -> validate -> build -> deploy (verifies; rolls the app back on failure) -> verify.
The candidate is the live copy plus only the edits below (strict context, no fuzz).
"""
import json,os,runpy,signal,subprocess,sys
from pathlib import Path

previous=runpy.run_path(str(Path(__file__).with_name('special-scm-line-details-release.py')))
prev=previous['prev']
split,sor,base=prev['split'],prev['sor'],prev['base']
SERVER,REPO,APP=base['SERVER'],base['SERVER'].parent,base['APP']
OUT=SERVER/'deployments/stock-exchange-any-yard-20261105'
PATCH=OUT/'change.patch'
# Kept beside the tool: server/deployments is subject to copy retention, tools/ is not.
CODE_PATCH=Path(__file__).with_name('stock-exchange-any-yard-release.code.patch')
FILES=['src/server.js','src/return-repository.js','public/operator.js','public/operator.html','public/service-worker.js']
IMAGE='mbbs-operator-app:stock-exchange-any-yard-20261105'
ROLLBACK='mbbs-operator-app:stock-exchange-any-yard-rollback-20261105'
TARGET_FILES=['test/mbt/integration/stock-exchange.test.js','test/mbt/unit/stock-exchange.test.js']
EXPECTED_TARGET=24
# Live must fail exactly these (the new behaviour) and nothing else in the target files
# (the runner also reports a file-level 'FILE EXIT' failure for each file containing them).
NEW_TESTS={
  'test/mbt/integration/stock-exchange.test.js :: an order placed at 2967 can be exchanged at 3445 while its stock return stays at 2967',
  'test/mbt/unit/stock-exchange.test.js :: a 2967 (SOA) order is looked up for exchange at 3445 while its stock return stays blocked'}
REGRESSION=[f'test/mbt/{name}.test.js' for name in '''
integration/return-batch-ra integration/return-enhancements integration/return-pallet-saved-search
integration/operator-yard-access integration/return-failed-draft integration/return-ra-workflow
integration/stock-return-draft-insert integration/return-line-fulfillment integration/stock-exchange-test-cleanup
integration/return-posting-timing unit/return-enhancements-ui unit/return-ra-client unit/return-pallet-yard-reference
unit/operator-yard-assets unit/operator-stepper-keypad unit/driver-pwa-recovery-assets
infrastructure/legacy-public-syntax e2e/pallet-one-page
'''.split()]
OPERATOR_JS='/operator.js?v=20261028-repair-pwa&stockExchange=20261029&returnExchangeLayout=20261029&palletBottom=20261029&repairLanguage=20261030&netsuiteErrors=20261030&damageCamera=20261102&loadHold=20261103&stepperKeypad=20261104'
NEW_OPERATOR_JS=OPERATOR_JS+'&exchangeAnyYard=20261105'
CACHE_OLD='const CACHE_NAME = "mbbs-yard-operator-20261105-photo-cleanup-v1";'
CACHE_NEW='const CACHE_NAME = "mbbs-yard-operator-20261105-exchange-any-yard-v1";'
# (file, live text, released text): each live text must occur exactly once in the live copy.
EDITS=[
  ('src/server.js','''      includeNetSuiteOrderLines: false,
      enforceYardRestriction: returnMode !== "pallet"
    })));''','''      includeNetSuiteOrderLines: false,
      // PALLET returns are customer-level and stock exchanges may be received
      // at any exchange yard, so only stock returns stay at the ordering yard.
      enforceYardRestriction: returnMode !== "pallet" && returnMode !== "exchange"
    })));'''),
  ('src/return-repository.js','''      enforceYardRestriction: hasStock,
      forcePalletBalance: hasPallet''','''      // Stock exchanges are not tied to the ordering yard: an order placed at
      // 2967 may be exchanged at 3445 or 150 (assertStockExchange limits the
      // receiving yard to the exchange yards).
      enforceYardRestriction: hasStock && !exchange,
      forcePalletBalance: hasPallet'''),
  ('public/operator.js','''  const requiredYard = returnOrderPrefixYard(orderRef);
  if (!requiredYard
      || Number(requiredYard.locationId) === Number(locationId)''','''  const requiredYard = returnOrderPrefixYard(orderRef);
  // Stock exchanges may be received at any exchange yard, whatever yard took the order.
  if (!requiredYard
      || currentModule === "stock-exchange"
      || Number(requiredYard.locationId) === Number(locationId)'''),
  ('public/operator.js','body: JSON.stringify({ code: clean, receivingLocationId: locationId, mode: returnMode })',
   'body: JSON.stringify({ code: clean, receivingLocationId: locationId, mode: currentModule === "stock-exchange" ? "exchange" : returnMode })'),
  ('public/operator.js','body: JSON.stringify({ code: returnLookupCode, receivingLocationId: locationId, mode })',
   'body: JSON.stringify({ code: returnLookupCode, receivingLocationId: locationId, mode: currentModule === "stock-exchange" ? "exchange" : mode })'),
  ('public/operator.html',f'<script src="{OPERATOR_JS}"></script>',f'<script src="{NEW_OPERATOR_JS}"></script>'),
  ('public/service-worker.js',CACHE_OLD,CACHE_NEW),
  ('public/service-worker.js',f'  "{OPERATOR_JS}",',f'  "{NEW_OPERATOR_JS}",'),
]
MARKERS={'src/server.js':'returnMode !== "exchange"','src/return-repository.js':'hasStock && !exchange',
  'public/operator.js':'currentModule === "stock-exchange"','public/operator.html':'exchangeAnyYard=20261105',
  'public/service-worker.js':'exchange-any-yard-v1'}
UNRELATED=('aiChat','ai-chat','AiChat','client-error-reporter','autoRetry','adminRepost')
MAX_CHANGED_LINES=24
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
    assert changed<=MAX_CHANGED_LINES*2,('Release diff is larger than this change',changed)
    (OUT/'release.patch').write_text(''.join(diff))
    for path in [candidate,*candidate.rglob('*')]:path.chmod(0o755 if path.is_dir() else 0o644)
    save(OUT/'prepared.json',{'baseImage':state['app']['imageRef'],'patchSha256':sha(PATCH),'conflicts':[],
      'moduleBasis':{name:'live plus change.patch' for name in FILES},
      'sourceHashes':{name:sha(candidate/name) for name in FILES}})
    print(json.dumps({'baseImage':state['app']['imageRef'],'files':len(FILES),'changedLines':changed}))

def lint(art):
    tree=OUT/'candidate'
    mounts=[]
    for name in ('src','public','migrations'):mounts+=['-v',f'{tree}/{name}:/app/{name}:ro']
    checks=' && '.join(f'node --check {name}' for name in [*[f for f in FILES if f.endswith('.js')],*TARGET_FILES])
    result=subprocess.run(['docker','run','--rm','--network','none','--label','com.mbbs.lifecycle=disposable-test',
      '--cgroup-parent=mbbs-tests.slice','--init','--cpus','1','--memory','1g','--memory-swap','1g','--pids-limit','256','--read-only',
      '--tmpfs','/tmp:size=128m',*mounts,'-v',f'{SERVER}/test:/app/test:ro','-w','/app',prev['TEST_IMAGE'],'sh','-c',checks],
      capture_output=True,text=True,timeout=600)
    (art/'lint.log').write_text(result.stdout+result.stderr)
    assert result.returncode==0,('Syntax check failed',(result.stdout+result.stderr)[-4000:])

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

def verify():
    prepared=base['ensure_sources']()
    for name,expected in prepared['sourceHashes'].items():
        assert base['docker']('exec',APP,'sha256sum','/app/'+name).split()[0]==expected,name
    assert base['health'](),'Application is not healthy'
    fetch=lambda path:subprocess.check_output(['curl','-fsS','--max-time','15','http://127.0.0.1:3000'+path],text=True)
    assert NEW_OPERATOR_JS in fetch('/operator'),'/operator asset version'
    worker=fetch('/service-worker.js')
    assert CACHE_NEW in worker and NEW_OPERATOR_JS in worker,'service worker'
    script=fetch(NEW_OPERATOR_JS)
    assert '|| currentModule === "stock-exchange"' in script and 'mode: currentModule === "stock-exchange" ? "exchange"' in script,'operator.js'
    save(OUT/'live-verification.json',{'healthy':True,'sourceHashesVerified':True,'operatorPage':True,'serviceWorker':True,'operatorScript':True})
    print(json.dumps({'liveVerification':'passed','files':len(FILES)}))
base['verify']=verify

if __name__=='__main__':
    {'patch':make_patch,'prepare':prepare,'validate':validate,'build':build,'deploy':deploy,'verify':verify}[sys.argv[1]]()
