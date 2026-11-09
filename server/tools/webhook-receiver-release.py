#!/usr/bin/env python3
"""Release (2026-11-09): a separate container receives NetSuite order webhooks, so app releases lose none.

Before: POST /api/webhooks/netsuite/order was served by the app, so every app restart (each release) made
NetSuite's sends fail (502 / connection closed) for a few seconds, and NetSuite does not resend them by itself.
The webhook-worker container already processes the inbox and is not restarted by app releases; only the
receive step (check the secret, save the payload to netsuite_order_webhook_inbox) lived in the app.

Change: new src/netsuite-order-webhook-receiver.js (same answers as the app's route, which stays as a
fallback; loads 16 small modules, not server.js) runs as container mbbs-operator-app-webhook-receiver-1 in
its own compose project (mbbs-webhook-receiver, so app releases never touch it), published on 127.0.0.1:3001.
Cloudflare (dashboard, 2026-11-09 20:04 UTC) routes test.mbbsoperation.com/api/webhooks/netsuite/order to
http://localhost:3001. Until this deploy a temporary forwarder container (mbbs-webhook-3001-forward,
3001 -> 3000) served that port; deploy replaces it and restores it if the receiver fails.
The app is not restarted or changed. The image is the live app image plus the receiver file.

Rollback: rollback-command.txt (remove the receiver, start the forwarder again), or move the Cloudflare rule
for /api/webhooks/netsuite/order back to http://localhost:3000.

Steps: patch -> prepare -> validate -> build -> deploy (verifies; restores the forwarder on failure) -> verify.
"""
import hashlib,json,os,runpy,signal,subprocess,sys,time
from pathlib import Path

previous=runpy.run_path(str(Path(__file__).with_name('special-scm-line-details-release.py')))
prev=previous['prev']
split,sor,base=prev['split'],prev['sor'],prev['base']
SERVER,REPO,APP=base['SERVER'],base['SERVER'].parent,base['APP']
OUT=SERVER/'deployments/webhook-receiver-20261109'
PATCH=OUT/'change.patch'
CODE_PATCH=Path(__file__).with_name('webhook-receiver-release.code.patch')
MODULE='src/netsuite-order-webhook-receiver.js'
FILES=[MODULE]
NEW_FILES={MODULE}
IMAGE='mbbs-operator-app:webhook-receiver-20261109'
ROLLBACK='mbbs-operator-app:webhook-receiver-rollback-20261109'
T='test/webhook-receiver/webhook-receiver.test.js :: '
TARGET_FILES=[T.split(' :: ')[0]]
EXPECTED_TARGET=5
NEW_TESTS={T+name for name in (
  'the receiver saves a NetSuite order webhook to the inbox and answers like the app',
  'refusals and the legacy body secret match the app',
  'health reports whether the database answers',
  'the receiver never loads the app (server.js)',
  'the container entry point starts, saves a webhook, and stops cleanly on SIGTERM')}
REGRESSION=['test/origin-keep-alive/origin-keep-alive.test.js','test/mbt/integration/purchase-receipt-http.test.js',
  'test/mbt/integration/http-capabilities.test.js']
MARKERS={MODULE:'createNetSuiteOrderWebhookReceiver'}
UNRELATED=('aiChat','ai-chat','AiChat','client-error-reporter','autoRetry','adminRepost')
MAX_CHANGED_LINES=160

PROJECT='mbbs-webhook-receiver'
SERVICE='webhook-receiver'
CONTAINER='mbbs-operator-app-webhook-receiver-1'
FORWARDER='mbbs-webhook-3001-forward'
FORWARDER_RUN=['docker','run','-d','--name',FORWARDER,'--restart','unless-stopped','--network','host','--read-only','--memory','64m',
  '--pids-limit','32','--label','com.mbbs.purpose=temporary-webhook-forward-until-receiver','--entrypoint','node',
  'mbbs-operator-app:origin-keep-alive-20261109','-e',
  'const net=require("node:net");net.createServer(c=>{const u=net.connect(3000,"127.0.0.1");c.pipe(u);u.pipe(c);'
  'c.on("error",()=>u.destroy());u.on("error",()=>c.destroy());c.on("close",()=>u.destroy());u.on("close",()=>c.destroy());})'
  '.listen(3001,"127.0.0.1",()=>console.log("forwarding 127.0.0.1:3001 -> 127.0.0.1:3000"));']
COMPOSE_FILE=OUT/'compose.webhook-receiver.json'
ENV_DIR=REPO/'docker/env'
HEALTH_TEST=["CMD-SHELL","node -e \"fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))\""]

for scope in (split,sor):scope.update(OUT=OUT)
split.update(PATCH=PATCH,FILES=FILES,IMAGE=IMAGE,ROLLBACK=ROLLBACK)
base.update(OUT=OUT,FILES=FILES,IMAGE=IMAGE,ROLLBACK=ROLLBACK)
prev.update(OUT=OUT,FILES=FILES,TARGET_FILES=TARGET_FILES,REGRESSION=REGRESSION)
save,sha=base['save'],base['sha']

def compose_definition():
    return {'name':PROJECT,'services':{SERVICE:{
      'image':IMAGE,'container_name':CONTAINER,'entrypoint':['docker-entrypoint.sh'],
      'command':['node',MODULE],'user':'node','working_dir':'/app','restart':'unless-stopped',
      'environment':{'NODE_ENV':'production','PORT':'3000','DATABASE_POOL_MAX':'5'},
      # Same .env files and data volume as the app and worker: config.js picks the active .env from /app/data.
      'volumes':[{'type':'bind','source':str(ENV_DIR/'.env'),'target':'/app/.env','read_only':True},
                 {'type':'bind','source':str(ENV_DIR/'.env.old'),'target':'/app/.env.old','read_only':True},
                 {'type':'volume','source':'mbbs-operator-app_app_data','target':'/app/data'}],
      'ports':[{'target':3000,'published':'3001','host_ip':'127.0.0.1','protocol':'tcp'}],
      'networks':{'mbbs-operator-app_mbbs':{'aliases':[SERVICE]}},
      'cpus':'0.5','mem_limit':'512m','pids_limit':128,
      'logging':{'driver':'json-file','options':{'max-size':'10m','max-file':'3'}},
      'healthcheck':{'test':HEALTH_TEST,'interval':'30s','timeout':'5s','start_period':'10s','retries':3}}},
      'networks':{'mbbs-operator-app_mbbs':{'external':True,'name':'mbbs-operator-app_mbbs'}},
      'volumes':{'mbbs-operator-app_app_data':{'external':True,'name':'mbbs-operator-app_app_data'}}}

def compose(*args):
    return ['sudo','-n','docker','compose','-p',PROJECT,'-f',str(COMPOSE_FILE),*args]

def make_patch():
    OUT.mkdir(parents=True,exist_ok=True)
    sor['capture']()
    live=OUT/'live-before'
    assert not (live/MODULE).exists(),'the receiver is already in the live app'
    result=subprocess.run(['diff','-u','--label','/dev/null','--label',f'b/server/{MODULE}','/dev/null',str(SERVER/MODULE)],capture_output=True,text=True)
    assert result.returncode==1,result.stderr
    CODE_PATCH.write_text(f'diff --git a/server/{MODULE} b/server/{MODULE}\n'+result.stdout);PATCH.write_bytes(CODE_PATCH.read_bytes())
    check=subprocess.run(['patch','-p2','--fuzz=0','--dry-run','--batch','-d',str(live)],stdin=PATCH.open('rb'),capture_output=True,text=True)
    assert check.returncode==0,('Patch does not apply to live',check.stdout[-3000:])
    print(json.dumps({'patch':str(PATCH),'moduleSha256':sha(SERVER/MODULE)}))

def prepare():
    state=sor['capture']()
    live,candidate=OUT/'live-before',OUT/'candidate'
    subprocess.run(['rm','-rf','--',str(candidate)],check=True)
    subprocess.run(['cp','-a',str(live),str(candidate)],check=True)
    with PATCH.open('rb') as patch:
        subprocess.run(['patch','-p2','--fuzz=0','--no-backup-if-mismatch','--batch','-d',str(candidate)],stdin=patch,check=True)
    differs=prev['changed_files'](live,candidate)
    assert differs==sorted(FILES),('Candidate must differ from live in exactly the release files',differs)
    one=subprocess.run(['git','diff','--no-index','--','/dev/null',str(candidate/MODULE)],capture_output=True,text=True).stdout
    added=[line for line in one.splitlines() if line.startswith('+') and not line.startswith('+++')]
    assert any(MARKERS[MODULE] in line for line in added)
    assert not any(word in line for line in added for word in UNRELATED),'unrelated work in candidate'
    assert len(added)<=MAX_CHANGED_LINES,('Release diff is larger than this change',len(added))
    (OUT/'release.patch').write_text(one)
    for path in [candidate,*candidate.rglob('*')]:path.chmod(0o755 if path.is_dir() else 0o644)
    save(OUT/'prepared.json',{'baseImage':state['app']['imageRef'],'patchSha256':sha(PATCH),'conflicts':[],
      'moduleBasis':{MODULE:'new file'},'sourceHashes':{MODULE:sha(candidate/MODULE)}})
    print(json.dumps({'baseImage':state['app']['imageRef'],'files':len(FILES),'addedLines':len(added)}))

def lint(art):
    tree=OUT/'candidate'
    mounts=[]
    for name in ('src','public','migrations'):mounts+=['-v',f'{tree}/{name}:/app/{name}:ro']
    checks=' && '.join(f'node --check {name}' for name in [*FILES,*TARGET_FILES])
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

def receiver_health(url='http://127.0.0.1:3001/health',tries=30):
    for _ in range(tries):
        result=subprocess.run(['curl','-sS','--max-time','3',url],capture_output=True,text=True)
        try:
            if json.loads(result.stdout)=={'ok':True,'service':'webhook-receiver'}:return True
        except ValueError:
            pass
        time.sleep(1)
    return False

def restore_forwarder():
    subprocess.run(compose('down','--remove-orphans'),capture_output=True,text=True)
    subprocess.run(['docker','rm','-f',FORWARDER],capture_output=True)
    subprocess.run(FORWARDER_RUN,capture_output=True,text=True,check=True)

def deploy():
    built=json.loads((OUT/'built.json').read_text())
    assert json.loads((OUT/'validation.json').read_text()).get('passed') is True
    assert json.loads(base['docker']('image','inspect',IMAGE))[0]['Id']==built['imageId']
    assert base['ensure_sources']()['sourceHashes']==built['sourceHashes'],'Candidate changed after build'
    app_before=base['metadata'](APP)
    save(COMPOSE_FILE,compose_definition())
    config=subprocess.run(compose('config','--quiet'),capture_output=True,text=True)
    assert config.returncode==0,config.stderr[-3000:]
    (OUT/'rollback-command.txt').write_text(' '.join(compose('down'))+'\n'+' '.join(FORWARDER_RUN)+'\n'
      '# or move the Cloudflare rule for /api/webhooks/netsuite/order back to http://localhost:3000\n')
    switched=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
    # Port 3001 is free only between these two commands (about a second).
    subprocess.run(['docker','rm','-f',FORWARDER],capture_output=True)
    up=subprocess.run(compose('up','-d','--no-build',SERVICE),capture_output=True,text=True)
    (OUT/'deployment-audit.log').write_text(up.stdout+up.stderr)
    try:
        assert up.returncode==0,(up.stdout+up.stderr)[-3000:]
        assert receiver_health(),'The receiver did not answer /health on 127.0.0.1:3001'
        ready=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
        info=json.loads(base['docker']('inspect',CONTAINER))[0]
        assert info['Image']==built['imageId'] and info['State']['Running']
        assert base['metadata'](APP)==app_before,'The app changed during the receiver deploy'
    except BaseException:
        restore_forwarder()
        raise
    save(OUT/'deployment.json',{'deployedAt':switched,'readyAt':ready,'container':CONTAINER,'image':IMAGE,'imageId':built['imageId'],
      'composeProject':PROJECT,'composeFile':str(COMPOSE_FILE),'appUnchanged':True,'forwarderRemoved':FORWARDER})
    verify()

def verify():
    deployed=json.loads((OUT/'deployment.json').read_text())
    for name,expected in base['ensure_sources']()['sourceHashes'].items():
        assert base['docker']('exec',CONTAINER,'sha256sum','/app/'+name).split()[0]==expected,name
    assert receiver_health(tries=5),'receiver unhealthy'
    assert base['health'](),'Application is not healthy'
    # Through Cloudflare: a GET on the webhook path reaches the receiver (JSON 404), not the app (HTML 404).
    public=subprocess.run(['curl','-sS','--max-time','10','-o','-','-w','\n%{http_code}','https://test.mbbsoperation.com/api/webhooks/netsuite/order'],
      capture_output=True,text=True)
    body,_,code=public.stdout.rpartition('\n')
    assert code=='404' and body.strip()=='{"error":"Not found."}',('Cloudflare does not route the webhook path to the receiver',code,body[:200])
    # Without the secret the receiver refuses and saves nothing.
    refused=subprocess.run(['curl','-sS','--max-time','10','-o','/dev/null','-w','%{http_code}','-X','POST','-H','content-type: application/json',
      '-d','{"recordType":"salesorder","id":"1"}','https://test.mbbsoperation.com/api/webhooks/netsuite/order'],capture_output=True,text=True)
    assert refused.stdout=='401',refused.stdout
    save(OUT/'live-verification.json',{'receiverHealthy':True,'appHealthy':True,'cloudflareRoutesToReceiver':True,
      'unsignedRefused':True,'deployedAt':deployed['deployedAt']})
    print(json.dumps({'liveVerification':'passed','container':CONTAINER,'deployedAt':deployed['deployedAt'],'readyAt':deployed.get('readyAt')}))

if __name__=='__main__':
    {'patch':make_patch,'prepare':prepare,'validate':validate,'build':build,'deploy':deploy,'verify':verify}[sys.argv[1]]()
