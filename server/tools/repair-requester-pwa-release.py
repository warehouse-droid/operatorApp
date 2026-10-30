#!/usr/bin/env python3
"""Release scoped requester PWA, camera, equipment search and opening performance changes."""
import difflib,hashlib,json,os,re,runpy,subprocess,sys,urllib.error,urllib.request
from pathlib import Path
release=runpy.run_path(str(Path(__file__).with_name('bin-final-collection-release.py')))
base,scope=release['base'],release['scope']
OUT=scope['SERVER']/'deployments/repair-requester-pwa-20261028'
NEW=['public/repair/equipment-picker.js','public/repair/requester-camera.js','public/repair/requester-pwa-view.js','public/repair/requester-pwa.js','public/repair/requester-pwa.css']
FILES=json.loads((OUT/'scope-files.json').read_text())+[f for f in NEW if (scope['SERVER']/f).exists()]
scope.update(OUT=OUT,FILES=FILES,IMAGE='mbbs-operator-app:repair-requester-pwa-20261028',ROLLBACK='mbbs-operator-app:repair-requester-pwa-rollback-20261028')
def apply_migration():return {'required':False}
scope['apply_migration']=apply_migration
def prepare():
 release['prepare']();prepared=json.loads((OUT/'prepared.json').read_text())
 resolved=[]
 # Concurrent releases can change the same asset URL. Keep the merged source
 # and resolve only a single HTML/script cache reference to this generation.
 allowed={'public/service-worker.js':'operator','public/driver-service-worker.js':'driver','public/driver.html':'driver'}
 for name in prepared['conflicts']:
  assert name in allowed,('Review source conflict',name)
  path=OUT/'candidate'/name;source=path.read_text();role=allowed[name]
  def resolve(match):
   current,updated=match.group(1),match.group(2)
   assert len(current.splitlines())==len(updated.splitlines())==1
   assert '/'+role+'.js?v=' in current and '/'+role+'.js?v=20261028-repair-pwa' in updated
   resolved.append(name);return updated
  source=re.sub(r'^<<<<<<<[^\n]*\n(.*?)^=======\n(.*?)^>>>>>>>[^\n]*\n',resolve,source,flags=re.M|re.S);assert '<<<<<<<' not in source;path.write_text(source)
 worker=OUT/'candidate/public/driver-service-worker.js';live=(OUT/'live-before/public/driver-service-worker.js').read_text();generation=int(re.search(r'DRIVER_CACHE_NAME = `\$\{DRIVER_CACHE_PREFIX\}v(\d+)`',live).group(1))+1
 source=worker.read_text();source=re.sub(r'(?<=DRIVER_CACHE_PREFIX\})v\d+',f'v{generation}',source);source=re.sub(r'(?<=DRIVER_CACHE_PREFIX\})refresh-v\d+',f'refresh-v{generation}',source);worker.write_text(source)
 patch=[]
 for name in FILES:
  path=OUT/'candidate'/name;before=OUT/'live-before'/name
  patch.extend(difflib.unified_diff(before.read_text().splitlines(True) if before.exists() else [],path.read_text().splitlines(True),fromfile='live/'+name,tofile='candidate/'+name))
 prepared.update(conflicts=[],sourceHashes={name:base['sha'](OUT/'candidate'/name) for name in FILES},cacheReferencesResolved=resolved,driverCacheGeneration=generation);base['save'](OUT/'prepared.json',prepared);(OUT/'release.patch').write_text(''.join(patch))
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
 env=dict(os.environ,REPAIR_TEST_RUNTIME=str(OUT/'candidate'),REPAIR_TEST_DIFF=str(OUT/'release.patch'))
 with log.open('w') as output:result=subprocess.run(['bash','docker/run-repair-tests.sh','--source','node','tools/repair-requester-pwa-checks.mjs'],cwd=scope['SERVER'].parent,env=env,stdout=output,stderr=subprocess.STDOUT)
 content=log.read_text();checks=[]
 for line in content.splitlines():
  try:value=json.loads(line)
  except ValueError:continue
  if isinstance(value,dict):checks.append(value);print(json.dumps(value),flush=True)
 if result.returncode:print(content[-20000:])
 assert result.returncode==0,'Candidate validation failed';assert base['ensure_sources']()==prepared
 base['save'](OUT/'validation.json',{'passed':True,'sourceHashes':prepared['sourceHashes'],'checks':checks,'cleanupVerified':True})
def verify():
 prepared=base['ensure_sources']()
 for name,expected in prepared['sourceHashes'].items():assert base['docker']('exec',base['APP'],'sha256sum','/app/'+name).split()[0]==expected,name
 assert base['health']();checks=[]
 pages={'/repair/':'public/repair/index.html','/repair/workshop':'public/repair/index.html','/operator/repair':'public/repair/requester.html','/driver/repair':'public/repair/requester.html','/operator':'public/operator.html','/driver':'public/driver.html'}
 for origin in ['http://127.0.0.1:3000','https://test.mbbsoperation.com']:
  for path in ['/repair/','/repair/workshop','/repair/requester.html','/operator/repair','/driver/repair','/operator','/driver','/repair/app.js?v=20261028-requester-pwa','/repair/requester-pwa.js?v=20261028-requester-pwa','/repair/requester-pwa.css?v=20261028-requester-pwa','/repair/requester-camera.js?v=20261028-requester-pwa','/api/repair/availability']:
   with urllib.request.urlopen(urllib.request.Request(origin+path,headers={'User-Agent':'Mozilla/5.0','Cache-Control':'no-cache'}),timeout=20) as response:
    content=response.read();assert response.status==200
    if path.endswith('/availability'):assert json.loads(content)['enabled'] is True
    else:
     file=pages.get(path,'public'+path.split('?')[0])
     if file.endswith('.html'):content=re.sub(rb'<script\b[^>]*\bsrc=["\x27]https://static\.cloudflareinsights\.com/beacon\.min\.js/[^"\x27]+["\x27][^>]*>\s*</script>\r?\n?',b'',content)
     assert hashlib.sha256(content).hexdigest()==prepared['sourceHashes'][file],origin+path
    checks.append({'url':origin+path,'status':response.status})
  for path in ['/api/repair/incoming-parts','/api/repair/purchases']:
   try:urllib.request.urlopen(urllib.request.Request(origin+path,headers={'User-Agent':'Mozilla/5.0','Cache-Control':'no-cache'}),timeout=20)
   except urllib.error.HTTPError as error:assert error.code==401;checks.append({'url':origin+path,'status':error.code})
   else:raise AssertionError('Unauthenticated purchase access succeeded')
 base['save'](OUT/'live-verification.json',{'sourceHashesVerified':True,'healthy':True,'http':checks});print(json.dumps({'liveVerification':'passed','files':len(FILES),'httpChecks':len(checks)}))
scope['verify']=verify
if __name__=='__main__':{'prepare':prepare,'rebase':rebase,'validate':validate,'build':base['build'],'deploy':base['deploy'],'verify':verify}[sys.argv[1]]()
