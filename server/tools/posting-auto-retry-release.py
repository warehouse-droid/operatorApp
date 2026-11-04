#!/usr/bin/env python3
"""Release automatic retry of IF/IR posting after a timeout or lost connection over the live app.

Steps: prepare -> validate -> build -> deploy (applies migration 330, verifies; rolls the app back on
failure) -> verify. Modules are the live copy plus only this change (three-way merge against HEAD); the
two new files are added as-is; the MBT Gates shell gets only a new cache key for mbt-gates.js, so
unrelated workspace work is never released. Only the app container changes; the migration only adds
columns, which the previous image ignores, so an app rollback needs no schema rollback.
"""
import difflib,json,os,re,runpy,signal,subprocess,sys,urllib.request
from pathlib import Path

base=runpy.run_path(str(Path(__file__).with_name('bin-selection-release.py')))
scope=base['prepare'].__globals__
SERVER,REPO,APP=base['SERVER'],base['SERVER'].parent,base['APP']
OUT=SERVER/'deployments/posting-auto-retry-20261104'
MODULES=['src/operator-netsuite-posting-service.js','src/operator-netsuite-posting-repository.js',
  'src/operator-netsuite-posting-runtime.js','src/operator-netsuite-posting-controller.js',
  'src/transfer-order-posting-service.js','src/transfer-order-posting-repository.js','public/mbt-gates.js']
MIGRATION='330_posting_auto_retry.sql'
NEW_FILES=['src/posting-auto-retry-policy.js','migrations/'+MIGRATION]
MODULE_MARKERS=('auto_retry','autoRetry','AutoRetry','automaticRetry','next_retry_at')
TAG='postingAutoRetry=20261104'
SHELL_ASSETS={'public/mbt-gates.html':['/mbt-gates.js?']}
FILES=[*MODULES,*NEW_FILES,*SHELL_ASSETS]
NEW_TESTS=['test/mbt/unit/posting-auto-retry.red.test.js','test/mbt/integration/posting-auto-retry.test.js']
TRANSFER_TESTS=['test/mbt/integration/transfer-order-background-posting.test.js','test/mbt/integration/transfer-yard-posting.test.js',
  'test/mbt/integration/operator-to-yard-flow.test.js','test/mbt/integration/direct-to-completion.test.js',
  'test/mbt/integration/to-linked-so-completion.test.js']
GATES_TESTS=[token for token in json.loads((SERVER/'package.json').read_text())['scripts']['test:operator-netsuite-posting-gates'].split()
  if token.endswith('.js')]
TESTS=[*NEW_TESTS,*TRANSFER_TESTS,*GATES_TESTS]
LINT=['src/posting-auto-retry-policy.js','src/transfer-order-posting-service.js','src/transfer-order-posting-repository.js',
  'src/operator-netsuite-posting-service.js','src/operator-netsuite-posting-repository.js','src/operator-netsuite-posting-runtime.js',
  'src/operator-netsuite-posting-controller.js',*NEW_TESTS]
scope.update(OUT=OUT,FILES=FILES,IMAGE='mbbs-operator-app:posting-auto-retry-20261104',
  ROLLBACK='mbbs-operator-app:posting-auto-retry-rollback-20261104')

def apply_migration():
    db=base['db']
    if db(f"SELECT filename FROM schema_migrations WHERE filename='{MIGRATION}';"):
        return {'filename':MIGRATION,'alreadyApplied':True}
    sql=(OUT/'candidate/migrations'/MIGRATION).read_text()
    db("BEGIN; SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s';\n"+sql+
      f"\nINSERT INTO schema_migrations(filename) VALUES ('{MIGRATION}'); COMMIT;")
    return {'filename':MIGRATION,'applied':True,'sha256':base['sha'](OUT/'candidate/migrations'/MIGRATION)}
scope['apply_migration']=apply_migration

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
    head=base['gitfile']('HEAD',name).decode()
    work=(SERVER/name).read_text(encoding='utf-8')
    assert head and work!=head,f'{name}: workspace has no change against HEAD'
    if live==head: return work,'live equals HEAD'
    paths=[]
    for suffix,content in [('live',live),('head',head),('work',work)]:
        path=OUT/'merge-inputs'/(name+'.'+suffix);path.parent.mkdir(parents=True,exist_ok=True)
        path.write_text(content,encoding='utf-8');paths.append(str(path))
    result=subprocess.run(['git','merge-file','-p',*paths],capture_output=True,text=True)
    assert result.returncode==0,name+': live and this change conflict'
    return result.stdout,'merged onto live'

def prepare():
    capture();live=lambda name:(OUT/'live-before'/name).read_text(encoding='utf-8')
    out,basis={},{}
    for name in MODULES:
        out[name],basis[name]=merge_module(name,live(name))
        removed,added=changed(live(name),out[name])
        assert added and any(marker in line for line in added for marker in MODULE_MARKERS),name
    for name in NEW_FILES:
        assert not (OUT/'live-before'/name).exists(),f'{name} already exists live'
        out[name]=(SERVER/name).read_text(encoding='utf-8');basis[name]='new file'
    assert not [f for f in os.listdir(OUT/'live-before/migrations') if f.endswith('.sql') and f>MIGRATION],'Live has a later migration; renumber first'
    for name,assets in SHELL_ASSETS.items():
        html=live(name)
        for asset in assets:
            found=re.findall(r'src="('+re.escape(asset)+r'[^"]*)"',html)
            assert len(found)==1 and not found[0].endswith(TAG),(name,asset,found)
            html=html.replace(f'src="{found[0]}"',f'src="{found[0]}&{TAG}"')
        removed,added=changed(live(name),html)
        assert len(removed)==len(added)==len(assets) and all(TAG in line for line in added),(name,removed,added)
        out[name]=html
    candidate=OUT/'candidate'
    subprocess.run(['rm','-rf','--',str(candidate)],check=True)
    subprocess.run(['cp','-a',str(OUT/'live-before'),str(candidate)],check=True)
    patch=[]
    for name in FILES:
        before=live(name) if (OUT/'live-before'/name).exists() else ''
        (candidate/name).write_text(out[name],encoding='utf-8')
        patch.extend(difflib.unified_diff(before.splitlines(True),out[name].splitlines(True),fromfile='live/'+name,tofile='candidate/'+name))
    (OUT/'release.patch').write_text(''.join(patch),encoding='utf-8')
    for path in [candidate,*candidate.rglob('*')]:path.chmod(0o755 if path.is_dir() else 0o644)
    prepared={'baseImage':json.loads((OUT/'capture.json').read_text())['app']['imageRef'],'conflicts':[],'moduleBasis':basis,
      'sourceHashes':{name:base['sha'](candidate/name) for name in FILES},
      'sameAsWorkspace':{name:out[name]==(SERVER/name).read_text(encoding='utf-8') for name in FILES if name not in SHELL_ASSETS}}
    base['save'](OUT/'prepared.json',prepared)
    print(json.dumps({'baseImage':prepared['baseImage'],'files':len(FILES),'patchLines':len(patch),'moduleBasis':basis}))

def tap(text):
    rows=[(s,n) for s,n in re.findall(r'^\s*(not ok|ok) \d+ - (.+)$',text,re.M) if ' # SKIP' not in n]
    return {'passed':sorted(n for s,n in rows if s=='ok'),'failed':sorted(n for s,n in rows if s=='not ok')}

def suite(art):
    """Isolated, bounded Compose project on the candidate migrations; always torn down."""
    project=f'mbbs-posting-auto-retry-{os.getpid()}'
    override=art/'compose.json'
    artifact={'type':'bind','source':str(art),'target':'/app/test-artifacts'}
    disposable={'com.mbbs.lifecycle':'disposable-test'}
    migrations={'type':'bind','source':str(OUT/'candidate/migrations'),'target':'/app/migrations','read_only':True}
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
        live=run(OUT/'live-before',f'node --test --test-concurrency=1 {" ".join(NEW_TESTS)}')
        (art/'live.tap').write_text(live.stdout+live.stderr)
        lint={}
        for label,tree in [('live',OUT/'live-before'),('candidate',OUT/'candidate')]:
            present=[f for f in LINT if f.startswith('test/') or (tree/f).exists()]
            output=run(tree,f'npx eslint --config eslint.mbt.config.js --format json {" ".join(present)}').stdout
            (art/f'lint-{label}.json').write_text(output)
            lint[label]={(Path(row['filePath']).name,m.get('ruleId'),m['message']) for row in json.loads(output) for m in row['messages']}
        result=run(OUT/'candidate',f'node --test --test-concurrency=1 {" ".join(TESTS)}')
        (art/'candidate.tap').write_text(result.stdout+result.stderr)
        return tap(live.stdout),lint,result.returncode,tap(result.stdout)
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
    repro,lint,code,result=suite(art)
    # The live code must fail the new tests (proves they exercise this change).
    assert repro['failed'] or 'ERR_MODULE_NOT_FOUND' in (art/'live.tap').read_text(),('Live code should fail the new tests',repro)
    # Pre-existing findings (e.g. verifyObservedRecord complexity) are tolerated; this change may add none.
    added=sorted(lint['candidate']-lint['live'])
    assert not added,('This change adds lint findings',added)
    checks={'liveReproduction':{'failed':len(repro['failed'])},
      'lint':{'files':len(LINT),'newFindings':0,'preExistingFindings':len(lint['candidate'])},
      'candidate':{'files':len(TESTS),'passed':len(result['passed']),'failed':result['failed']}}
    assert code==0 and not result['failed'] and len(result['passed'])>=170,\
        ('Candidate tests failed',checks,(art/'candidate.tap').read_text()[-4000:])
    leftovers=subprocess.check_output(['docker','ps','-aq','--filter','name=mbbs-posting-auto-retry-'],text=True).strip()
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
    status,body=get('http://127.0.0.1:3000/admin/mbt-gates')
    assert status==200 and TAG.encode() in body,'/admin/mbt-gates'
    checks.append({'path':'/admin/mbt-gates','status':status})
    url=re.search(r'src="(/mbt-gates\.js\?[^"]*)"',(OUT/'candidate/public/mbt-gates.html').read_text(encoding='utf-8'))[1]
    status,body=get('http://127.0.0.1:3000'+url)
    assert status==200 and body==(OUT/'candidate/public/mbt-gates.js').read_bytes(),url
    checks.append({'path':url,'status':status})
    for path in ['/api/admin/operator-netsuite-posting/attention']:
        status=int(subprocess.check_output(['curl','-sS','--max-time','15','-o','/dev/null','-w','%{http_code}','http://127.0.0.1:3000'+path],text=True))
        assert status==401,f'{path}: {status}'
        checks.append({'path':path,'status':status})
    columns=base['db']("""SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND (
      (table_name='transfer_order_posting_jobs' AND column_name IN ('auto_retry_count','next_retry_at')) OR
      (table_name='operator_netsuite_posting_commands' AND column_name IN ('auto_retry_count','next_auto_retry_at')));""")
    assert columns=='4',f'auto-retry columns: {columns}'
    assert base['db'](f"SELECT filename FROM schema_migrations WHERE filename='{MIGRATION}';")==MIGRATION
    base['save'](OUT/'live-verification.json',{'healthy':True,'sourceHashesVerified':True,'http':checks,'migration':MIGRATION,'columns':4})
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
