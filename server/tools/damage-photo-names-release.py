#!/usr/bin/env python3
"""Release Damage stock photo ZIP naming (Brand_location_month_Damage_SKU_photo-NN) and the
original/compressed download choice over the live app.

Steps: prepare -> validate -> build -> deploy (verifies; rolls the app back on failure) -> verify.
Static files only; no migration. Each file is the captured live copy plus only this change: prepare
asserts that the live -> workspace difference is exactly this feature, so unrelated workspace work is
never released.
"""
import difflib,json,os,re,runpy,signal,subprocess,sys,urllib.request
from pathlib import Path

base=runpy.run_path(str(Path(__file__).with_name('bin-selection-release.py')))
scope=base['prepare'].__globals__
SERVER,REPO,APP=base['SERVER'],base['SERVER'].parent,base['APP']
OUT=SERVER/'deployments/damage-photo-names-20261102'
FILES=['public/damage-photo-download.js','public/control-damage.js','public/i18n.js','public/control.html']
ASSETS={'damage-photo-download.js':'20261102-photo-names-v1','control-damage.js':'20261102-photo-names-v1'}
I18N_TAG='&damagePhotoNames=20261102'
TEST_IMAGE='mbbs-mbt-p1-test-e2e:latest'
scope.update(OUT=OUT,FILES=FILES,IMAGE='mbbs-operator-app:damage-photo-names-20261102',
  ROLLBACK='mbbs-operator-app:damage-photo-names-rollback-20261102')
scope['apply_migration']=lambda:{'required':False}
# The only lines this release may change in the shared shells (live -> candidate).
SHELL_CHANGES={
  'public/i18n.js':({'    "damageControl.downloadPhotos": "下载全部照片（ZIP）",'},
    {'    "damageControl.downloadPhotos": "下载原图（ZIP）",','    "damageControl.downloadCompressed": "下载压缩照片（ZIP）",'}),
}

def services(): return {key:base['metadata'](name) for key,name in base['SERVICES'].items()}

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
    state=capture();live=lambda name:(OUT/'live-before'/name).read_text(encoding='utf-8')
    work=lambda name:(SERVER/name).read_text(encoding='utf-8')
    out={name:work(name) for name in FILES}
    # Feature modules: the live copy must be the version this change was written against.
    assert 'readWithRetry' in live('public/damage-photo-download.js') and 'line-${' in live('public/damage-photo-download.js'),'live download module is not the expected base'
    assert live('public/control-damage.js')==base['gitfile']('HEAD','public/control-damage.js').decode(),'live control-damage.js differs from HEAD'
    for name in ['public/damage-photo-download.js','public/control-damage.js']:
        removed,added=changed(live(name),out[name])
        assert removed and added and not any('repair' in line.lower() for line in removed|added),name
    for name,(removed,added) in SHELL_CHANGES.items():
        assert changed(live(name),out[name])==(removed,added),(name,changed(live(name),out[name]))
    removed,added=changed(live('public/control.html'),out['public/control.html'])
    assert len(removed)==len(added)==3,('control.html',removed,added)
    for asset,version in ASSETS.items():
        assert f'<script src="/{asset}?v={version}"></script>' in out['public/control.html'],asset
    assert I18N_TAG in out['public/control.html'] and all('/i18n.js' in l or any(a in l for a in ASSETS) for l in added)
    candidate=OUT/'candidate'
    subprocess.run(['rm','-rf','--',str(candidate)],check=True)
    subprocess.run(['cp','-a',str(OUT/'live-before'),str(candidate)],check=True)
    patch=[]
    for name in FILES:
        (candidate/name).write_text(out[name],encoding='utf-8')
        patch.extend(difflib.unified_diff(live(name).splitlines(True),out[name].splitlines(True),fromfile='live/'+name,tofile='candidate/'+name))
    (OUT/'release.patch').write_text(''.join(patch),encoding='utf-8')
    for path in [candidate,*candidate.rglob('*')]:path.chmod(0o755 if path.is_dir() else 0o644)
    prepared={'baseImage':state['app']['imageRef'],'conflicts':[],
      'sourceHashes':{name:base['sha'](candidate/name) for name in FILES},
      'sameAsWorkspace':{name:out[name]==work(name) for name in FILES}}
    base['save'](OUT/'prepared.json',prepared)
    print(json.dumps({'baseImage':prepared['baseImage'],'files':len(FILES),'patchLines':len(patch)}))

def tap(text):
    rows=[(s,n) for s,n in re.findall(r'^(not ok|ok) \d+ - (.+)$',text,re.M) if ' # SKIP' not in n]
    return {'passed':sorted(n for s,n in rows if s=='ok'),'failed':sorted(n for s,n in rows if s=='not ok')}

def unit_on(public,art):
    """Naming unit test on a given public tree in a bounded, network-less, disposable container."""
    name=f'mbbs-photo-names-release-{os.getpid()}'
    command=['docker','run','--rm','--name',name,'--init','--cgroup-parent=mbbs-tests.slice',
      '--memory=2g','--memory-swap=2g','--pids-limit=512','--cpus=2','--label','com.mbbs.lifecycle=disposable-test',
      '--network','none','--read-only','--tmpfs','/tmp:rw,size=256m,mode=1777','-e','HOME=/tmp',
      '-v',f'{public}:/app/public:ro','-v',f'{SERVER/"test"}:/app/test:ro','-v',f'{art}:/app/test-artifacts',
      '-w','/app','--entrypoint','node',TEST_IMAGE,'--test','test/damage-photo-download.test.js']
    try:return subprocess.run(command,capture_output=True,text=True,timeout=600)
    finally:subprocess.run(['docker','rm','-f',name],capture_output=True)

def suite(files,art):
    """Isolated, bounded Compose project with live src/migrations and candidate public; always torn down."""
    project=f'mbbs-photo-names-{os.getpid()}'
    override=art/'compose.json'
    live,candidate=OUT/'live-before',OUT/'candidate'
    mount=lambda root,names:[{'type':'bind','source':str(root/n),'target':'/app/'+n,'read_only':True} for n in names]
    artifact={'type':'bind','source':str(art),'target':'/app/test-artifacts'}
    disposable={'com.mbbs.lifecycle':'disposable-test'}
    override.write_text(json.dumps({'services':{
      'migrate':{'volumes':[*mount(live,['src','migrations']),artifact],'labels':disposable},
      'e2e':{'volumes':[*mount(live,['src','migrations']),*mount(candidate,['public']),artifact],'labels':disposable},
      'db':{'labels':disposable}}}))
    compose=['docker','compose','-p',project,'-f',str(REPO/'docker-compose.mbt-test.yml'),'-f',str(override),'--profile','e2e','--profile','runtime']
    def step(*args):
        result=subprocess.run([*compose,*args],capture_output=True,text=True)
        assert result.returncode==0,(args,(result.stdout+result.stderr)[-3000:])
    try:
        step('build','migrate','e2e');step('up','-d','--wait','db');step('run','--rm','--no-deps','-T','migrate')
        result=subprocess.run([*compose,'run','--rm','--no-deps','-T','e2e','node','--test','--test-concurrency=1',*files],
          capture_output=True,text=True,timeout=3600)
        (art/'candidate.tap').write_text(result.stdout+result.stderr)
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
    checks={}
    # The live download module must fail the new naming tests (proves the tests exercise the change).
    repro=tap(unit_on(OUT/'live-before/public',art).stdout)
    assert any('Brand_location_month' in name for name in repro['failed']),('Live code should fail the naming test',repro)
    checks['liveReproduction']={'failed':repro['failed']}
    tests=sorted({*('test/'+p.name for p in (SERVER/'test').glob('damage-photo*.test.js')),
      *('test/'+p.name for p in (SERVER/'test').glob('control-damage-*.test.js'))})+['test/mbt/infrastructure/legacy-public-syntax.test.js']
    code,result=suite(tests,art)
    checks['candidate']={'files':len(tests),'passed':len(result['passed']),'failed':result['failed']}
    assert code==0 and not result['failed'] and len(result['passed'])>=60,('Candidate tests failed',checks,(art/'candidate.tap').read_text()[-4000:])
    leftovers=subprocess.check_output(['docker','ps','-aq','--filter','label=com.mbbs.lifecycle=disposable-test'],text=True).strip()
    assert not leftovers,'Disposable test containers remain'
    assert base['ensure_sources']()==prepared,'Candidate changed during validation'
    base['save'](OUT/'validation.json',{'passed':True,'sourceHashes':prepared['sourceHashes'],
      'baseImageId':json.loads((OUT/'capture.json').read_text())['app']['imageId'],'checks':checks,'cleanupVerified':True})
    print(json.dumps({'validation':'passed',**checks}))

def get(url):
    with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0','Cache-Control':'no-cache'}),timeout=20) as response:
        return response.status,response.read()

def verify():
    prepared=base['ensure_sources']()
    for name,expected in prepared['sourceHashes'].items():
        assert base['docker']('exec',APP,'sha256sum','/app/'+name).split()[0]==expected,name
    assert base['health'](),'Application is not healthy'
    html=(OUT/'candidate/public/control.html').read_text(encoding='utf-8');checks=[]
    status,body=get('http://127.0.0.1:3000/control/damage-stock')
    assert status==200 and b'photo-names-v1' in body and I18N_TAG.encode() in body;checks.append({'path':'/control/damage-stock','status':status})
    for asset in [*ASSETS,'i18n.js']:
        url=re.search(r'src="(/'+re.escape(asset)+r'\?[^"\s]+)"',html)[1]
        status,body=get('http://127.0.0.1:3000'+url)
        assert status==200 and body==(OUT/'candidate/public'/asset).read_bytes(),url
        checks.append({'path':url,'status':status})
    base['save'](OUT/'live-verification.json',{'healthy':True,'sourceHashesVerified':True,'http':checks})
    print(json.dumps({'liveVerification':'passed','files':len(FILES),'httpChecks':len(checks)}))
scope['verify']=verify

def deploy():
    captured=json.loads((OUT/'capture.json').read_text())['app']['imageId']
    assert json.loads((OUT/'validation.json').read_text()).get('baseImageId')==captured==base['metadata'](APP)['imageId'],\
        'Validation was not run on the current live image; prepare and validate again'
    active=base['db']("SET default_transaction_read_only=on; SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing');")
    assert active=='0','A NetSuite posting is running; retry deployment after it finishes'
    base['deploy']()
    state=json.loads((OUT/'capture.json').read_text())
    (OUT/'rollback-command.txt').write_text(' '.join(base['compose'](state,OUT/'compose.rollback.json'))+'\n')

if __name__=='__main__':
    {'prepare':prepare,'validate':validate,'build':base['build'],'deploy':deploy,'verify':verify}[sys.argv[1]]()
