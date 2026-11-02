#!/usr/bin/env python3
"""Release the Damage stock camera switch fix and bottom-right Take photo button over the live app.

Steps: prepare -> validate -> build -> deploy (verifies; rolls back the app on failure) -> verify.
Only the files below change. Shared shells (operator.js, i18n.js, operator.html, service-worker.js)
receive targeted edits over the captured live copies, because the workspace has unrelated work.
"""
import difflib,json,os,re,runpy,signal,subprocess,sys,urllib.request
from pathlib import Path

base=runpy.run_path(str(Path(__file__).with_name('bin-selection-release.py')))
scope=base['prepare'].__globals__
SERVER,REPO,APP=base['SERVER'],base['SERVER'].parent,base['APP']
OUT=SERVER/'deployments/damage-camera-20261102'
FILES=['public/operator-inventory.js','public/operator-inventory.css','public/operator.js','public/i18n.js',
  'public/operator.html','public/service-worker.js']
TAG='&damageCamera=20261102'
CACHE='mbbs-yard-operator-20261102-damage-camera-v1'
ASSETS=['operator-inventory.css','operator-inventory.js','i18n.js','operator.js']
TEST_IMAGE='mbbs-mbt-p1-test-e2e:latest'
scope.update(OUT=OUT,FILES=FILES,IMAGE='mbbs-operator-app:damage-camera-20261102',
  ROLLBACK='mbbs-operator-app:damage-camera-rollback-20261102')
scope['apply_migration']=lambda:{'required':False}
CONTEXT_ANCHOR=('  nativeCamera: useBasicCameraCapture, captureNativePhoto: captureNativeCameraPhoto,\n'
  '  detachCameraPreviews, active: () => currentModule === "damage" && Boolean(operator)')
CONTEXT_LINES=('  // Same camera selection as Customer Pickup, so Windows tablets can switch front/rear cameras.\n'
  '  openCamera: openCameraStream, cameraError: cameraErrorMessage,\n'
  '  cameraFacing: cameraCaptureMode, cameraFacingLabel, switchCamera: switchCameraFacing, useRearCamera: selectRearCamera,\n')
I18N_ANCHOR='    "inventory.cameraWaiting": "请等待相机准备就绪。",\n'
I18N_LINES=('    "inventory.openingCamera": "正在打开相机…",\n'
  '    "inventory.cameraUnavailable": "此浏览器无法使用相机。",\n'
  '    "inventory.cameraOpenFailed": "无法打开相机。",\n')

def services(): return {key:base['metadata'](name) for key,name in base['SERVICES'].items()}

def capture():
    OUT.mkdir(parents=True,exist_ok=True)
    state=services()
    if (OUT/'capture.json').exists():
        assert json.loads((OUT/'capture.json').read_text())==state,'Live changed since capture; move live-before aside and prepare again'
        return state
    before=OUT/'live-before';before.mkdir(exist_ok=True)
    subprocess.run(['sudo','-n','docker','cp',APP+':/app/public',str(before/'public')],check=True)
    subprocess.run(['sudo','-n','chown','-R',f'{os.getuid()}:{os.getgid()}',str(before)],check=True)
    assert state==services(),'Live changed while capturing'
    base['save'](OUT/'capture.json',state)
    return state

def prepare():
    state=capture();live=lambda name:(OUT/'live-before'/name).read_text(encoding='utf-8')
    work=lambda name:(SERVER/name).read_text(encoding='utf-8')
    head=lambda name:base['gitfile']('HEAD',name)
    out={};conflicts=[]
    # Damage module and its stylesheet: three-way merge of this change onto the live copy.
    for name in ['public/operator-inventory.js','public/operator-inventory.css']:
        merged=base['merge']((OUT/'live-before'/name).read_bytes(),head(name),(SERVER/name).read_bytes(),name,'damage-camera')
        if b'<<<<<<< ' in merged:conflicts.append(name)
        out[name]=merged.decode()
    # Operator shell: hand the shared Customer Pickup camera functions to the damage module.
    text=live('public/operator.js');assert text.count(CONTEXT_ANCHOR)==1,'operator.js damage context anchor'
    for fn in ['openCameraStream','cameraErrorMessage','cameraCaptureMode','cameraFacingLabel','switchCameraFacing','selectRearCamera']:
        assert re.search(rf'^(?:async )?function {fn}\(',text,re.M),'live operator.js lacks '+fn
    assert CONTEXT_LINES in work('public/operator.js'),'workspace context lines differ from release lines'
    out['public/operator.js']=text.replace(CONTEXT_ANCHOR,CONTEXT_ANCHOR.replace('  detachCameraPreviews,',CONTEXT_LINES+'  detachCameraPreviews,'))
    text=live('public/i18n.js');assert text.count(I18N_ANCHOR)==1 and '"inventory.openingCamera"' not in text
    out['public/i18n.js']=text.replace(I18N_ANCHOR,I18N_ANCHOR+I18N_LINES)
    text=live('public/operator.html')
    for asset in ASSETS:
        text,count=re.subn(r'((?:src|href)="/'+re.escape(asset)+r'\?[^"\s]+)"',lambda m:(m[1] if TAG in m[1] else m[1]+TAG)+'"',text)
        assert count==1,('operator.html',asset,count)
    out['public/operator.html']=text
    text=live('public/service-worker.js')
    for asset in ASSETS:
        url=re.search(r'(?:src|href)="(/'+re.escape(asset)+r'\?[^"\s]+)"',out['public/operator.html'])[1]
        text,count=re.subn(r'"/'+re.escape(asset)+r'\?[^"\s]+"',json.dumps(url),text);assert count==1,('service-worker.js',asset,count)
    text,count=re.subn(r'const CACHE_NAME = "[^"]+";',f'const CACHE_NAME = "{CACHE}";',text,count=1);assert count==1
    out['public/service-worker.js']=text
    candidate=OUT/'candidate'
    subprocess.run(['rm','-rf','--',str(candidate)],check=True)
    subprocess.run(['cp','-a',str(OUT/'live-before'),str(candidate)],check=True)
    patch=[]
    for name in FILES:
        (candidate/name).write_text(out[name],encoding='utf-8')
        patch.extend(difflib.unified_diff(live(name).splitlines(True),out[name].splitlines(True),fromfile='live/'+name,tofile='candidate/'+name))
    (OUT/'release.patch').write_text(''.join(patch),encoding='utf-8')
    for path in [candidate,*candidate.rglob('*')]:path.chmod(0o755 if path.is_dir() else 0o644)
    prepared={'baseImage':state['app']['imageRef'],'conflicts':conflicts,
      'sourceHashes':{name:base['sha'](candidate/name) for name in FILES},
      'sameAsWorkspace':{name:out[name]==work(name) for name in FILES}}
    base['save'](OUT/'prepared.json',prepared)
    print(json.dumps({'baseImage':prepared['baseImage'],'conflicts':conflicts,'sameAsWorkspace':prepared['sameAsWorkspace']}))

def node(public,args,artifacts,env=None):
    """One bounded, disposable test container; removed even on failure or interruption."""
    name=f'mbbs-damage-camera-release-{os.getpid()}-{node.count}';node.count+=1
    command=['docker','run','--rm','--name',name,'--init','--cgroup-parent=mbbs-tests.slice',
      '--memory=2g','--memory-swap=2g','--pids-limit=512','--cpus=2','--label','com.mbbs.lifecycle=disposable-test',
      '--network','none','--read-only','--tmpfs','/tmp:rw,size=512m,mode=1777','--tmpfs','/dev/shm:rw,size=256m,mode=1777',
      '-e','HOME=/tmp','-e','XDG_CONFIG_HOME=/tmp/cfg','-e','XDG_CACHE_HOME=/tmp/cache','-e','PLAYWRIGHT_BROWSERS_PATH=/ms-playwright',
      *sum((['-e',f'{k}={v}'] for k,v in (env or {}).items()),[]),
      '-v',f'{public}:/app/public:ro','-v',f'{SERVER/"test"}:/app/test:ro','-v',f'{artifacts}:/app/test-artifacts',
      '--entrypoint','node',TEST_IMAGE,*args]
    try:return subprocess.run(command,capture_output=True,text=True,timeout=900)
    finally:subprocess.run(['docker','rm','-f',name],capture_output=True)
node.count=0

def tap(result):
    rows=[(s,n) for s,n in re.findall(r'^(not ok|ok) \d+ - (.+)$',result.stdout,re.M) if ' # SKIP' not in n]
    return {'passed':sorted(n for s,n in rows if s=='ok'),'failed':sorted(n for s,n in rows if s=='not ok')}

def validate():
    if not os.environ.get('MBBS_TEST_ARTIFACT_DIR'):
        raise SystemExit(subprocess.run([sys.executable,str(REPO/'docker/retention/retention.py'),'run','--',sys.executable,__file__,'validate']).returncode)
    signal.signal(signal.SIGTERM,lambda *_:sys.exit(143))
    prepared=base['ensure_sources']();art=Path(os.environ['MBBS_TEST_ARTIFACT_DIR']);out=art/'out';out.mkdir(exist_ok=True)
    os.chmod(art,0o777);os.chmod(out,0o777)
    live,candidate=OUT/'live-before/public',OUT/'candidate/public';checks={}
    syntax=node(candidate,['-e','for(const f of ["operator-inventory.js","operator.js","i18n.js","service-worker.js"])new (require("vm").Script)(require("fs").readFileSync("/app/public/"+f,"utf8"),{filename:f});console.log("syntax ok")'],out)
    assert syntax.returncode==0 and 'syntax ok' in syntax.stdout,syntax.stderr[-2000:]
    checks['syntax']='passed'
    repro=tap(node(live,['--test','--test-name-pattern=switch camera changes camera','test/operator-damage-camera.browser.test.mjs'],out))
    assert len(repro['failed'])==2 and not repro['passed'],('Live code should reproduce the switch failure',repro)
    checks['liveReproduction']=repro
    focused=node(candidate,['--test','test/operator-damage-camera.browser.test.mjs','test/damage-retained-retry-browser.test.js',
      'test/mbt/unit/operator-native-camera.test.js','test/mbt/unit/operator-camera-rollback.test.js'],out,{'OPERATOR_DAMAGE_CAMERA_SCREENSHOTS':'/app/test-artifacts'})
    result=tap(focused);assert focused.returncode==0 and not result['failed'] and len(result['passed'])>=25,(result,focused.stdout[-3000:])
    checks['candidate']={'passed':len(result['passed'])}
    suite='test/dispatch/frontend/operator-auto-camera.browser.test.mjs'
    before,after=tap(node(live,['--test',suite],out)),tap(node(candidate,['--test',suite],out))
    assert after['failed']==before['failed'] and after['passed']==before['passed'],('Pickup camera suite changed',before,after)
    checks['pickupCameraSuite']={'passed':len(after['passed']),'preExistingFailures':after['failed']}
    shots=os.environ.get('DAMAGE_CAMERA_SCREENSHOT_COPY')
    if shots:subprocess.run(['cp',*map(str,out.glob('damage-camera-*.png')),shots],check=True)
    leftovers=subprocess.check_output(['docker','ps','-aq','--filter','label=com.mbbs.lifecycle=disposable-test'],text=True).strip()
    assert not leftovers,'Disposable test containers remain'
    assert base['ensure_sources']()==prepared
    base['save'](OUT/'validation.json',{'passed':True,'sourceHashes':prepared['sourceHashes'],'checks':checks,'cleanupVerified':True})
    print(json.dumps({'validation':'passed',**checks}))

def get(url):
    with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0','Cache-Control':'no-cache'}),timeout=20) as response:
        return response.status,response.read()

def verify():
    prepared=base['ensure_sources']()
    for name,expected in prepared['sourceHashes'].items():
        assert base['docker']('exec',APP,'sha256sum','/app/'+name).split()[0]==expected,name
    assert base['health'](),'Application is not healthy'
    html=(OUT/'candidate/public/operator.html').read_text(encoding='utf-8');checks=[]
    status,body=get('http://127.0.0.1:3000/operator');assert status==200 and TAG.encode() in body;checks.append({'path':'/operator','status':status})
    for url in [re.search(r'(?:src|href)="(/'+re.escape(a)+r'\?[^"\s]+)"',html)[1] for a in ASSETS]+['/service-worker.js']:
        status,body=get('http://127.0.0.1:3000'+url)
        assert status==200 and body==(OUT/'candidate/public'/url.split('?')[0].lstrip('/')).read_bytes(),url
        checks.append({'path':url,'status':status})
    base['save'](OUT/'live-verification.json',{'healthy':True,'sourceHashesVerified':True,'http':checks})
    print(json.dumps({'liveVerification':'passed','files':len(FILES),'httpChecks':len(checks)}))
scope['verify']=verify

def deploy():
    active=base['db']("SET default_transaction_read_only=on; SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing');")
    assert active=='0','A NetSuite posting is running; retry deployment after it finishes'
    base['deploy']()

if __name__=='__main__':
    {'prepare':prepare,'validate':validate,'build':base['build'],'deploy':deploy,'verify':verify}[sys.argv[1]]()
