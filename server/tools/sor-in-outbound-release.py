#!/usr/bin/env python3
"""Release SOR and SOR-Return types in the In/Outbound Record (Sales, Dispatch, Control) over the live app.

Steps: prepare -> validate -> build -> deploy (verifies; rolls the app back on failure) -> verify.
No migration. Modules are the live copy plus only this change (three-way merge against HEAD);
shared shells (i18n.js and page HTML) get only this release's lines, so unrelated workspace work
is never released.
"""
import difflib,json,os,re,runpy,signal,subprocess,sys,urllib.request
from pathlib import Path

base=runpy.run_path(str(Path(__file__).with_name('bin-selection-release.py')))
scope=base['prepare'].__globals__
SERVER,REPO,APP=base['SERVER'],base['SERVER'].parent,base['APP']
OUT=SERVER/'deployments/sor-in-outbound-20261103'
MODULES=['src/yard-movement-repository.js','public/control.js','public/dispatch-loaded-export.js']
TAG='sorRecords=20261103'
# A follow-up release sets PREVIOUS (the deployed release directory) and PREVIOUS_TAG.
PREVIOUS=None
PREVIOUS_TAG=None
MODULE_MARKERS=('sor_',)
SHELL_ASSETS={'public/control.html':['/control.js?','/i18n.js?'],'public/admin.html':['/control.js?'],
  'public/dispatch-loaded-export.html':['/dispatch-loaded-export.js?','/i18n.js?']}
I18N_ANCHOR='    "yard.coOrder": "CO 订单",\n'
I18N_LINES='    "yard.sorOrder": "SOR 租赁订单",\n    "yard.sorReturn": "SOR 租赁退还",\n'
FILES=[*MODULES,'public/i18n.js',*SHELL_ASSETS]
TESTS=['test/mbt/integration/yard-movement-sor.test.js','test/mbt/integration/custom-order-movement-yard.test.js',
  'test/mbt/integration/yard-movement-po-search.test.js','test/mbt/integration/movement-document-history.test.js',
  'test/yard-movement-performance.test.js','test/mbt/unit/control-yard-photo-thumbnail.test.js',
  'test/mbt/infrastructure/legacy-public-syntax.test.js']
HARNESSES=['src/dispatch-loaded-export-harness.js','src/yard-movement-integration-harness.js',
  'src/sales-order-reload-yard-history-harness.js']
scope.update(OUT=OUT,FILES=FILES,IMAGE='mbbs-operator-app:sor-in-outbound-20261103',
  ROLLBACK='mbbs-operator-app:sor-in-outbound-rollback-20261103')
scope['apply_migration']=lambda:{'required':False}

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
    removed,added=[],[]
    for line in difflib.unified_diff(old.splitlines(),new.splitlines(),lineterm='',n=0):
        if line.startswith(('---','+++','@@')):continue
        (removed if line.startswith('-') else added).append(line[1:])
    return removed,added

def merge_module(name,live):
    label='previous release' if PREVIOUS else 'HEAD'
    head=(PREVIOUS/'candidate'/name).read_text(encoding='utf-8') if PREVIOUS else base['gitfile']('HEAD',name).decode()
    work=(SERVER/name).read_text(encoding='utf-8')
    assert head and work!=head,f'{name}: workspace has no change against {label}'
    if live==head: return work,f'live equals {label}'
    paths=[]
    for suffix,content in [('live',live),('head',head),('work',work)]:
        path=OUT/'merge-inputs'/(name+'.'+suffix);path.parent.mkdir(parents=True,exist_ok=True)
        path.write_text(content,encoding='utf-8');paths.append(str(path))
    result=subprocess.run(['git','merge-file','-p',*paths],capture_output=True,text=True)
    assert result.returncode==0,name+': live and this change conflict'
    return result.stdout,'merged onto live'

def prepare():
    state=capture();live=lambda name:(OUT/'live-before'/name).read_text(encoding='utf-8')
    out,basis={},{}
    for name in MODULES:
        out[name],basis[name]=merge_module(name,live(name))
        removed,added=changed(live(name),out[name])
        assert added and any(marker in line for line in added for marker in MODULE_MARKERS),name
    text=live('public/i18n.js')
    assert text.count(I18N_ANCHOR)==1 and I18N_LINES.split(':')[0] not in text,'live i18n.js is not the expected base'
    out['public/i18n.js']=text.replace(I18N_ANCHOR,I18N_ANCHOR+I18N_LINES)
    assert changed(text,out['public/i18n.js'])==([],[l for l in I18N_LINES.splitlines()])
    for name,assets in SHELL_ASSETS.items():
        html=live(name)
        for asset in assets:
            found=re.findall(r'src="('+re.escape(asset)+r'[^"]*)"',html)
            assert len(found)==1 and not found[0].endswith(TAG),(name,asset,found)
            if PREVIOUS_TAG:
                assert found[0].endswith('&'+PREVIOUS_TAG),(name,asset,found)
                updated=found[0][:-len(PREVIOUS_TAG)]+TAG
            else:
                updated=f'{found[0]}&{TAG}'
            html=html.replace(f'src="{found[0]}"',f'src="{updated}"')
        removed,added=changed(live(name),html)
        assert len(removed)==len(added)==len(assets) and all(TAG in line for line in added),(name,removed,added)
        out[name]=html
    candidate=OUT/'candidate'
    subprocess.run(['rm','-rf','--',str(candidate)],check=True)
    subprocess.run(['cp','-a',str(OUT/'live-before'),str(candidate)],check=True)
    patch=[]
    for name in FILES:
        (candidate/name).write_text(out[name],encoding='utf-8')
        patch.extend(difflib.unified_diff(live(name).splitlines(True),out[name].splitlines(True),fromfile='live/'+name,tofile='candidate/'+name))
    (OUT/'release.patch').write_text(''.join(patch),encoding='utf-8')
    for path in [candidate,*candidate.rglob('*')]:path.chmod(0o755 if path.is_dir() else 0o644)
    prepared={'baseImage':state['app']['imageRef'],'conflicts':[],'moduleBasis':basis,
      'sourceHashes':{name:base['sha'](candidate/name) for name in FILES},
      'sameAsWorkspace':{name:out[name]==(SERVER/name).read_text(encoding='utf-8') for name in FILES}}
    base['save'](OUT/'prepared.json',prepared)
    print(json.dumps({'baseImage':prepared['baseImage'],'files':len(FILES),'patchLines':len(patch),'moduleBasis':basis}))

def tap(text):
    rows=[(s,n) for s,n in re.findall(r'^(not ok|ok) \d+ - (.+)$',text,re.M) if ' # SKIP' not in n]
    return {'passed':sorted(n for s,n in rows if s=='ok'),'failed':sorted(n for s,n in rows if s=='not ok')}

def suite(art):
    """Isolated, bounded Compose project on live migrations; always torn down."""
    project=f'mbbs-sor-records-{os.getpid()}'
    override=art/'compose.json'
    artifact={'type':'bind','source':str(art),'target':'/app/test-artifacts'}
    disposable={'com.mbbs.lifecycle':'disposable-test'}
    migrations={'type':'bind','source':str(OUT/'live-before/migrations'),'target':'/app/migrations','read_only':True}
    override.write_text(json.dumps({'services':{
      'migrate':{'volumes':[migrations,artifact],'labels':disposable},
      'test':{'volumes':[migrations,artifact],'labels':disposable},
      'db':{'labels':disposable}}}))
    compose=['docker','compose','-p',project,'-f',str(REPO/'docker-compose.mbt-test.yml'),'-f',str(override)]
    def step(*args):
        result=subprocess.run([*compose,*args],capture_output=True,text=True)
        assert result.returncode==0,(args,(result.stdout+result.stderr)[-3000:])
    def run(tree,command):
        mounts=[]
        for name in ['src','public']:mounts+=['-v',f'{tree/name}:/app/{name}:ro']
        return subprocess.run([*compose,'run','--rm','--no-deps','-T',*mounts,'test','sh','-c',command],
          capture_output=True,text=True,timeout=3600)
    try:
        step('build','test','migrate');step('up','-d','--wait','db');step('run','--rm','--no-deps','-T','migrate')
        live=run(OUT/'live-before','node --test --test-concurrency=1 test/mbt/integration/yard-movement-sor.test.js')
        (art/'live.tap').write_text(live.stdout+live.stderr)
        harness=' && '.join(f'node {name}' for name in HARNESSES)
        result=run(OUT/'candidate',f'node --test --test-concurrency=1 {" ".join(TESTS)}; t=$?; {harness}; h=$?; echo "HARNESS_EXIT=$h"; exit $((t|h))')
        (art/'candidate.tap').write_text(result.stdout+result.stderr)
        return tap(live.stdout),result.returncode,tap(result.stdout),'HARNESS_EXIT=0' in result.stdout
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
    repro,code,result,harnesses=suite(art)
    # The live repository must fail the new SOR tests (proves the tests exercise the change).
    assert repro['failed'],('Live code should fail the SOR tests',repro)
    checks={'liveReproduction':{'failed':repro['failed']},
      'candidate':{'files':len(TESTS),'passed':len(result['passed']),'failed':result['failed'],'harnesses':len(HARNESSES) if harnesses else 0}}
    assert code==0 and harnesses and not result['failed'] and len(result['passed'])>=30,\
        ('Candidate tests failed',checks,(art/'candidate.tap').read_text()[-4000:])
    # Other sessions may be running their own disposable tests; check only this release's containers.
    leftovers=subprocess.check_output(['docker','ps','-aq','--filter','name=mbbs-sor-records-'],text=True).strip()
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
    checks=[]
    for path in ['/control/yard-in-outbound','/dispatch/loaded-export','/sales/in-outbound-record']:
        status,body=get('http://127.0.0.1:3000'+path)
        assert status==200 and TAG.encode() in body,path
        checks.append({'path':path,'status':status})
    for shell,assets in SHELL_ASSETS.items():
        html=(OUT/'candidate'/shell).read_text(encoding='utf-8')
        for asset in assets:
            url=re.search(r'src="('+re.escape(asset)+r'[^"]*)"',html)[1]
            status,body=get('http://127.0.0.1:3000'+url)
            assert status==200 and body==(OUT/'candidate/public'/asset.strip('/?')).read_bytes(),url
            checks.append({'path':url,'status':status})
    for path in ['/api/control/loaded-orders?direction=outbound&orderType=sor_order','/api/dispatch/loaded-orders?direction=inbound&orderType=sor_return']:
        status=int(subprocess.check_output(['curl','-sS','--max-time','15','-o','/dev/null','-w','%{http_code}','http://127.0.0.1:3000'+path],text=True))
        assert status==401,f'{path}: {status}'
        checks.append({'path':path,'status':status})
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
