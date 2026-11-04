#!/usr/bin/env python3
"""Release commit dfd6a23 (Fix remaining Dispatch planner group, split and link defects) over the live app.

dfd6a23 was committed on 2026-10-31 but never deployed; the last planner release (planner-fixes-3)
shipped 4156a56. Only its 11 deployed files change; each is the live copy plus dfd6a23 (three-way
merge against dfd6a23^), and must equal HEAD. No migration.

Steps: prepare -> validate -> build -> deploy (verifies; rolls the app back on failure) -> verify.
Validation runs dfd6a23's own tests and the wider Dispatch suites on the live tree and on the
candidate in the bounded disposable test stack: the candidate must pass every dfd6a23 test, the live
tree must fail at least one, and the candidate must add no failure the live tree does not have.
"""
import collections,json,os,re,runpy,signal,subprocess,sys,tarfile,urllib.request
from pathlib import Path

release=runpy.run_path(str(Path(__file__).with_name('sor-in-outbound-release.py')))
sor=release['prepare'].__globals__
base=sor['scope']
SERVER,REPO,APP=base['SERVER'],base['SERVER'].parent,base['APP']
COMMIT='dfd6a23'
OUT=SERVER/'deployments/dispatch-planner-fixes-4-20261103'
FILES=['public/dispatch.html','public/dispatch.js','public/mbt-planning.html',
  'src/dispatch-delivery-group-repository.js','src/dispatch-order-target-repository.js',
  'src/dispatch-plan-repository.js','src/dispatch-planner-v2-repository.js','src/dispatch-repository.js',
  'src/dispatch-sales-resplit-repository.js','src/order-dependency-repository.js','src/server.js']
TAG='planner-fixes-4'
IMAGE='mbbs-operator-app:dispatch-planner-fixes-4-20261103'
ROLLBACK='mbbs-operator-app:dispatch-planner-fixes-4-rollback-20261103'
sor.update(OUT=OUT,__file__=str(Path(__file__).resolve()))
base.update(OUT=OUT,FILES=FILES,IMAGE=IMAGE,ROLLBACK=ROLLBACK)
save,sha,gitfile=base['save'],base['sha'],base['gitfile']

def git(*args): return subprocess.check_output(['git',*args],cwd=REPO,text=True)

def commit_tests():
    names=git('show','--name-only','--format=',COMMIT).split()
    tests=[n.removeprefix('server/') for n in names if n.startswith('server/test/')]
    return [t for t in tests if not t.endswith('.browser.test.mjs')],[t for t in tests if t.endswith('.browser.test.mjs')]

def prepare():
    state=sor['capture']()
    live=lambda name:(OUT/'live-before'/name).read_bytes()
    candidate=OUT/'candidate'
    subprocess.run(['rm','-rf','--',str(candidate)],check=True)
    subprocess.run(['cp','-a',str(OUT/'live-before'),str(candidate)],check=True)
    merged,patch={},[]
    for name in FILES:
        before,after=gitfile(COMMIT+'^',name),gitfile(COMMIT,name)
        assert before and after and before!=after,name
        current,content=live(name),gitfile('HEAD',name)
        # The candidate is HEAD, which must differ from live by exactly dfd6a23's changed lines
        # (context-free, so deployed edits next to dfd6a23's lines, e.g. repair assets, are fine).
        ours=[sorted(lines) for lines in sor['changed'](current.decode(),content.decode())]
        theirs=[sorted(lines) for lines in sor['changed'](before.decode(),after.decode())]
        assert ours==theirs,name+': live differs from HEAD by more than '+COMMIT+' (live changed since the repo was reconciled)'
        basis='live equals '+COMMIT+'^' if current==before else 'live plus '+COMMIT+' lines'
        (candidate/name).write_bytes(content);merged[name]=basis
        patch+=subprocess.run(['git','diff','--no-index','--',str(OUT/'live-before'/name),str(candidate/name)],capture_output=True,text=True).stdout.splitlines(True)
    for name in ['public/dispatch.html','public/mbt-planning.html']:
        assert TAG in (candidate/name).read_text() and TAG not in live(name).decode(),name
    (OUT/'release.patch').write_text(''.join(patch))
    for path in [candidate,*candidate.rglob('*')]:path.chmod(0o755 if path.is_dir() else 0o644)
    save(OUT/'prepared.json',{'baseImage':state['app']['imageRef'],'commit':git('rev-parse',COMMIT).strip(),
      'conflicts':[],'moduleBasis':merged,'sourceHashes':{name:sha(candidate/name) for name in FILES}})
    print(json.dumps({'baseImage':state['app']['imageRef'],'files':len(FILES),'patchLines':len(patch),'moduleBasis':merged}))

def tap(text):
    rows=re.findall(r'^(not ok|ok) \d+ - (.+?)(?: # (SKIP|TODO).*)?$',text,re.M)
    return {'passed':collections.Counter(n for s,n,k in rows if s=='ok' and not k),
            'failed':collections.Counter(n for s,n,k in rows if s=='not ok' and not k)}

def regression_tests(root):
    """Dispatch suites present in the committed test tree (root is a snapshot of HEAD's server/test)."""
    rel=lambda p:'test/'+str(p.relative_to(root))
    tests=sorted(rel(p) for d in ['unit','integration','frontend'] for p in (root/'dispatch'/d).glob('*.test.js'))
    pattern=re.compile(r'dispatch-delivery-group-repository|dispatch-order-target-repository|order-dependency-repository|'
      r'dispatch-sales-resplit-repository|dispatch-plan-repository|dispatch-planner-v2-repository|dispatch-repository|changedDispatchOrderStructureRefs')
    tests+=sorted(rel(p) for d in ['unit','integration'] for p in (root/'mbt'/d).glob('*.test.js') if pattern.search(p.read_text(errors='ignore')))
    browser=sorted(rel(p) for p in (root/'dispatch/frontend').glob('*.browser.test.mjs'))
    return tests,browser

def suite(art):
    """Bounded, isolated Compose project on live migrations (fresh database per tree) plus bounded
    one-off browser containers; everything is removed even on failure."""
    project=f'mbbs-planner-fixes-{os.getpid()}'
    snapshot=art/'test'
    archive=subprocess.run(['git','archive','HEAD','server/test'],cwd=REPO,capture_output=True,check=True).stdout
    tar=art/'test.tar';tar.write_bytes(archive)
    with tarfile.open(tar) as t:t.extractall(art/'tree',filter='data')
    tar.unlink();os.rename(art/'tree/server/test',snapshot);subprocess.run(['rm','-rf','--',str(art/'tree')],check=True)
    override=art/'compose.json'
    artifact={'type':'bind','source':str(art),'target':'/app/test-artifacts'}
    disposable={'com.mbbs.lifecycle':'disposable-test'}
    migrations={'type':'bind','source':str(OUT/'live-before/migrations'),'target':'/app/migrations','read_only':True}
    tests={'type':'bind','source':str(snapshot),'target':'/app/test','read_only':True}
    override.write_text(json.dumps({'services':{
      'migrate':{'volumes':[migrations,artifact],'labels':disposable},
      'test':{'volumes':[migrations,artifact,tests],'labels':disposable},
      'db':{'labels':disposable}}}))
    compose=['docker','compose','-p',project,'-f',str(REPO/'docker-compose.mbt-test.yml'),'-f',str(override)]
    browsers=[]
    def step(*args):
        result=subprocess.run([*compose,*args],capture_output=True,text=True)
        assert result.returncode==0,(args,(result.stdout+result.stderr)[-3000:])
    def run(tree,command,timeout=5400):
        mounts=[]
        for name in ['src','public']:mounts+=['-v',f'{tree/name}:/app/{name}:ro']
        return subprocess.run([*compose,'run','--rm','--no-deps','-T',*mounts,'test','sh','-c',command],
          capture_output=True,text=True,timeout=timeout)
    def browser_run(label,tree,command):
        name=f'{project}-browser-{label}';browsers.append(name)
        cmd=['docker','run','--rm','--name',name,'--init','--cgroup-parent=mbbs-tests.slice',
          '--memory=2g','--memory-swap=2g','--pids-limit=512','--cpus=2','--label','com.mbbs.lifecycle=disposable-test',
          '--network','none','--read-only','--tmpfs','/tmp:rw,size=512m,mode=1777','--tmpfs','/dev/shm:rw,size=256m,mode=1777',
          '-e','HOME=/tmp','-e','XDG_CONFIG_HOME=/tmp/cfg','-e','XDG_CACHE_HOME=/tmp/cache','-e','PLAYWRIGHT_BROWSERS_PATH=/ms-playwright',
          '-v',f'{tree/"src"}:/app/src:ro','-v',f'{tree/"public"}:/app/public:ro','-v',f'{snapshot}:/app/test:ro',
          '--entrypoint','sh','mbbs-mbt-p1-test-e2e:latest','-c',command]
        try:return subprocess.run(cmd,capture_output=True,text=True,timeout=3600)
        finally:subprocess.run(['docker','rm','-f',name],capture_output=True)
    runs={}
    def record(key,result):
        runs[key]={'exit':result.returncode,'stderrTail':result.stderr[-1500:],'stdoutTail':result.stdout[-800:]}
        save(OUT/'validation-runs.json',runs)
    results={}
    try:
        node,browser_target=commit_tests();regression,browser=regression_tests(snapshot)
        missing=[t for t in [*node,*browser_target] if not (snapshot/t.removeprefix('test/')).is_file()]
        assert not missing,('Target tests missing from HEAD snapshot',missing)
        regression=[t for t in regression if t not in node];browser_all=sorted(set(browser_target)|set(browser))
        if os.environ.get('PLANNER_SUITE')=='target': regression,browser_all=regression[:3],browser_target
        node_cmd=lambda files:'node --test --test-concurrency=1 --test-timeout=600000 --test-reporter=tap '+' '.join(files)
        # A hung browser file must not stall the run: per-test timeout, hard per-file limit; a hang counts as that tree's failure.
        browser_cmd=' ; '.join(f'echo "# FILE {b}"; timeout -k 10 300 node --test --test-timeout=180000 --test-reporter=tap {b}; echo "# EXIT $?"' for b in browser_all)+' ; true'
        for label,tree in [('live',OUT/'live-before'),('candidate',OUT/'candidate')]:
            subprocess.run([*compose,'down','--volumes','--remove-orphans'],capture_output=True)
            step('up','-d','--wait','db');step('run','--rm','--no-deps','-T','migrate')
            target=run(tree,node_cmd(node));record(f'{label}-target',target)
            wide=run(tree,node_cmd(regression));record(f'{label}-regression',wide)
            web=browser_run(label,tree,browser_cmd);record(f'{label}-browser',web)
            per_file=collections.defaultdict(str);current=None
            for line in web.stdout.splitlines(True):
                match=re.match(r'# FILE (\S+)',line)
                if match: current=match[1]
                elif current: per_file[current]+=line
            results[label]={'target':tap(target.stdout),'node':tap(wide.stdout),'browser':{f:tap(text) for f,text in per_file.items()}}
        return node,browser_target,regression,results
    finally:
        for name in browsers: subprocess.run(['docker','rm','-f',name],capture_output=True)
        subprocess.run([*compose,'down','--volumes','--remove-orphans'],capture_output=True)
        assert not subprocess.check_output(['docker','ps','-aq','--filter',f'name={project}-browser-'],text=True).strip(),'browser test container remains'
        for kind in ['ps','volume','network']:
            args=['docker',kind,*(['-a'] if kind=='ps' else ['ls']),'-q','--filter',f'label=com.docker.compose.project={project}']
            assert not subprocess.check_output(args,text=True).strip(),f'{project} {kind} remains after teardown'

def validate():
    if not os.environ.get('MBBS_TEST_ARTIFACT_DIR'):
        raise SystemExit(subprocess.run([sys.executable,str(REPO/'docker/retention/retention.py'),'run','--',sys.executable,__file__,'validate']).returncode)
    signal.signal(signal.SIGTERM,lambda *_:sys.exit(143))
    prepared=base['ensure_sources']();art=Path(os.environ['MBBS_TEST_ARTIFACT_DIR']);os.chmod(art,0o777)
    subprocess.run(['python3','docker/verify-memory-limits.py'],cwd=REPO,check=True,capture_output=True)
    node,browser_target,regression,results=suite(art)
    live,cand=results['live'],results['candidate']
    total=lambda counter:sum(counter.values())
    browser_sum=lambda res,key:sum(total(r[key]) for r in res['browser'].values())
    def file_failed(res,f):
        r=res['browser'].get(f,{'passed':{},'failed':{}});return bool(total(r['failed'])) or not total(r['passed'])
    checks={'targetNodeFiles':node,'targetBrowserFiles':browser_target,'regressionNodeFiles':len(regression),
      'candidateTarget':{'passed':total(cand['target']['passed']),'failed':sorted(cand['target']['failed'])},
      'liveTarget':{'passed':total(live['target']['passed']),'failed':sorted(live['target']['failed'])},
      'candidateTargetBrowser':{f:{'passed':total(cand['browser'].get(f,{}).get('passed',{})),'failed':sorted(cand['browser'].get(f,{}).get('failed',{}))} for f in browser_target},
      'liveTargetBrowserFailedFiles':[f for f in browser_target if file_failed(live,f)],
      'live':{'nodePassed':total(live['node']['passed']),'nodeFailed':total(live['node']['failed']),
              'browserPassed':browser_sum(live,'passed'),'browserFailed':browser_sum(live,'failed')},
      'candidate':{'nodePassed':total(cand['node']['passed']),'nodeFailed':total(cand['node']['failed']),
              'browserPassed':browser_sum(cand,'passed'),'browserFailed':browser_sum(cand,'failed')},
      'newNodeFailures':sorted(n for n,c in cand['node']['failed'].items() if c>live['node']['failed'].get(n,0)),
      'newBrowserFailures':sorted(f'{f}: {n}' for f,r in cand['browser'].items() for n,c in r['failed'].items() if c>live['browser'].get(f,{}).get('failed',{}).get(n,0)),
      'browserFilesShrunk':sorted(f for f,r in live['browser'].items()
        if total(cand['browser'].get(f,{}).get('passed',{}))+total(cand['browser'].get(f,{}).get('failed',{}))<total(r['passed'])+total(r['failed'])),
      'preexistingNodeFailures':sorted(n for n in cand['node']['failed'] if live['node']['failed'].get(n)),
      'preexistingBrowserFailures':sorted(f'{f}: {n}' for f,r in cand['browser'].items() for n in r['failed'] if live['browser'].get(f,{}).get('failed',{}).get(n))}
    live_total=checks['live']['nodePassed']+checks['live']['nodeFailed'];cand_total=checks['candidate']['nodePassed']+checks['candidate']['nodeFailed']
    checks['liveTargetFailureCount']=len(checks['liveTarget']['failed'])+len(checks['liveTargetBrowserFailedFiles'])
    save(OUT/'validation-checks.json',checks)
    if os.environ.get('PLANNER_SUITE'):
        # Smoke run of the mechanics only: never records a validation.
        print(json.dumps({'smoke':True,'live':checks['live'],'candidate':checks['candidate'],'candidateTarget':checks['candidateTarget'],
          'liveTarget':checks['liveTarget'],'candidateTargetBrowser':checks['candidateTargetBrowser'],'liveTargetBrowserFailedFiles':checks['liveTargetBrowserFailedFiles']}))
        return
    ok=(checks['candidateTarget']['passed']>0 and not checks['candidateTarget']['failed']
        and checks['candidateTarget']['passed']>=checks['liveTarget']['passed']+len(checks['liveTarget']['failed'])
        and all(v['passed'] and not v['failed'] for v in checks['candidateTargetBrowser'].values())
        and checks['liveTargetFailureCount']>0 and not checks['newNodeFailures'] and not checks['newBrowserFailures'] and not checks['browserFilesShrunk']
        and cand_total>=live_total and checks['candidate']['browserPassed']+checks['candidate']['browserFailed']>=checks['live']['browserPassed']+checks['live']['browserFailed'])
    assert ok,('Validation failed',json.dumps(checks,indent=1)[-6000:])
    leftovers=subprocess.check_output(['docker','ps','-aq','--filter','name=mbbs-planner-fixes-'],text=True).strip()
    assert not leftovers,'Disposable test containers remain'
    assert base['ensure_sources']()==prepared,'Candidate changed during validation'
    save(OUT/'validation.json',{'passed':True,'sourceHashes':prepared['sourceHashes'],
      'baseImageId':json.loads((OUT/'capture.json').read_text())['app']['imageId'],'checks':checks,'cleanupVerified':True})
    print(json.dumps({'validation':'passed','live':checks['live'],'candidate':checks['candidate'],
      'candidateTarget':checks['candidateTarget']['passed'],'liveTargetFailures':checks['liveTargetFailureCount'],
      'preexistingNodeFailures':len(checks['preexistingNodeFailures']),'preexistingBrowserFailures':len(checks['preexistingBrowserFailures'])}))

def get(url):
    with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0','Cache-Control':'no-cache'}),timeout=20) as response:
        return response.status,response.read()

def verify():
    prepared=base['ensure_sources']()
    for name,expected in prepared['sourceHashes'].items():
        assert base['docker']('exec',APP,'sha256sum','/app/'+name).split()[0]==expected,name
    assert base['health'](),'Application is not healthy'
    checks=[]
    for path in ['/dispatch/planning','/sales/planning','/mbt/planning']:
        status,body=get('http://127.0.0.1:3000'+path)
        assert status==200 and b'/dispatch.js?v=20261031-'+TAG.encode() in body,path
        checks.append({'path':path,'status':status})
    status,body=get('http://127.0.0.1:3000/dispatch.js?v=20261031-'+TAG)
    assert status==200 and body==(OUT/'candidate/public/dispatch.js').read_bytes(),'dispatch.js'
    checks.append({'path':'/dispatch.js?v=20261031-'+TAG,'status':status})
    for path in ['/api/dispatch/plan-edit-lease','/api/dispatch/plans?date=2026-11-03']:
        code=int(subprocess.check_output(['curl','-sS','--max-time','15','-o','/dev/null','-w','%{http_code}','http://127.0.0.1:3000'+path],text=True))
        assert code==401,f'{path}: {code}'
        checks.append({'path':path,'status':code})
    save(OUT/'live-verification.json',{'healthy':True,'sourceHashesVerified':True,'http':checks})
    print(json.dumps({'liveVerification':'passed','files':len(FILES),'httpChecks':len(checks)}))
base['verify']=verify

if __name__=='__main__':
    {'prepare':prepare,'validate':validate,'build':base['build'],'deploy':sor['deploy'],'verify':verify}[sys.argv[1]]()
