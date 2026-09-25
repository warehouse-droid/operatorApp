"""Reproduce scoped tests, baseline comparisons and mutations in isolated Docker."""
from collections import Counter
import difflib
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[1]
RELEASE=Path('/home/ubuntu/operatorapp-deploy-backups/operator-responsiveness-20260924-v1')
ART=ROOT/'test-artifacts/operator-responsiveness';OUT=ROOT/'test-artifacts/sor-rentals'
CANDIDATE=RELEASE/'candidate';BASE=RELEASE/'baseline'
def run(name,args,source=CANDIDATE):
 with (ART/(name+'.log')).open('w') as out:
  result=subprocess.run(['sudo','-n','env','SOR_TEST_DATABASE=mbt_test_quality','SOR_CANDIDATE_ROOT='+str(source),'bash','tools/sor-rentals-test-env.sh','run','candidate',*args],cwd=ROOT,stdout=out,stderr=subprocess.STDOUT)
 print(json.dumps({'check':name,'exit':result.returncode}),flush=True)
 return result.returncode

def tests():
 backend=['test/dispatch/integration/sor-return-definition.test.js','test/dispatch/integration/sor-return-lock.test.js','test/dispatch/integration/sor-return-lifecycle.test.js','test/dispatch/integration/sor-feature-gate.test.js','test/dispatch/integration/sor-admin-http.test.js','test/dispatch/integration/sor-rental-repository.test.js','test/dispatch/integration/sor-rental-concurrency.test.js','test/dispatch/integration/sor-signature-evidence.test.js','test/dispatch/unit/sor-rental-policy.test.js','test/mbt/unit/driver-pwa-recovery-assets.test.js','test/mbt/unit/driver-instruction-route-comparison.test.js','test/mbt/unit/operator-direct-orderline-client.test.js','test/mbt/unit/operator-posting-responsiveness.test.js','test/mbt/unit/operator-delivery-refresh.test.js']
 assert run('focused-final',['node_modules/.bin/c8','--all=false','--check-coverage=false','--include=src/sor-rental-service.js','--include=src/dispatch-delivery-group-repository.js','--temp-directory=/tmp/responsiveness-c8','--report-dir=test-artifacts/sor-rentals/responsiveness-coverage','--reporter=json','--reporter=text','node','--test','--test-concurrency=1',*backend])==0
 assert run('browser-final',['env','DISPLAY_FIX_COVERAGE=1','DISPLAY_FIX_ARTIFACTS=test-artifacts/sor-rentals/responsiveness-browser','node','--test','test/mbt/e2e/operator-delivery-refresh.test.js'])==0
 # Existing global-order suite is compared against the unchanged live image.
 args=['node','--test','--test-concurrency=1','test/dispatch/integration/dispatch-global-derived-order-pool.red.test.js']
 run('global-baseline',args,BASE);run('global-final',args)
 failures=lambda label:re.findall(r'^not ok \d+ - (.+)$',(ART/(label+'.log')).read_text(),re.M)
 assert failures('global-final')==failures('global-baseline')
 (ART/'tests.json').write_text(json.dumps({'passed':True,'globalBaselineFailures':failures('global-baseline'),'focusedTests':backend},indent=2))

def static():
 for label,source in [('baseline',BASE),('final',CANDIDATE)]:assert run('static-'+label,['node','tools/operator-responsiveness-static.mjs',label],source)==0
 lint=lambda label:Counter(json.dumps(row,sort_keys=True) for row in json.loads((OUT/f'responsiveness-lint-{label}.json').read_text()))
 types=lambda label:Counter(re.sub(r'\(\d+,\d+\)','',line) for line in (OUT/f'responsiveness-types-{label}.log').read_text().splitlines() if 'error TS' in line)
 result={'newLint':list((lint('final')-lint('baseline')).elements()),'newTypes':list((types('final')-types('baseline')).elements()),'lintBaseline':sum(lint('baseline').values()),'lintFinal':sum(lint('final').values()),'typesBaseline':sum(types('baseline').values()),'typesFinal':sum(types('final').values())}
 result['passed']=not result['newLint'] and not result['newTypes'];(ART/'static.json').write_text(json.dumps(result,indent=2));print(json.dumps(result));assert result['passed']

def mutations():
 browser='test/mbt/e2e/operator-delivery-refresh.test.js';definition='test/dispatch/integration/sor-return-definition.test.js'
 variants=[
  ('missing-packed-scope','public/operator.js','  deliveryOrderBucketScopes.packed = scope;','  // lost scope',['node','--test','--test-name-pattern=P1',browser]),
  ('wrong-yard-packed-cache','public/operator.js','const packed = deliveryOrderBucketScopes.packed === scope ? deliveryOrderBuckets.packed : [];','const packed = deliveryOrderBuckets.packed;',['node','--test','--test-name-pattern=P2',browser]),
  ('missed-posting-wakeup','public/operator.js','for (const wake of operatorPostingPollWakeups.get(jobId) || []) { wake(); }','for (const wake of []) { wake(); }',['node','--test','--test-name-pattern=P5',browser]),
  ('return-treated-as-source-split','src/sor-rental-service.js'," AND order_type='SO'\n      AND split_ref ~ '^SOR[0-9]+-S[0-9]+$'",'', ['node','--test','--test-name-pattern=mislabelled',definition]),
  ('return-projected-as-split','src/dispatch-delivery-group-repository.js','  if (order.orderKind === "sor_rental_return") { return "derived"; }','',['node','--test','--test-name-pattern=projection',definition]),
  ('return-inherits-delivery-source','src/dispatch-delivery-group-repository.js',"          AND full_order->>'orderKind' IS DISTINCT FROM 'sor_rental_return'",'', ['node','--test','--test-name-pattern=source.refreshes',definition]),
  ('return-overwritten-by-global','src/dispatch-delivery-group-repository.js','      if (order.orderKind === "sor_rental_return") { return order; }','', ['node','--test','--test-name-pattern=obsolete',definition]),
  ('packed-error-hidden','public/operator.js','return await setOrderStatus("packed");','return setOrderStatus("packed");',['node','--test','--test-name-pattern=P3',browser])]
 results=[]
 for name,file,old,new,args in variants:
  mutant=ART/'mutants'/name
  if mutant.exists():shutil.rmtree(mutant)
  shutil.copytree(CANDIDATE,mutant)
  path=mutant/file;source=path.read_text();assert source.count(old)==1;path.write_text(source.replace(old,new))
  status=run('mutant-'+name,args,mutant);killed=status!=0 and 'not ok' in (ART/('mutant-'+name+'.log')).read_text()
  results.append({'name':name,'killed':killed});assert killed,name
 (ART/'mutations.json').write_text(json.dumps({'passed':True,'results':results},indent=2))

def report():
 results={name:json.loads((ART/(name+'.json')).read_text()) for name in ['tests','static','mutations']}
 assert all(row['passed'] for row in results.values())
 coverage=json.loads((OUT/'responsiveness-changed-coverage.json').read_text());assert coverage['covered']==coverage['total'] and coverage['total']>0
 results['coverage']=coverage
 state=json.loads((RELEASE/'manifest.json').read_text());hashes={f:hashlib.sha256((CANDIDATE/f).read_bytes()).hexdigest() for f in state['after']};assert hashes==state['after']
 result={'passed':True,'sourceHashes':hashes,**results};(ART/'checks.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))

def coverage():
 changed={}
 for file in ['public/operator.js','src/sor-rental-service.js','src/dispatch-delivery-group-repository.js']:
  before=(BASE/file).read_text().splitlines();after=(CANDIDATE/file).read_text().splitlines()
  lines=[]
  for kind,_,_,start,end in difflib.SequenceMatcher(a=[line.strip() for line in before],b=[line.strip() for line in after],autojunk=False).get_opcodes():
   if kind not in ['replace','insert']:continue
   lines.extend(index+1 for index in range(start,end) if after[index].strip() and not re.match(r'^\s*(//|/\*|\*|[{}();,]+\s*$)',after[index]))
  changed[file]=lines
 (OUT/'responsiveness-changed-lines.json').write_text(json.dumps(changed,indent=2))
 assert run('coverage',['node','tools/operator-responsiveness-coverage.mjs'])==0

if __name__=='__main__':{'tests':tests,'static':static,'mutations':mutations,'coverage':coverage,'report':report}[sys.argv[1]]()
