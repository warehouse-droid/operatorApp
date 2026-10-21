"""Repeat the isolated gauntlet. Use --focused after an already recorded broad run."""
import argparse,hashlib,json,pathlib,re,subprocess,sys
root=pathlib.Path(__file__).resolve().parents[2]
artifact=root/'test-artifacts/to-line-reference-20261003';artifact.mkdir(exist_ok=True)
parser=argparse.ArgumentParser();parser.add_argument('--focused',action='store_true');args=parser.parse_args()
runner='mbbs-to-reference-20261003-runner'
files=json.loads((root/'tools/to-line-reference-20261003/deployment-files.json').read_text())
acceptance=['test/mbt/unit/to-posting-reference.test.js','test/mbt/unit/transfer-order-background-posting.test.js','test/mbt/integration/transfer-order-background-posting.test.js']
regression=['test/mbt/'+f for f in ['unit/noninventory-fulfillment.test.js','unit/operator-linked-fulfillment.red.test.js','unit/operator-posting-photo-client.test.js','unit/sales-order-auto-fulfillment-wiring.red.test.js','integration/consolidation-load.test.js','integration/noninventory-fulfillment.test.js','integration/operator-direct-orderline.test.js']]
safety=['test/mbt/'+f for f in ['unit/operator-yard-assets.test.js','unit/sales-order-auto-fulfillment-service.red.test.js','unit/operator-netsuite-posting-service.red.test.js','unit/operator-netsuite-posting-targets.red.test.js','unit/operator-yard-access.test.js','unit/operator-netsuite-posting-domain.red.test.js','integration/operator-yard-access.test.js']]
def run(name,command,allow_failure=False):
 with (artifact/(name+'.log')).open('w') as log:
  result=subprocess.run(['docker','exec','-w','/app',runner,*command],cwd=root,stdout=log,stderr=subprocess.STDOUT)
 print(json.dumps({'layer':name,'exit':result.returncode}),flush=True)
 if result.returncode and not allow_failure:raise SystemExit(f'{name} failed; see its log')
def focused(command):return ['node','tools/to-line-reference-20261003/focused.mjs',*command]
def failed_files(log):
 lines=[s for s in log.splitlines() if s.startswith('Isolated MBT main run failed')]
 return {re.sub(r'^/[^/]+/','',f) for f in re.findall(r'/[^, ]+\.test\.js',lines[-1])} if lines else set()
if not args.focused:
 run('final-full',['npm','test'],True)
 before=failed_files((artifact/'baseline-full.log').read_text());after=failed_files((artifact/'final-full.log').read_text())
 if after-before:raise SystemExit('New broad-suite failures: '+', '.join(sorted(after-before)))
run('coverage-final',focused(['./node_modules/.bin/c8','--all=false',*[f'--include={f}' for f in files if f.startswith(('src/transfer-order-posting-','src/netsuite-transfer-posting-line'))],
 '--temp-directory=/tmp/to-posting-c8-final','--report-dir=test-artifacts/to-line-reference-20261003/coverage','--reporter=text','--reporter=json','--reporter=json-summary',
 'node','--test','--test-concurrency=1',*acceptance]))
run('regression-final',focused(['node','--test','--test-concurrency=1',*regression]))
run('safety-final',focused(['node','--test','--test-concurrency=1',*safety]))
# A second, independently ordered execution checks fixture isolation and repeatability.
run('shuffled-final',focused(['node','--test','--test-concurrency=1',*sorted(set(acceptance+regression+safety),key=lambda x:hashlib.sha256(('1036611'+x).encode()).hexdigest())]))
run('browser-final',['node','tools/to-line-reference-20261003/browser.mjs'])
run('mutation-final',['node','tools/to-line-reference-20261003/mutate.mjs'])
run('types-final',['./node_modules/.bin/tsc','-p','tsconfig.mbt.json'],True)
def diagnostics(name):
 return {re.sub(r'\(\d+,\d+\)','',s.replace('/baseline/','/app/')) for s in (artifact/f'types-{name}.log').read_text().splitlines() if 'error TS' in s}
new=diagnostics('final')-diagnostics('baseline')
if new:raise SystemExit('New type errors: '+str(sorted(new)))
lint_files=[f for f in files if f.startswith(('src/operator-netsuite-posting-','src/sales-order-auto-fulfillment-','src/transfer-order-posting-','src/netsuite-transfer-posting-line'))]
run('lint-final',['./node_modules/.bin/eslint','--config','tools/to-line-reference-20261003/eslint.config.mjs','--max-warnings=0',*lint_files],True)
lint=(artifact/'lint-final.log').read_text().replace('/app/','/baseline/').strip()
baseline=(artifact/'lint-baseline.log').read_text().strip()
if lint and lint!=baseline:raise SystemExit('New lint diagnostics; compare lint-final and lint-baseline logs')
run('syntax-final',['node','--input-type=module','-e',"import fs from 'node:fs';import cp from 'node:child_process';for(const f of JSON.parse(fs.readFileSync('tools/to-line-reference-20261003/deployment-files.json')))if(f.endsWith('.js'))cp.execFileSync(process.execPath,['--check',f]);console.log('All deployment JavaScript parses');"])
run('secrets-final',['node','test/support/scan-diff-secrets.mjs','--unified-diff','test-artifacts/to-line-reference-20261003/task.diff'])
manifest={f:hashlib.sha256((root/f).read_bytes()).hexdigest() for f in files}
(artifact/'source-state.json').write_text(json.dumps({'files':manifest,'treeHash':hashlib.sha256(json.dumps(manifest,sort_keys=True).encode()).hexdigest()},indent=2)+'\n')
print('Gauntlet completed; broad-suite baseline exceptions remain explicitly recorded.')
