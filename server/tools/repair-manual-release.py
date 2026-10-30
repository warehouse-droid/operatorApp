#!/usr/bin/env python3
"""Release local Repair workflow, Office actual labour and separate manual financial documents."""
import difflib,hashlib,json,os,re,runpy,subprocess,sys,urllib.error,urllib.request
from pathlib import Path
release=runpy.run_path(str(Path(__file__).with_name('bin-final-collection-release.py')))
base,scope=release['base'],release['scope']
OUT=scope['SERVER']/'deployments/repair-flow-manual-20261029'
NEW=['src/repair/locking.js','src/repair/manual-posting.js','src/repair/pdf-theme.js','public/repair/manual-posting.js','public/repair/local-parts.js']
FILES=[f for f in json.loads((OUT/'scope-files.json').read_text()) if f!='src/netsuite.js']+[f for f in NEW if (scope['SERVER']/f).exists()]
scope.update(OUT=OUT,FILES=FILES,IMAGE='mbbs-operator-app:repair-flow-manual-20261029',ROLLBACK='mbbs-operator-app:repair-flow-manual-rollback-20261029')
def apply_migration():return {'required':False}
scope['apply_migration']=apply_migration
def prepare():
 release['prepare']();prepared=json.loads((OUT/'prepared.json').read_text())
 # Only the Repair loader generation changes in this shared HTML file.
 name='public/control.html';before=(OUT/'workspace-before'/name).read_bytes();live=(OUT/'live-before'/name).read_bytes()
 after=before.replace(b'20261029-whole-quote',b'20261029-manual-flow')
 (OUT/'candidate'/name).write_bytes(base['merge'](live,before,after,name,'repair-manual-control'))
 prepared['sourceHashes'][name]=base['sha'](OUT/'candidate'/name)
 patch=[]
 for file in FILES:
  live=(OUT/'live-before'/file).read_text() if (OUT/'live-before'/file).exists() else ''
  patch.extend(difflib.unified_diff(live.splitlines(True),(OUT/'candidate'/file).read_text().splitlines(True),fromfile='live/'+file,tofile='candidate/'+file))
 (OUT/'release.patch').write_text(''.join(patch));base['save'](OUT/'prepared.json',prepared)
 assert not prepared['conflicts'],prepared['conflicts']
 for folder in ['candidate','live-before']:
  for path in [OUT/folder,*(OUT/folder).rglob('*')]:path.chmod(0o755 if path.is_dir() else 0o644)
def rebase():
 base['ensure_sources']();generation=len(list(OUT.glob('capture-*.json')))+1
 (OUT/'live-before').rename(OUT/f'live-before-{generation}');(OUT/'capture.json').rename(OUT/f'capture-{generation}.json');prepare()
def validate():
 if not os.environ.get('MBBS_TEST_ARTIFACT_DIR'):
  subprocess.run(['sudo','-n','python3',str(scope['SERVER'].parent/'docker/retention/retention.py'),'run','--root','/tmp','--',sys.executable,__file__,'validate'],check=True);return
 prepared=base['ensure_sources']();log=Path(os.environ['MBBS_TEST_ARTIFACT_DIR'])/'validation.log'
 env=dict(os.environ,REPAIR_TEST_IMAGE='mbbs-repair-test-pdf:20261029',REPAIR_TEST_RUNTIME=str(OUT/'candidate'),REPAIR_TEST_DIFF=str(OUT/'release.patch'))
 with log.open('w') as output:result=subprocess.run(['bash','docker/run-repair-tests.sh','--source','node','tools/repair-manual-checks.mjs'],cwd=scope['SERVER'].parent,env=env,stdout=output,stderr=subprocess.STDOUT)
 content=log.read_text();checks=[]
 for line in content.splitlines():
  try:value=json.loads(line)
  except ValueError:continue
  if isinstance(value,dict):checks.append(value);print(json.dumps(value),flush=True)
 if result.returncode:
  errors=list(dict.fromkeys(line[:1200] for line in content.splitlines() if line.startswith(('Error:','TypeError:','AssertionError:','RangeError:'))))[-8:]
  base['save'](OUT/'validation-failure.json',{'passed':False,'errors':errors,'lastCheck':checks[-1:]});print(json.dumps({'validationErrors':errors}))
  raise AssertionError('Candidate validation failed: '+json.dumps(errors))
 assert base['ensure_sources']()==prepared
 base['save'](OUT/'validation.json',{'passed':True,'sourceHashes':prepared['sourceHashes'],'checks':checks,'cleanupVerified':True})
def verify():
 prepared=base['ensure_sources']()
 for name,expected in prepared['sourceHashes'].items():assert base['docker']('exec',base['APP'],'sha256sum','/app/'+name).split()[0]==expected,name
 assert base['health']();checks=[]
 pages={'/repair/':'public/repair/index.html','/repair/workshop':'public/repair/index.html','/control':'public/control.html'}
 for origin in ['http://127.0.0.1:3000','https://test.mbbsoperation.com']:
  for path in ['/repair/','/repair/workshop','/control','/control.html','/repair/approval-panel.js?v=20261029-manual-flow','/repair/approval-panel.css?v=20261029-manual-flow','/repair/job-parts.js?v=20261029-manual-flow','/repair/app.js?v=20261029-manual-flow','/repair/workshop.js?v=20261029-manual-flow','/repair/workshop-view.js?v=20261029-manual-flow','/repair/public-quote.js?v=20261029-manual-flow','/repair/domain.js?v=20261029-manual-flow','/repair/manual-posting.js?v=20261029-manual-flow','/repair/local-parts.js?v=20261029-manual-flow','/repair/repair.css?v=20261029-manual-flow','/api/repair/availability']:
   with urllib.request.urlopen(urllib.request.Request(origin+path,headers={'User-Agent':'Mozilla/5.0','Cache-Control':'no-cache'}),timeout=20) as response:
    content=response.read();assert response.status==200
    if path.endswith('/availability'):assert json.loads(content)['enabled'] is True
    else:
     file=pages.get(path,'public'+path.split('?')[0])
     if file.endswith('.html'):content=re.sub(rb'<script\b[^>]*\bsrc=["\x27]https://static\.cloudflareinsights\.com/beacon\.min\.js/[^"\x27]+["\x27][^>]*>\s*</script>\r?\n?',b'',content)
     assert hashlib.sha256(content).hexdigest()==prepared['sourceHashes'][file],origin+path
    checks.append({'url':origin+path,'status':response.status})
  for path in ['/api/repair/approvals','/api/repair/purchases','/api/repair/jobs/539a8eb5-8cef-4ad4-bccd-69043120da53/posting-status']:
   try:urllib.request.urlopen(urllib.request.Request(origin+path,headers={'User-Agent':'Mozilla/5.0','Cache-Control':'no-cache'}),timeout=20)
   except urllib.error.HTTPError as error:assert error.code==401;checks.append({'url':origin+path,'status':error.code})
   else:raise AssertionError('Unauthenticated purchase access succeeded')
 base['save'](OUT/'live-verification.json',{'sourceHashesVerified':True,'healthy':True,'http':checks});print(json.dumps({'liveVerification':'passed','files':len(FILES),'httpChecks':len(checks)}))
scope['verify']=verify
if __name__=='__main__':{'prepare':prepare,'rebase':rebase,'validate':validate,'build':base['build'],'deploy':base['deploy'],'verify':verify}[sys.argv[1]]()
