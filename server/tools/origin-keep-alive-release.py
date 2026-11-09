#!/usr/bin/env python3
"""Release (2026-11-09): the app keeps idle connections from cloudflared open longer than cloudflared reuses them.

The Cloudflare tunnel (cloudflared, origin http://localhost:3000) reuses an idle connection to the app for up to
90 s. server.js never set server.keepAliveTimeout, so Node closed idle connections after its 5 s default. A request
that cloudflared sent on a connection the app was just closing failed with "Unable to reach the origin service: EOF"
(or "http: server closed idle connection") and the caller got a 502. Outside releases this happened about 10 times a
day (18 lines on 2026-11-08/09): print-agent lease, Operator background photos, heartbeats, and NetSuite order
webhooks on 10/30, 11/02 and 11/03.

Change (live copy plus exactly EDITS and the new module src/http-keep-alive.js):
  startServer returns applyOriginKeepAlive(app.listen(...)), which sets keepAliveTimeout to 120 s, so cloudflared
  always closes an idle connection first. Port 3000 listens on 127.0.0.1 only (cloudflared is the only client).
  headersTimeout/requestTimeout are unchanged: on Node 20 they apply only while a request is being received.
  No schema, data or UI change. An app rollback restores the 5 s default.

Steps: patch -> prepare -> validate -> build -> deploy (verifies; rolls the app back on failure) -> verify.
"""
import json,os,runpy,signal,subprocess,sys
from pathlib import Path

previous=runpy.run_path(str(Path(__file__).with_name('special-scm-line-details-release.py')))
prev=previous['prev']
split,sor,base=prev['split'],prev['sor'],prev['base']
SERVER,REPO,APP=base['SERVER'],base['SERVER'].parent,base['APP']
OUT=SERVER/'deployments/origin-keep-alive-20261109'
PATCH=OUT/'change.patch'
# Kept beside the tool: server/deployments is subject to copy retention, tools/ is not.
CODE_PATCH=Path(__file__).with_name('origin-keep-alive-release.code.patch')
MODULE='src/http-keep-alive.js'
FILES=['src/server.js',MODULE]
NEW_FILES={MODULE}
IMAGE='mbbs-operator-app:origin-keep-alive-20261109'
ROLLBACK='mbbs-operator-app:origin-keep-alive-rollback-20261109'
T='test/origin-keep-alive/origin-keep-alive.test.js :: '
TARGET_FILES=[T.split(' :: ')[0]]
EXPECTED_TARGET=2
# Live must fail exactly these (the new behaviour) and nothing else in the target file.
NEW_TESTS={
  T+'the keep-alive helper keeps idle connections longer than cloudflared reuses them',
  T+'the real application keeps an idle connection open past the old 5 s limit',
}
REGRESSION=['test/mbt/integration/purchase-receipt-startup.test.js','test/dispatch/unit/dispatch-v2-summary-marker-wiring.test.js',
  'test/mbt/integration/http-capabilities.test.js','test/mbt/integration/purchase-receipt-http.test.js']

MODULE_TEXT='''// The Cloudflare tunnel (cloudflared) reuses an idle connection to the app for up to 90 s. Node closes
// idle keep-alive connections after 5 s by default, so a request cloudflared sent on a connection the app
// was just closing failed with "Unable to reach the origin service: EOF" and the caller got a 502
// (about 10 a day, including NetSuite order webhooks). Keeping idle connections open longer than
// cloudflared does means cloudflared always closes them first.
export const ORIGIN_KEEP_ALIVE_TIMEOUT_MS = 120_000;

/** @template {import("node:http").Server} T @param {T} server @returns {T} */
export function applyOriginKeepAlive(server) {
  server.keepAliveTimeout = ORIGIN_KEEP_ALIVE_TIMEOUT_MS;
  return server;
}
'''
LISTEN_OLD='''  return app.listen(config.port, () => {
    console.log(`MBBS Yard Server listening on ${config.appBaseUrl}`);
'''
LISTEN_NEW='''  // cloudflared reuses idle connections for up to 90 s; Node's 5 s default made some requests fail as 502.
  return applyOriginKeepAlive(app.listen(config.port, () => {
    console.log(`MBBS Yard Server listening on ${config.appBaseUrl}`);
'''
END_OLD='''    setInterval(() => void dispatchActualArrivalTick(), 15000);
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
'''
END_NEW='''    setInterval(() => void dispatchActualArrivalTick(), 15000);
  }));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
'''
IMPORT_OLD='import { createSharedJsonRead } from "./shared-json-read.js";\n'
IMPORT_NEW=IMPORT_OLD+'import { applyOriginKeepAlive } from "./http-keep-alive.js";\n'
# (file, live text, released text): each live text must occur exactly once in the live copy.
EDITS=[('src/server.js',IMPORT_OLD,IMPORT_NEW),('src/server.js',LISTEN_OLD,LISTEN_NEW),('src/server.js',END_OLD,END_NEW)]
EDITED=sorted({name for name,_,_ in EDITS})
# Refuse to stack this change on a live copy that already has it.
ABSENT=[('src/server.js','applyOriginKeepAlive'),('src/server.js','keepAliveTimeout')]
MARKERS={'src/server.js':'applyOriginKeepAlive',MODULE:'keepAliveTimeout'}
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
    """Capture live, apply exactly EDITS to a copy of the live files, add the new module, store the patch."""
    OUT.mkdir(parents=True,exist_ok=True)
    sor['capture']()
    live,staged=OUT/'live-before',OUT/'patch-stage'
    subprocess.run(['rm','-rf','--',str(staged)],check=True)
    texts={name:(live/name).read_text(encoding='utf-8') for name in EDITED}
    for name,text in ABSENT:
        assert text not in texts[name],(name,'this change is already live')
    for name,old,new in EDITS:
        assert texts[name].count(old)==1,(name,'live text not found exactly once',old[:160])
        texts[name]=texts[name].replace(old,new)
    texts[MODULE]=MODULE_TEXT
    parts=[]
    for name in FILES:
        target=staged/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_text(texts[name],encoding='utf-8')
        old=live/name
        assert old.exists()!=(name in NEW_FILES),(name,'new-file expectation does not match live')
        result=subprocess.run(['diff','-u','--label','/dev/null' if name in NEW_FILES else f'a/server/{name}','--label',f'b/server/{name}',
          str(old) if old.exists() else '/dev/null',str(target)],capture_output=True,text=True)
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
    for name in NEW_FILES:assert not (live/name).exists(),name+' already live'
    with PATCH.open('rb') as patch:
        subprocess.run(['patch','-p2','--fuzz=0','--no-backup-if-mismatch','--batch','-d',str(candidate)],stdin=patch,check=True)
    differs=prev['changed_files'](live,candidate)
    assert differs==sorted(FILES),('Candidate must differ from live in exactly the release files',differs)
    assert (candidate/MODULE).read_text(encoding='utf-8')==MODULE_TEXT
    diff,changed=[],0
    for name in FILES:
        old=str(live/name) if (live/name).exists() else '/dev/null'
        one=subprocess.run(['git','diff','--no-index','--',old,str(candidate/name)],capture_output=True,text=True).stdout
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

def deploy():
    captured=json.loads((OUT/'capture.json').read_text())['app']['imageId']
    assert json.loads((OUT/'validation.json').read_text()).get('baseImageId')==captured==base['metadata'](APP)['imageId'],\
        'Validation was not run on the current live image; patch, prepare and validate again'
    active=base['db']("SET default_transaction_read_only=on; SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing');")
    assert active=='0','A NetSuite posting is running; retry deployment after it finishes'
    base['deploy']()
    state=json.loads((OUT/'capture.json').read_text())
    (OUT/'rollback-command.txt').write_text(' '.join(base['compose'](state,OUT/'compose.rollback.json'))+'\n# No migration.\n')

# Inside the app container: one keep-alive connection to the running app, /health, 7 s idle, /health again.
KEEP_ALIVE_PROBE='''
import http from 'node:http';
import {config} from '/app/src/config.js';
const agent=new http.Agent({keepAlive:true,maxSockets:1});
const get=()=>new Promise((resolve,reject)=>{
  const request=http.get({host:'127.0.0.1',port:config.port,path:'/health',agent},response=>{
    response.resume();response.on('end',()=>resolve({status:response.statusCode,reused:request.reusedSocket}));
  });
  request.on('error',reject);
});
const first=await get();
await new Promise(resolve=>setTimeout(resolve,7000));
const second=await get();
agent.destroy();
console.log(JSON.stringify({first,second}));
'''

def verify():
    prepared=base['ensure_sources']()
    for name,expected in prepared['sourceHashes'].items():
        assert base['docker']('exec',APP,'sha256sum','/app/'+name).split()[0]==expected,name
    assert base['health'](),'Application is not healthy'
    probe=subprocess.run(['docker','exec','-i','-w','/app',APP,'timeout','60','node','--input-type=module','-'],
      input=KEEP_ALIVE_PROBE,capture_output=True,text=True,timeout=90)
    assert probe.returncode==0,('Keep-alive probe failed',probe.stderr[-3000:])
    result=json.loads([line for line in probe.stdout.splitlines() if line.startswith('{')][-1])
    assert result['first']['status']==200 and result['second']['status']==200,result
    assert result['second']['reused'] is True,('The app closed an idle connection within 7 s',result)
    save(OUT/'live-verification.json',{'healthy':True,'sourceHashesVerified':True,'idleConnectionReusedAfter7s':True,'probe':result})
    print(json.dumps({'liveVerification':'passed','files':len(FILES),'probe':result}))
base['verify']=verify

if __name__=='__main__':
    {'patch':make_patch,'prepare':prepare,'validate':validate,'build':build,'deploy':deploy,'verify':verify}[sys.argv[1]]()
