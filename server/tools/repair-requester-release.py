#!/usr/bin/env python3
"""Scoped Repair requester, receipt assignment and customer confirmation release."""
import difflib, hashlib, json, os, re, runpy, subprocess, sys, urllib.error, urllib.request
from pathlib import Path
release=runpy.run_path(str(Path(__file__).with_name('bin-final-collection-release.py')))
base,scope=release['base'],release['scope']
OUT=scope['SERVER']/'deployments/repair-requester-page-20261028'
NEW=['src/repair/handover.js','public/repair/equipment-panel.js','public/repair/equipment-panel.css','public/repair/handover.html','public/repair/public-handover.js']
FILES=json.loads((OUT/'scope-files.json').read_text())+[f for f in NEW if (scope['SERVER']/f).exists()]
scope.update(OUT=OUT,FILES=FILES,IMAGE='mbbs-operator-app:repair-requester-page-20261028',ROLLBACK='mbbs-operator-app:repair-requester-rollback-20261028')
scope['apply_migration']=lambda:{'required':False}
def prepare():
 release['prepare']()
 prepared=json.loads((OUT/'prepared.json').read_text())
 if (OUT/'pinned-before').exists():
  for name in FILES:
   live=(OUT/'live-before'/name).read_bytes() if (OUT/'live-before'/name).exists() else b''
   target=OUT/'candidate'/name;target.parent.mkdir(parents=True,exist_ok=True)
   target.write_bytes(base['merge'](live,(OUT/'pinned-before'/name).read_bytes(),(OUT/'pinned-after'/name).read_bytes(),name,'requester-rebase'))
 # These four shell files need only an asset-generation bump and iframe removal.
 # Preserve the live shell's unrelated cache parameters and resources verbatim.
 for name in ['public/operator.html','public/driver.html','public/service-worker.js','public/driver-service-worker.js']:
  content=(OUT/'live-before'/name).read_text()
  content='\n'.join(line for line in content.split('\n') if 'requester-embed.js' not in line)
  content=re.sub(r'(/(?:operator|driver)\.js\?[^"\s]+)',lambda match:match[0]+('' if 'repairRequester=20261028-v1' in match[0] else '&repairRequester=20261028-v1'),content)
  content=re.sub(r'const CACHE_NAME = "mbbs-yard-operator-[^"]+";', 'const CACHE_NAME = "mbbs-yard-operator-20261028-repair-receipts-v1";',content)
  if name=='public/driver-service-worker.js':
   generation=re.search(r'const DRIVER_CACHE_NAME = `\$\{DRIVER_CACHE_PREFIX\}v(\d+)`;',content)
   assert generation,'Review the new Driver cache format before releasing'
   version=int(generation[1]);content=content.replace(f'refresh-v{version}',f'refresh-v{version+1}').replace('}v'+str(version),'}v'+str(version+1))
  (OUT/'candidate'/name).write_text(content)
 prepared['conflicts']=[name for name in FILES if b'<<<<<<< ' in (OUT/'candidate'/name).read_bytes()]
 prepared['sourceHashes']={name:base['sha'](OUT/'candidate'/name) for name in FILES}
 patch=[]
 for name in FILES:
  before=(OUT/'live-before'/name).read_text() if (OUT/'live-before'/name).exists() else ''
  patch.extend(difflib.unified_diff(before.splitlines(True),(OUT/'candidate'/name).read_text().splitlines(True),fromfile='live/'+name,tofile='candidate/'+name))
 (OUT/'release.patch').write_text(''.join(patch));base['save'](OUT/'prepared.json',prepared)
 assert not prepared['conflicts'],prepared['conflicts']
 for folder in ['candidate','live-before']:
  for path in [OUT/folder,*(OUT/folder).rglob('*')]:path.chmod(0o755 if path.is_dir() else 0o644)
def rebase():
 # Freeze the scoped delta before taking another live snapshot. The only source
 # refinement since the previous prepared candidate is the Driver button layout.
 prepared=base['ensure_sources']()
 if not (OUT/'pinned-before').exists():
  for name in FILES:
   before=(OUT/'live-before'/name).read_bytes() if (OUT/'live-before'/name).exists() else b''
   after=(OUT/'candidate'/name).read_bytes()
   if name=='public/driver.js':after=base['merge'](before,(OUT/'workspace-before'/name).read_bytes(),(scope['SERVER']/name).read_bytes(),name,'freeze-driver-layout')
   assert b'<<<<<<< ' not in after,name
   for folder,content in [('pinned-before',before),('pinned-after',after)]:
    target=OUT/folder/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(content)
 generation=len(list(OUT.glob('capture-*.json')))+1
 (OUT/'live-before').rename(OUT/f'live-before-{generation}')
 (OUT/'capture.json').rename(OUT/f'capture-{generation}.json')
 base['save'](OUT/f'rebase-audit-{generation}.json',{'previousSourceHashes':prepared['sourceHashes'],'reason':'Preserve concurrent releases and retain only the frozen Repair delta.'})
 prepare()
def validate():
 if not os.environ.get('MBBS_TEST_ARTIFACT_DIR'):
  subprocess.run(['sudo','-n','python3',str(scope['SERVER'].parent/'docker/retention/retention.py'),'run','--root','/tmp','--',sys.executable,__file__,'validate'],check=True);return
 prepared=base['ensure_sources']();log=Path(os.environ['MBBS_TEST_ARTIFACT_DIR'])/'validation.log'
 env=dict(os.environ,REPAIR_TEST_RUNTIME=str(OUT/'candidate'),REPAIR_TEST_DIFF=str(OUT/'release.patch'))
 with log.open('w') as output:result=subprocess.run(['bash','docker/run-repair-tests.sh','--source','node','tools/repair-requester-checks.mjs'],cwd=scope['SERVER'].parent,env=env,stdout=output,stderr=subprocess.STDOUT)
 content=log.read_text();checks=[]
 for line in content.splitlines():
  try:value=json.loads(line)
  except ValueError:continue
  if isinstance(value,dict):checks.append(value);print(json.dumps(value),flush=True)
 if result.returncode:print(content[-18000:])
 assert result.returncode==0,'Candidate validation failed'
 assert base['ensure_sources']()==prepared
 base['save'](OUT/'validation.json',{'passed':True,'sourceHashes':prepared['sourceHashes'],'checks':checks,'cleanupVerified':True})
def verify():
 prepared=base['ensure_sources']()
 for name,expected in prepared['sourceHashes'].items():assert base['docker']('exec',base['APP'],'sha256sum','/app/'+name).split()[0]==expected,name
 assert base['health']()
 checks=[]
 pages={'/operator':'public/operator.html','/driver':'public/driver.html','/control':'public/control.html','/dispatch':'public/dispatch-menu.html','/repair/':'public/repair/index.html','/repair/workshop':'public/repair/index.html'}
 for origin in ['http://127.0.0.1:3000','https://test.mbbsoperation.com']:
  for path in ['/operator','/driver','/control','/dispatch','/repair/','/repair/workshop','/repair/requester.html','/repair/handover.html','/repair/equipment-panel.js','/api/repair/availability']:
   with urllib.request.urlopen(urllib.request.Request(origin+path,headers={'User-Agent':'Mozilla/5.0','Cache-Control':'no-cache'}),timeout=20) as response:
    content=response.read();assert response.status==200
    if path.endswith('/availability'):assert json.loads(content)['enabled'] is True
    else:
     file=pages.get(path,'public'+path)
     # Cloudflare injects a telemetry-only script into public HTML. Strip only
     # that exact external script; require every application byte to match.
     if file.endswith('.html'):
      content=re.sub(rb'<script\b[^>]*\bsrc=["\x27]https://static\.cloudflareinsights\.com/beacon\.min\.js/[^"\x27]+["\x27][^>]*>\s*</script>\r?\n?',b'',content)
     assert hashlib.sha256(content).hexdigest()==prepared['sourceHashes'][file],origin+path
    checks.append({'url':origin+path,'status':response.status})
  for path,status in [('/api/repair/jobs',401),('/api/repair/receipts',401),('/api/repair/equipment-assignments?scope=control',401),('/api/repair/public/handover',404)]:
   try:urllib.request.urlopen(urllib.request.Request(origin+path,headers={'User-Agent':'Mozilla/5.0','Cache-Control':'no-cache'}),timeout=20)
   except urllib.error.HTTPError as error:assert error.code==status,(path,error.code);checks.append({'url':origin+path,'status':error.code})
   else:raise AssertionError('Unauthenticated access unexpectedly succeeded: '+path)
 base['save'](OUT/'live-verification.json',{'sourceHashesVerified':True,'healthy':True,'http':checks});print(json.dumps({'liveVerification':'passed','files':len(FILES),'httpChecks':len(checks)}))
scope['verify']=verify
if __name__=='__main__':{'prepare':prepare,'rebase':rebase,'validate':validate,'build':base['build'],'deploy':base['deploy'],'verify':verify}[sys.argv[1]]()
