"""Bounded disposable regression checks for delivery header recovery."""
import importlib.util
import difflib
import random
import json
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time
SERVER=Path(__file__).resolve().parents[2]
ROOT=SERVER.parent
spec=importlib.util.spec_from_file_location('prior', SERVER/'tools/special-removal-lock-20261016/run.py')
base=importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
OUT=base.OUT=SERVER/'test-artifacts/special-delivery-recovery-20261016'
RELEASE=base.RELEASE=SERVER/'deployments/special-delivery-recovery-20261016'
PROJECT=base.PROJECT='mbbs-special-delivery-recovery-20261016'
FILES=base.FILES=['src/special-stock-rest-orders.js','src/special-stock-fulfillment-adapter.js','src/special-stock-fulfillment.js','src/special-stock-request-repository.js','public/special-stock-fulfillment.js','public/sales-special-stock-requests.js','src/special-stock-closure-adapter.js','src/special-stock-closure-service.js','public/special-stock-case-status.js']
UNIT='test/mbt/unit/special-fulfillment-adapter.test.js'
DB='test/mbt/integration/special-approval-fulfillment.test.js'
BROWSER='test/mbt/integration/special-approval-browser.test.js'
save=base.save
core=base.core

def check(mode):
 source=RELEASE/('before' if mode in ('red','closure-red','http-red') else 'candidate')
 runout=OUT/mode
 if runout.exists():
  archive=OUT/'attempts'/(mode+'-'+str(time.time_ns()))
  archive.parent.mkdir(exist_ok=True)
  shutil.move(runout,archive)
 runout.mkdir()
 labels={'com.mbbs.lifecycle':'disposable-test','com.mbbs.task':PROJECT}
 mounts=[f'{source/p}:/app/{p}:ro' for p in ['src','public','migrations','package.json','netsuite-smart-scm-picking-ticket-restlet.js']]
 mounts += [f'{SERVER/p}:/app/{p}:ro' for p in ['test','tools','contracts']]
 mounts += [f'{SERVER/"test-artifacts/driver-upload-reliability/toolchain/node_modules"}:/app/node_modules:ro']
 service={'image':'mbbs-to-yard-test-browser:20261009','pull_policy':'never','working_dir':'/app','user':'1000:1000','labels':labels,'volumes':mounts,
  'environment':{'DATABASE_URL':'postgres://mbt_test:mbt_test_password@db:5432/mbt_test','PLAYWRIGHT_BROWSERS_PATH':'/ms-playwright','XDG_CONFIG_HOME':'/tmp/recovery-config','XDG_CACHE_HOME':'/tmp/recovery-cache',
   'SPECIAL_BROWSER_ARTIFACTS':f'test-artifacts/special-delivery-recovery-20261016/{mode}/browser'}}
 config=runout/'compose.json'
 save(config,{'services':{'db':{'labels':labels},'test':service,'migrate':service}})
 compose=['docker','compose','--project-name',PROJECT,'--project-directory',str(ROOT),'-f',str(ROOT/'docker-compose.mbt-test.yml'),'-f',str(config)]
 results={}
 def run(label,args,expected=0):
  with (runout/(label+'.log')).open('w') as log:
   result=subprocess.run(args,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT)
  results[label]=result.returncode
  print(json.dumps({'check':label,'exit':result.returncode}),flush=True)
  if result.returncode!=expected: print((runout/(label+'.log')).read_text()[-5500:],flush=True)
  assert result.returncode==expected,label+' failed'
 def node(label,args,expected=0,extra=()):
  run(label,compose+['run','--rm','--no-deps','-T',*extra,'test','node',*args],expected)
 try:
  run('resource-policy',['python3','docker/verify-memory-limits.py'])
  run('db',compose+['up','-d','--wait','--wait-timeout','45','--no-build','--pull','never','db'])
  run('migrate',compose+['run','--rm','--no-deps','-T','migrate'])
  if mode=='http-red':
   node('red-http',['--test','--test-name-pattern=delivery recovery HTTP','test/mbt/integration/special-workflow-pricing-http.test.js'],1)
  elif mode=='closure-red':
   node('red-closure-unit',['--test','--test-name-pattern=remaining-order closure','test/mbt/unit/special-workflow-closure.test.js','test/mbt/unit/special-workflow-closure-lock.test.js'],1)
   node('red-closure-db',['--test','--test-name-pattern=readiness reminder stays|changed linked orders close','test/mbt/integration/special-workflow-closure.test.js'],1)
   node('baseline-browser',['--test','--test-name-pattern=approved PO exposes shared reference',BROWSER],1)
  elif mode=='red':
   node('red-unit',['--test','--test-name-pattern=native order discount|only one matching header discount',UNIT],1)
   node('red-db',['--test','--test-name-pattern=preparation failure releases|discarding an unapplied|saved remote delivery plans cannot|replacement pickup after|failed legacy pickup',DB],1)
   node('red-browser',['--test','--test-name-pattern=delivery recovery',BROWSER],1)
  else:
   includes=['--include='+name for name in FILES]
   tests=[UNIT,DB,'test/mbt/unit/special-workflow-rest-orders.test.js','test/mbt/integration/special-local-adjustments.test.js','test/mbt/unit/special-workflow-closure.test.js','test/mbt/unit/special-workflow-closure-lock.test.js','test/mbt/unit/special-linked-closure.test.js','test/mbt/integration/special-workflow-closure.test.js','test/mbt/integration/special-local-closure.test.js']
   node('suite',['node_modules/c8/bin/c8.js',*includes,'--temp-directory=/tmp/recovery-coverage','--report-dir=test-artifacts/special-delivery-recovery-20261016/'+mode+'/coverage','--reporter=json','--reporter=text','node','--test','--test-concurrency=1',*tests],1)
   failures=set(re.findall(r'^not ok \d+ - (.+)$',(runout/'suite.log').read_text(),re.M))
   assert failures=={'all-line removal remains local and completed requests stay locked'},failures
   node('browser',['--test',BROWSER],1)
   browser_failures=set(re.findall(r'^not ok \d+ - (.+)$',(runout/'browser.log').read_text(),re.M))
   assert browser_failures=={'approved PO exposes shared reference form and preserves failed edits'},browser_failures
   node('http',['--test','--test-name-pattern=delivery recovery HTTP|local issued request removal|unprepared delivery failure','test/mbt/integration/special-workflow-pricing-http.test.js'])
   for i,name in enumerate(FILES): node('syntax-'+str(i),['--check',name])
   node('types',['node_modules/typescript/bin/tsc','--allowJs','--checkJs','--noEmit','--skipLibCheck','--module','NodeNext','--moduleResolution','NodeNext','--target','ES2023','--types','node','src/special-stock-rest-orders.js','src/special-stock-fulfillment-adapter.js','public/special-stock-fulfillment.js','src/special-stock-closure-adapter.js'])
   node('lint',['node_modules/eslint/bin/eslint.js','--config','tools/special-local-adjustments-20261013/eslint.config.js','--max-warnings=0',*FILES,*tests,BROWSER,'test/mbt/integration/special-workflow-pricing-http.test.js'])
   node('merge-coverage',['tools/special-delivery-recovery-20261016/coverage.mjs',f'test-artifacts/special-delivery-recovery-20261016/{mode}'])
   changed_coverage(source,runout)
   mutations=[
    ('reject-native-discount','src/special-stock-rest-orders.js','allowHeaderDiscount &&','false &&',UNIT,'only one matching header discount'),
    ('accept-foreign-row','src/special-stock-rest-orders.js','Number(row.item) === 10716 &&','true &&',UNIT,'only one matching header discount'),
    ('relax-financial-reader','src/special-stock-rest-orders.js','allowHeaderDiscount = false','allowHeaderDiscount = true',UNIT,'only one matching header discount'),
    ('keep-failed-lock','src/special-stock-request-repository.js',"status:special.fulfillment_change.plan?'attention':'failed'","status:'attention'",DB,'failed delivery attempts release'),
    ('discard-saved-plan','src/special-stock-request-repository.js','if(change.plan ||','if(false ||',DB,'failed delivery attempts release'),
    ('ignore-closure-activity','src/special-stock-closure-adapter.js','|| (before.executedQuantity ?? 0)!==after.executedQuantity || (before.billedQuantity ?? 0)!==after.billedQuantity','', 'test/mbt/unit/special-workflow-closure.test.js','remaining-order closure refuses any new')]
   mutation_results=[]
   for name,file,old,new,test_file,pattern in mutations:
    original=(source/file).read_text();assert original.count(old)==1,name
    mutant=runout/(name+'.js');mutant.write_text(original.replace(old,new))
    node('property-mutant-'+name,['--test','--test-name-pattern='+pattern,test_file],1,extra=['-v',str(mutant)+':/app/'+file+':ro'])
    log=(runout/('property-mutant-'+name+'.log')).read_text()
    assert re.search(r'^not ok \d+ - (?:property:|.*only one matching)',log,re.M),name+' did not fail a property'
    mutation_results.append({'name':name,'killed':True,'propertyKilled':True})
   save(runout/'mutations.json',mutation_results)
   shuffled=tests.copy();random.Random(631020).shuffle(shuffled)
   node('suite-order',['--test','--test-concurrency=1',*shuffled],1)
   assert set(re.findall(r'^not ok \d+ - (.+)$',(runout/'suite-order.log').read_text(),re.M))==failures
   node('versions',['--input-type=module','-e',"import fs from 'node:fs'; console.log(JSON.stringify({node:process.version,...Object.fromEntries(['fast-check','c8','typescript','eslint','@playwright/test','v8-to-istanbul'].map(n=>[n,JSON.parse(fs.readFileSync('node_modules/'+n+'/package.json')).version]))}))"])
   state=json.loads((RELEASE/'manifest.json').read_text())
   assert core.files_at(source)==state['candidateTree']
   save(runout/'verified.json',{'passed':True,'sourceHashes':state['sourceHashes'],'checks':results,'testHashes':{n:core.sha((SERVER/n).read_bytes()) for n in [*tests,BROWSER,'test/mbt/integration/special-workflow-pricing-http.test.js']},'shuffleSeed':631020})
 finally:
  run('teardown',compose+['--profile','*','down','--volumes','--remove-orphans'])
  (runout/'docker-ps.log').write_text(core.docker('ps','--format','{{.Names}} {{.Status}}').decode())
  (runout/'docker-ps-a.log').write_text(core.docker('ps','-a','--format','{{.Names}} {{.Status}}').decode())
  cleanup={'containers':core.docker('ps','-a','--filter','label=com.mbbs.lifecycle=disposable-test','--format','{{.Names}}').decode().strip(),
   'networks':core.docker('network','ls','--filter','label=com.docker.compose.project='+PROJECT,'--format','{{.Name}}').decode().strip(),
   'volumes':core.docker('volume','ls','--filter','label=com.docker.compose.project='+PROJECT,'--format','{{.Name}}').decode().strip(),
   'productionHealth':core.docker('inspect','--format','{{.State.Health.Status}}',core.APP).decode().strip()}
  save(runout/'cleanup.json',cleanup)
  save(runout/'checks.json',results)
  assert not cleanup['containers'] and not cleanup['networks'] and not cleanup['volumes']
  assert cleanup['productionHealth']=='healthy'

def changed_coverage(source,runout):
 data=json.loads((runout/'coverage/merged.json').read_text())
 covered=[];uncovered=[];branches=[]
 for name in FILES:
  before=(RELEASE/'before'/name).read_text().splitlines()
  after=(source/name).read_text().splitlines();changed=set()
  for tag,_a,_b,c,d in difflib.SequenceMatcher(None,before,after).get_opcodes():
   if tag in ('insert','replace'): changed.update(range(c+1,d+1))
  cov=data['/app/'+name]
  for line in sorted(changed):
   hits=[cov['s'][key] for key,span in cov['statementMap'].items() if span['start']['line']<=line<=span['end']['line']]
   if not hits or not after[line-1].strip() or after[line-1].lstrip().startswith(('/**','*','//')):continue
   (covered if any(hits) else uncovered).append(name+':'+str(line))
  for key,span in cov['branchMap'].items():
   if span.get('line',span['loc']['start']['line']) in changed: branches.append({'file':name,'line':span['loc']['start']['line'],'hits':cov['b'][key]})
 save(runout/'changed-coverage.json',{'covered':covered,'uncovered':uncovered,'branches':branches})
 assert not uncovered,'Untested changed lines: '+str(uncovered)

if __name__=='__main__':
 for sig in [signal.SIGINT,signal.SIGTERM]: signal.signal(sig,lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
 mode=sys.argv[1]
 if mode=='capture': base.capture()
 elif mode=='stage': base.stage()
 elif mode=='rebase': base.rebase()
 else: check(mode)
