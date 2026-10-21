"""Run isolated regression checks for the captured production UI and candidate."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys

SERVER=Path(__file__).resolve().parents[2]
HERE=Path(__file__).resolve().parent
OUT=Path('/home/ubuntu/operatorapp-investigations/operator-review-navigation-20261003')
TESTS=['test/mbt/unit/receiving-posting-status.test.js','test/mbt/unit/operator-posting-photo-client.test.js',
 'test/mbt/unit/operator-direct-orderline-client.test.js','test/mbt/unit/operator-receiving-return.test.js',
 'test/mbt/unit/operator-background-confirm.test.js','test/mbt/unit/operator-netsuite-posting-service.red.test.js',
 'test/mbt/unit/operator-netsuite-posting-runtime-adapters.red.test.js','test/mbt/unit/operator-receiving-quantity-ui.test.js',
 'test/mbt/property/operator-netsuite-posting.property.test.js','test/mbt/unit/load-followup-posting.test.js']
def command(tree):
 args=['docker','run','--rm','--network','none','-w','/app']
 for src,dst,readonly in [(OUT/tree/'public','/app/public',True),(OUT/tree/'src','/app/src',True),
     (SERVER/'test','/app/test',True),(HERE,'/app/tools/incident',True),
     (SERVER/'tools/receiving-posting-status-browser.mjs','/app/tools/receiving-posting-status-browser.mjs',True),
     (OUT/'checks','/app/test-artifacts',False)]:
  args+=['--mount',f'type=bind,src={src},dst={dst}'+(',readonly' if readonly else '')]
 return args+['--entrypoint','node','mbbs-regular-v2:e2e']
def run(tree,args,name):
 result=subprocess.run(command(tree)+args,text=True,capture_output=True,timeout=240)
 log=result.stdout+result.stderr
 (OUT/(name+'.log')).write_text(log)
 report={'exit':result.returncode,'counts':re.findall(r'^# (?:tests|pass|fail|skipped) .+$',log,re.M),
  'failures':re.findall(r'^not ok .+$',log,re.M)}
 (OUT/(name+'.json')).write_text(json.dumps(report,indent=2))
 print(json.dumps({'check':name,**report}))
 return result.returncode
mode=sys.argv[1]
(OUT/'checks').mkdir(exist_ok=True)
os.chmod(OUT/'checks',0o777)
if mode=='coverage':
 sys.exit(run('candidate',['--experimental-test-coverage','--test','tools/incident/review-rule.test.mjs','tools/incident/units.test.mjs'],'backend-coverage'))
elif mode in ['baseline','candidate']:
 status=run(mode,['--test','--test-concurrency=1',*TESTS],mode+'-regression')
 if mode=='candidate':
  baseline=json.loads((OUT/'baseline-regression.json').read_text())
  actual=json.loads((OUT/'candidate-regression.json').read_text())
  assert actual['failures']==baseline['failures'],'New regression failures'
  assert run(mode,['--test','tools/incident/evidence.test.mjs','tools/incident/ui.test.mjs','tools/incident/som-evidence.test.mjs'],'new-tests')==0
elif mode=='worker-units':
 sys.exit(run('worker-candidate',['--test','tools/incident/units.test.mjs'],'worker-units'))
elif mode=='units':
 sys.exit(run('candidate',['--test','tools/incident/units.test.mjs'],'units'))
elif mode=='uom-regression':
 files=['test/mbt/unit/netsuite-order-line.test.js','test/mbt/unit/netsuite-order-line-sync.test.js','test/mbt/unit/operator-kit.test.js','test/mbt/unit/operator-kit-runtime.test.js','test/mbt/property/operator-kit.property.test.js','test/mbt/unit/scm-netsuite-po-version.test.js']
 harnesses=['src/netsuite-delivery-order-batch-harness.js','src/netsuite-reconciliation-line-harness.js','src/scm-netsuite-po-history-harness.js','src/scm-netsuite-po-unit-conversion-harness.js']
 for tree in ['baseline','candidate']: run(tree,['--test','--test-concurrency=1',*files,*harnesses],tree+'-uom-regression')
elif mode=='posting-regression':
 args=['--test','--test-concurrency=1',*sorted(str(f.relative_to(SERVER)) for f in (SERVER/'test/mbt/unit').glob('operator-netsuite-posting-*.test.js')),'test/mbt/adversarial/operator-netsuite-posting-adversarial.test.js']
 for tree in ['baseline','candidate']: run(tree,args,tree+'-posting')
elif mode=='review-rule':
 status=run('candidate',['--test','tools/incident/review-rule.test.mjs'],'review-rule')
 sys.exit(status)
elif mode=='browser':
 assert run('candidate',['tools/receiving-posting-status-browser.mjs'],'receiving-browser')==0
 assert run('candidate',['tools/incident/ui-browser.mjs'],'review-browser')==0
elif mode=='static':
 for tree in ['baseline','candidate']:
  assert run(tree,['tools/incident/static.mjs'],tree+'-static')==0
elif mode=='mutations':
 assert run('candidate',['tools/incident/mutations.mjs'],'mutations')==0
 assert run('candidate',['tools/incident/review-mutations.mjs'],'review-mutations')==0
 assert run('candidate',['tools/incident/units-mutations.mjs'],'units-mutations')==0
