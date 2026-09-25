"""Reproduce static delta and targeted manual mutations in disposable containers."""
from collections import Counter
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[1]
ART=ROOT/'test-artifacts/sor-feature-gate'
OUTPUT=ROOT/'test-artifacts/sor-rentals'
BASE=Path('/home/ubuntu/operatorapp-deploy-backups/sor-feature-gate-20260924-v1/baseline')
CANDIDATE=Path('/home/ubuntu/operatorapp-deploy-backups/sor-return-lock-20260924-v1/candidate')
def run(name,command,source=CANDIDATE,extra=None):
 with (ART/(name+'.log')).open('w') as out:
  result=subprocess.run(['bash','tools/sor-rentals-test-env.sh','run','candidate',*command],cwd=ROOT,
   env={**os.environ,'SOR_CANDIDATE_ROOT':str(source),**(extra or {})},stdout=out,stderr=subprocess.STDOUT)
 return result.returncode

def static():
 for name,source in [('baseline',BASE),('final',CANDIDATE)]:
  assert run('static-'+name,['node','tools/sor-feature-gate-static.mjs',name],source)==0
 def lint(mode):return Counter(json.dumps(r,sort_keys=True) for r in json.loads((OUTPUT/('gate-lint-'+mode+'.json')).read_text()))
 def types(mode):
  return Counter(re.sub(r'\(\d+,\d+\)', '',line) for line in (OUTPUT/('gate-types-'+mode+'.log')).read_text().splitlines() if 'error TS' in line)
 new_lint=list((lint('final')-lint('baseline')).elements());new_types=list((types('final')-types('baseline')).elements())
 result={'passed':not new_lint and not new_types,'lintBaseline':sum(lint('baseline').values()),'lintFinal':sum(lint('final').values()),'newLint':new_lint,'newTypes':new_types,'typeBaseline':sum(types('baseline').values()),'typeFinal':sum(types('final').values())}
 (ART/'static.json').write_text(json.dumps(result,indent=2));print(json.dumps(result));assert result['passed']

def mutations():
 source=(CANDIDATE/'src/sor-rental-service.js').read_text()
 variants=[
  ('refresh-under-lock',"return {sourceRef:row.source_ref,version:row.version,result,refs};","await refreshRefs(refs); return {sourceRef:row.source_ref,version:row.version,result,refs};"),
  ('drop-refresh',"await refreshRefs(item.refs);","// incorrectly drop refresh"),
  ('lose-new-version',"DELETE FROM sor_return_reconcile_queue WHERE source_ref=$1 AND version=$2","DELETE FROM sor_return_reconcile_queue WHERE source_ref=$1 AND $2::bigint IS NOT NULL"),
  ('ignore-gate',"if(!await isSorFeatureEnabled()){return {disabled:true,processed:0};}","if(false && !await isSorFeatureEnabled()){return {disabled:true,processed:0};}"),
  ('no-outer-deferral',"if(hasActiveTransaction()) {","if(false && hasActiveTransaction()) {")]
 results=[]
 for name,old,new in variants:
  assert source.count(old)==1,name
  path=ART/'mutants'/name/'src';path.mkdir(parents=True,exist_ok=True)
  (path/'sor-rental-service.js').write_text(source.replace(old,new))
  rc=run('mutant-'+name,['node','--test','--test-concurrency=1','test/dispatch/integration/sor-feature-gate.test.js','test/dispatch/integration/sor-return-lock.test.js'],extra={'SOR_MUTANT_ROOT':str(path.parent)})
  killed=rc!=0 and 'not ok' in (ART/('mutant-'+name+'.log')).read_text()
  results.append({'name':name,'killed':killed})
 result={'passed':all(row['killed'] for row in results),'mutants':results}
 (ART/'mutations.json').write_text(json.dumps(result,indent=2));print(json.dumps(result));assert result['passed']

{'static':static,'mutations':mutations}[sys.argv[1]]()
