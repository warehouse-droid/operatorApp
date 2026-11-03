#!/usr/bin/env python3
"""Release: Special Request PO creation no longer compares SO lines (SPREQ-000178).

Steps: prepare -> validate -> build -> deploy (verifies; rolls the app back on failure) -> verify.
One source file, no migration. The candidate is the captured live copy plus only this change
(three-way merge HEAD -> workspace), so unrelated workspace work is never released.
"""
import difflib,json,os,re,runpy,signal,subprocess,sys,urllib.error,urllib.request
from pathlib import Path

base=runpy.run_path(str(Path(__file__).with_name('bin-selection-release.py')))
scope=base['prepare'].__globals__
SERVER,REPO,APP=base['SERVER'],base['SERVER'].parent,base['APP']
OUT=SERVER/'deployments/special-po-so-independent-20261103'
FILES=['src/special-stock-request-repository.js']
REMOVED={"      if (!independentPurchase) await reconcileCanonicalOrderLines(id, 'sales_order', special.sales_order_netsuite_id, { required: true });",
  "      await reconcileCanonicalOrderLines(requestId, 'sales_order', row.sales_order_netsuite_id);"}
ADDED={'      // The PO is standalone: its lines are never compared with, or written to, the SO.',
  '      // SO line content is not a PO submission condition; the PO is standalone.'}
REPRODUCTION='PO creation is not blocked when the NetSuite SO item differs from the SO snapshot and the PO'
REQUIRED=[REPRODUCTION,
  'standalone PO claim leaves SO lines alone; the linked PO resolves exact SO line identities',
  'an unadjusted NetSuite SO edit does not prevent standalone PO creation or change the SO',
  'a pending quantity adjustment still prevents PO creation',
  *[f'owned PO submission is not blocked when {name}' for name in
    ['SO quantity changes','SO UOM changes','SO description is unreviewed','SO item changes']],
  'owned PO submission still blocks when case closes','owned PO submission still blocks when SO becomes planned']
TESTS=sorted('test/mbt/'+p.relative_to(SERVER/'test/mbt').as_posix() for kind in ['unit','integration']
  for p in (SERVER/'test/mbt'/kind).glob('special-*.test.js') if 'browser' not in p.name)
scope.update(OUT=OUT,FILES=FILES,IMAGE='mbbs-operator-app:special-po-so-independent-20261103',
  ROLLBACK='mbbs-operator-app:special-po-so-independent-rollback-20261103')
scope['apply_migration']=lambda:{'required':False}

def metadata(name):
    """The shared metadata hash, with DNS lists normalized: after the 2026-11-03 dockerd crash/restart the
    daemon reloads compose containers with Dns/DnsOptions/DnsSearch [] where fresh ones report null."""
    import hashlib
    row=json.loads(base['docker']('inspect',name))[0]
    config={k:row['Config'][k] for k in ['Env','User','Entrypoint','Cmd','WorkingDir']};config['Env']=sorted(config['Env'])
    host=dict(row['HostConfig']);host['Binds']=sorted(host.get('Binds') or [])
    for key in ('Dns','DnsOptions','DnsSearch'): host[key]=host.get(key) or None
    return {'imageId':row['Image'],'imageRef':row['Config']['Image'],
      'configurationHash':hashlib.sha256(json.dumps({'config':config,'host':host},sort_keys=True).encode()).hexdigest(),
      'compose':row['Config']['Labels']}
scope['metadata']=metadata

def services(): return {key:metadata(name) for key,name in base['SERVICES'].items()}

def capture():
    OUT.mkdir(parents=True,exist_ok=True)
    state=services()
    if (OUT/'capture.json').exists():
        assert json.loads((OUT/'capture.json').read_text())==state,'Live changed since capture; move live-before aside and prepare again'
        return state
    before=OUT/'live-before';before.mkdir(exist_ok=True)
    for name in ['src','public','migrations']:
        subprocess.run(['sudo','-n','docker','cp',APP+':/app/'+name,str(before/name)],check=True)
    subprocess.run(['sudo','-n','chown','-R',f'{os.getuid()}:{os.getgid()}',str(before)],check=True)
    assert state==services(),'Live changed while capturing'
    base['save'](OUT/'capture.json',state)
    return state

def changed(old,new):
    removed,added=set(),set()
    for line in difflib.unified_diff(old.splitlines(),new.splitlines(),lineterm='',n=0):
        if line.startswith(('---','+++','@@')):continue
        (removed if line.startswith('-') else added).add(line[1:])
    return removed,added

def prepare():
    state=capture();live_dir=OUT/'live-before'
    out={};conflicts=[];basis={}
    for name in FILES:
        live=(live_dir/name).read_bytes();head=base['gitfile']('HEAD',name)
        basis[name]='live equals HEAD' if live==head else 'live differs from HEAD (merged)'
        merged=base['merge'](live,head,(SERVER/name).read_bytes(),name,'special-po-so')
        if b'<<<<<<< ' in merged:conflicts.append(name)
        out[name]=merged
        # Scope fence: the release may only remove the two SO reconciliations.
        assert changed(live.decode(),merged.decode())==(REMOVED,ADDED),(name,changed(live.decode(),merged.decode()))
    candidate=OUT/'candidate'
    subprocess.run(['rm','-rf','--',str(candidate)],check=True)
    subprocess.run(['cp','-a',str(live_dir),str(candidate)],check=True)
    patch=[]
    for name in FILES:
        (candidate/name).write_bytes(out[name])
        patch.extend(difflib.unified_diff((live_dir/name).read_text(encoding='utf-8').splitlines(True),
          out[name].decode().splitlines(True),fromfile='live/'+name,tofile='candidate/'+name))
    (OUT/'release.patch').write_text(''.join(patch),encoding='utf-8')
    for path in [candidate,*candidate.rglob('*')]:path.chmod(0o755 if path.is_dir() else 0o644)
    prepared={'baseImage':state['app']['imageRef'],'conflicts':conflicts,'moduleBasis':basis,
      'sourceHashes':{name:base['sha'](candidate/name) for name in FILES},
      'sameAsWorkspace':{name:out[name]==(SERVER/name).read_bytes() for name in FILES}}
    base['save'](OUT/'prepared.json',prepared)
    print(json.dumps({k:prepared[k] for k in ['baseImage','conflicts','moduleBasis','sameAsWorkspace']}))

def tap(text):
    rows=[(s,n) for s,n in re.findall(r'^(not ok|ok) \d+ - (.+)$',text,re.M) if ' # SKIP' not in n]
    return {'passed':sorted(n for s,n in rows if s=='ok'),'failed':sorted(n for s,n in rows if s=='not ok')}

def suite(source,art,label):
    """One isolated, bounded Compose project with the given app source and workspace tests; always torn down."""
    project=f'mbbs-special-po-so-{label}-{os.getpid()}'
    override=art/f'compose-{label}.json'
    mounts=lambda root,names:[{'type':'bind','source':str(root/n),'target':'/app/'+n,'read_only':True} for n in names]
    artifact={'type':'bind','source':str(art),'target':'/app/test-artifacts'}
    disposable={'com.mbbs.lifecycle':'disposable-test'}
    override.write_text(json.dumps({'services':{
      'migrate':{'volumes':[*mounts(source,['src','migrations']),artifact],'labels':disposable},
      'e2e':{'volumes':[*mounts(source,['src','public','migrations']),*mounts(SERVER,['test']),artifact],'labels':disposable},
      'db':{'labels':disposable}}}))
    compose=['docker','compose','-p',project,'-f',str(REPO/'docker-compose.mbt-test.yml'),'-f',str(override),'--profile','e2e','--profile','runtime']
    def step(*args):
        result=subprocess.run([*compose,*args],capture_output=True,text=True)
        assert result.returncode==0,(args,(result.stdout+result.stderr)[-3000:])
    # No image builds during validation: concurrent BuildKit builds crashed dockerd on this host
    # (2026-11-03 15:01 UTC). The existing test images only supply the runtime; source and tests are mounted.
    for image in ['mbbs-mbt-p1-test-e2e:latest','mbbs-mbt-p1-test-test:latest']:
        assert subprocess.run(['docker','image','inspect',image],capture_output=True).returncode==0,'Missing test image '+image
    try:
        step('up','-d','--wait','db');step('run','--rm','--no-deps','-T','migrate')
        result=subprocess.run([*compose,'run','--rm','--no-deps','-T','e2e','node','--test','--test-concurrency=1',*TESTS],
          capture_output=True,text=True,timeout=3600)
        (art/f'{label}.tap').write_text(result.stdout+result.stderr)
        return result.returncode,tap(result.stdout)
    finally:
        subprocess.run([*compose,'down','--volumes','--remove-orphans'],capture_output=True)
        for kind in ['ps','volume','network']:
            args=['docker',kind,*(['-a'] if kind=='ps' else ['ls']),'-q','--filter',f'label=com.docker.compose.project={project}']
            assert not subprocess.check_output(args,text=True).strip(),f'{project} {kind} remains after teardown'

def validate():
    if not os.environ.get('MBBS_TEST_ARTIFACT_DIR'):
        raise SystemExit(subprocess.run([sys.executable,str(REPO/'docker/retention/retention.py'),'run','--',sys.executable,__file__,'validate']).returncode)
    signal.signal(signal.SIGTERM,lambda *_:sys.exit(143))
    prepared=base['ensure_sources']();art=Path(os.environ['MBBS_TEST_ARTIFACT_DIR']);os.chmod(art,0o777)
    subprocess.run(['python3','docker/verify-memory-limits.py'],cwd=REPO,check=True,capture_output=True)
    candidate_code,candidate=suite(OUT/'candidate',art,'candidate')
    tail=lambda label:(art/f'{label}.tap').read_text()[-6000:]
    assert len(candidate['passed'])>=1000,('Candidate run ended early',candidate_code,len(candidate['passed']),tail('candidate'))
    live_code,live=suite(OUT/'live-before',art,'live')
    assert len(live['passed'])>=1000,('Live baseline run ended early',live_code,len(live['passed']),tail('live'))
    checks={'files':len(TESTS),'live':{'exitCode':live_code,'passed':len(live['passed']),'failed':live['failed']},
      'candidate':{'exitCode':candidate_code,'passed':len(candidate['passed']),'failed':candidate['failed']}}
    # The live code must reproduce the SPREQ-000178 block; the candidate must fix it and every updated fence.
    assert REPRODUCTION in live['failed'],('Live code should fail the reproduction test',checks)
    missing=[name for name in REQUIRED if name not in candidate['passed']]
    assert not missing,('Required candidate tests did not pass',missing,checks)
    new=sorted(set(candidate['failed'])-set(live['failed']))
    assert not new,('Candidate introduced failures',new,tail('candidate'))
    leftovers=subprocess.check_output(['docker','ps','-aq','--filter','label=com.mbbs.lifecycle=disposable-test'],text=True).strip()
    assert not leftovers,'Disposable test containers remain'
    assert base['ensure_sources']()==prepared,'Candidate changed during validation'
    base['save'](OUT/'validation.json',{'passed':True,'sourceHashes':prepared['sourceHashes'],
      'baseImageId':json.loads((OUT/'capture.json').read_text())['app']['imageId'],'checks':checks,
      'preExistingFailures':sorted(set(candidate['failed'])&set(live['failed'])),'cleanupVerified':True})
    print(json.dumps({'validation':'passed',**checks}))

def get(path):
    try:
        with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:3000'+path,headers={'User-Agent':'Mozilla/5.0'}),timeout=20) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code

def verify():
    prepared=base['ensure_sources']()
    for name,expected in prepared['sourceHashes'].items():
        assert base['docker']('exec',APP,'sha256sum','/app/'+name).split()[0]==expected,name
    assert base['health'](),'Application is not healthy'
    checks=[]
    for path,expected in [('/health',(200,)),('/scm/stock-requests',(200,)),('/api/scm/special-stock-requests',(401,403))]:
        status=get(path);assert status in expected,(path,status);checks.append({'path':path,'status':status})
    base['save'](OUT/'live-verification.json',{'healthy':True,'sourceHashesVerified':True,'http':checks})
    print(json.dumps({'liveVerification':'passed','files':len(FILES),'httpChecks':len(checks)}))
scope['verify']=verify

def build():
    # Concurrent BuildKit builds crashed dockerd (and production) on 2026-11-03; never overlap another build.
    busy=[line for line in subprocess.run(['pgrep','-af',r'docker( compose .*)? (build|buildx build|buildx bake)( |$)|docker-buildx buildx (build|bake)( |$)'],
      capture_output=True,text=True).stdout.splitlines() if 'pgrep' not in line]
    assert not busy,('Another image build is running; retry after it finishes',busy)
    base['build']()

def deploy():
    captured=json.loads((OUT/'capture.json').read_text())['app']['imageId']
    assert json.loads((OUT/'validation.json').read_text()).get('baseImageId')==captured==metadata(APP)['imageId'],\
        'Validation was not run on the current live image; prepare and validate again'
    read=lambda sql:base['db']('SET default_transaction_read_only=on; '+sql)
    assert read("SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing');")=='0',\
        'A NetSuite posting is running; retry deployment after it finishes'
    assert read("SELECT count(*) FROM sales_special_stock_cases WHERE 'creating' IN (sales_order_operation_status,purchase_order_operation_status);")=='0',\
        'A Special SO/PO creation is running; retry deployment after it finishes'
    base['deploy']()
    state=json.loads((OUT/'capture.json').read_text())
    (OUT/'rollback-command.txt').write_text(' '.join(base['compose'](state,OUT/'compose.rollback.json'))+'\n')

if __name__=='__main__':
    {'prepare':prepare,'validate':validate,'build':build,'deploy':deploy,'verify':verify}[sys.argv[1]]()
