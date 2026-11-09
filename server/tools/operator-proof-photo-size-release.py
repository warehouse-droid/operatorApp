#!/usr/bin/env python3
"""Release: Operator Load and Receive photos are resized to a 2048 px long edge when they are taken.

2026-11-06, SN1404273: the Operator refused to confirm the load with "Photos are too large. Retake fewer
or smaller photos." Load (Delivery / Customer Pick-Up / consolidation load) and Receive photos were kept
exactly as the camera produced them: on Android tablets the native camera JPEG (often 4-8 MB), on
Windows ImageCapture.takePhoto at the sensor maximum (JPEG 0.92). One confirmation allows 16 MB of photos
in total (public/operator-photo-outbox.js, src/operator-background-photos.js), so three or four such
photos were refused. Only Return photos were compressed (1800 px, JPEG 0.84); driver photos already use
a 2048 px long edge (public/driver-offline-photos.js).

Changes (live copy plus exactly EDITS):
  public/operator.js
    * compressReturnPhoto takes an optional JPEG quality (default 0.84, unchanged for Returns).
    * compressOperatorProofPhoto: 2048 px long edge, JPEG 0.86. A photo the browser cannot decode is
      kept as taken (the previous behaviour), so capture never fails because of resizing.
    * Applied to every Load and Receive capture: the Android native camera and the Windows camera.
  public/operator.html + public/service-worker.js: operator.js version + cache name so PWAs update.
The 16 MB / 20 photo limits are unchanged. No server or database change; an app rollback restores the
previous behaviour. Photos already taken on a device before the update are not changed.

Steps: patch -> prepare -> validate -> build -> deploy (verifies; rolls the app back on failure) -> verify.
"""
import json,os,runpy,signal,subprocess,sys
from pathlib import Path

previous=runpy.run_path(str(Path(__file__).with_name('special-scm-line-details-release.py')))
prev=previous['prev']
split,sor,base=prev['split'],prev['sor'],prev['base']
SERVER,REPO,APP=base['SERVER'],base['SERVER'].parent,base['APP']
OUT=SERVER/'deployments/operator-proof-photo-size-20261106'
PATCH=OUT/'change.patch'
# Kept beside the tool: server/deployments is subject to copy retention, tools/ is not.
CODE_PATCH=Path(__file__).with_name('operator-proof-photo-size-release.code.patch')
FILES=['public/operator.js','public/operator.html','public/service-worker.js']
IMAGE='mbbs-operator-app:operator-proof-photo-size-20261106'
ROLLBACK='mbbs-operator-app:operator-proof-photo-size-rollback-20261106'
T='test/operator-proof-photo-size/operator-proof-photo-size.test.js :: '
B='test/operator-proof-photo-size/operator-proof-photo-size.browser.test.js :: '
TARGET_FILES=[T.split(' :: ')[0],B.split(' :: ')[0]]
EXPECTED_TARGET=7
# Live must fail exactly these (the new behaviour) and nothing else in the target files.
NEW_TESTS={
  T+'SN1404273: Android native Load and Receive photos are resized to a 2048 px long edge',
  T+'Windows camera Load and Receive photos are resized to a 2048 px long edge',
  T+'a photo the browser cannot decode is kept as taken',
  T+'a photo already within 2048 px and under 1.5 MB is kept unchanged',
  B+'SN1404273: four 12 MP photos are refused as taken and accepted once resized',
  B+'a portrait photo stays portrait at 1536 x 2048',
}
REGRESSION=[f'test/{name}' for name in '''
mbt/unit/operator-native-camera.test.js mbt/unit/operator-camera-rollback.test.js
mbt/unit/operator-background-confirm.test.js mbt/unit/operator-posting-photo-client.test.js
mbt/unit/operator-yard-assets.test.js mbt/unit/operator-customer-pickup-photo-gate-ui.contract.test.js
mbt/unit/receiving-posting-status.test.js mbt/e2e/operator-photo-outbox.test.js
mbt/infrastructure/legacy-public-syntax.test.js
dispatch/frontend/operator-android-camera-release.browser.test.mjs dispatch/frontend/operator-auto-camera.browser.test.mjs
dispatch/frontend/operator-camera-rollback.browser.test.mjs dispatch/frontend/consolidation-load.browser.test.mjs
dispatch/frontend/operator-phone.browser.test.mjs
'''.split()]
OPERATOR_JS=('/operator.js?v=20261028-repair-pwa&stockExchange=20261029&returnExchangeLayout=20261029&palletBottom=20261029'
  '&repairLanguage=20261030&netsuiteErrors=20261030&damageCamera=20261102&loadHold=20261103&stepperKeypad=20261104'
  '&exchangeAnyYard=20261105&returnKeypad=20261105&returnReasonsZh=20261105&operatorPush=20261105&brokenPalletLayer=20261106')
NEW_OPERATOR_JS=OPERATOR_JS+'&proofPhotoSize=20261106'
CACHE_OLD='const CACHE_NAME = "mbbs-yard-operator-20261106-broken-pallet-layer-v1";'
CACHE_NEW='const CACHE_NAME = "mbbs-yard-operator-20261106-proof-photo-size-v1";'

# (file, live text, released text): each live text must occur exactly once in the live copy.
EDITS=[
  ('public/operator.js','const OPERATOR_CAMERA_JPEG_QUALITY = 0.92;\n','''const OPERATOR_CAMERA_JPEG_QUALITY = 0.92;
// Load and Receive photos are kept at a 2048 px long edge, as driver photos are. Full camera
// photos (4-8 MB each) passed the 16 MB limit of one confirmation at 3-4 photos (SN1404273).
const OPERATOR_PROOF_PHOTO_MAX_EDGE = 2048;
const OPERATOR_PROOF_PHOTO_JPEG_QUALITY = 0.86;
'''),
  ('public/operator.js','    const photo = kind === "return" ? await compressReturnPhoto(captured) : captured;',
   '    const photo = kind === "return" ? await compressReturnPhoto(captured) : await compressOperatorProofPhoto(captured);'),
  ('public/operator.js',
   '    fulfillmentPhotoDataUrls[fulfillmentActivePhotoSlot] = await captureCameraPhotoDataUrl(fulfillmentCameraStream, video);',
   '    fulfillmentPhotoDataUrls[fulfillmentActivePhotoSlot] = await compressOperatorProofPhoto(await captureCameraPhotoDataUrl(fulfillmentCameraStream, video));'),
  ('public/operator.js',
   '    receiptPhotoDataUrls[receiptActivePhotoSlot] = await captureCameraPhotoDataUrl(receiptCameraStream, video);',
   '    receiptPhotoDataUrls[receiptActivePhotoSlot] = await compressOperatorProofPhoto(await captureCameraPhotoDataUrl(receiptCameraStream, video));'),
  ('public/operator.js','async function compressReturnPhoto(dataUrl, maxDimension = 1800) {',
   'async function compressReturnPhoto(dataUrl, maxDimension = 1800, quality = 0.84) {'),
  ('public/operator.js','''  return canvas.toDataURL("image/jpeg", 0.84);
}
''','''  return canvas.toDataURL("image/jpeg", quality);
}

/** Load and Receive photos at a 2048 px long edge. A photo this browser cannot decode is kept as taken. */
async function compressOperatorProofPhoto(dataUrl) {
  try { return await compressReturnPhoto(dataUrl, OPERATOR_PROOF_PHOTO_MAX_EDGE, OPERATOR_PROOF_PHOTO_JPEG_QUALITY); }
  catch { return dataUrl; }
}
'''),
  ('public/operator.html',f'<script src="{OPERATOR_JS}"></script>',f'<script src="{NEW_OPERATOR_JS}"></script>'),
  ('public/service-worker.js',CACHE_OLD,CACHE_NEW),
  ('public/service-worker.js',f'  "{OPERATOR_JS}",',f'  "{NEW_OPERATOR_JS}",'),
]
# Refuse to stack this change on a live copy that already has it.
ABSENT=[('public/operator.js','compressOperatorProofPhoto')]
MARKERS={'public/operator.js':'compressOperatorProofPhoto','public/operator.html':'proofPhotoSize=20261106',
  'public/service-worker.js':'proof-photo-size-v1'}
UNRELATED=('aiChat','ai-chat','AiChat','client-error-reporter','autoRetry','adminRepost','NotFulfilled','missingCleanup',
  'packConversionGap','ADMIN_SECTION_DATA')
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
    for name,text in ABSENT:
        assert text not in texts[name],(name,'this change is already live')
    for name,old,new in EDITS:
        assert texts[name].count(old)==1,(name,'live text not found exactly once',old[:160])
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
        and {f for f in checks['liveTarget']['failed'] if not f.endswith(' :: FILE EXIT')}==NEW_TESTS and not checks['missingFiles']
        and not checks['newFailures'] and checks['candidate']['passed']>=checks['live']['passed']>0)
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
    assert 'async function compressOperatorProofPhoto(dataUrl)' in script and 'const OPERATOR_PROOF_PHOTO_MAX_EDGE = 2048;' in script,'operator.js'
    save(OUT/'live-verification.json',{'healthy':True,'sourceHashesVerified':True,'operatorPage':True,
      'serviceWorker':True,'operatorScript':True})
    print(json.dumps({'liveVerification':'passed','files':len(FILES)}))
base['verify']=verify

if __name__=='__main__':
    {'patch':make_patch,'prepare':prepare,'validate':validate,'build':build,'deploy':deploy,'verify':verify}[sys.argv[1]]()
