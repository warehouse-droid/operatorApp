import pathlib,subprocess,json,re,hashlib,sys
root=pathlib.Path(__file__).resolve().parents[2];out=root/'test-artifacts/netsuite-attention-20261003'
runner='mbbs-to-reference-20261003-runner'
files=json.loads((root/'tools/netsuite-attention-20261003/deployment-files.json').read_text())
pattern=r'netsuite-attention|sales-order-auto-fulfillment|operator-netsuite-posting-(service|runtime-adapters|targets|domain)|noninventory-fulfillment|operator-direct-orderline|operator-linked-fulfillment|transfer-order-background-posting|to-posting-reference|child-location-fulfillment|child-location-parts|netsuite-transaction-units'
tests=sorted(str(p.relative_to(root)) for area in ['unit','integration'] for p in (root/'test/mbt'/area).glob('*.test.js') if re.search(pattern,p.name))
def run(name,cmd,allow=False):
 with (out/(name+'.log')).open('w') as log:
  result=subprocess.run(['docker','exec','-w','/app',runner,*cmd],stdout=log,stderr=subprocess.STDOUT)
 print(json.dumps({'layer':name,'exit':result.returncode}),flush=True)
 if result.returncode and not allow:raise SystemExit(name+' failed')
mode=sys.argv[1]
if mode=='focused':
 command=['node','tools/to-line-reference-20261003/focused.mjs','./node_modules/.bin/c8','--all=false','--check-coverage=false',
  *['--include='+f for f in files if f.startswith('src/')], '--include=tools/netsuite-attention-20261003/verify-reviewed-existing.mjs',
  '--temp-directory=/tmp/attention-c8-final','--report-dir=test-artifacts/netsuite-attention-20261003/coverage',
  '--reporter=text','--reporter=json','--reporter=json-summary','node','--test','--test-concurrency=1',*tests]
 run('focused-final',command)
 run('shuffled-final',['node','tools/to-line-reference-20261003/focused.mjs','node','--test','--test-concurrency=1',*sorted(tests,key=lambda f:hashlib.sha256(f.encode()).hexdigest())])
 run('browser-final',['node','tools/netsuite-attention-20261003/browser.mjs'])
elif mode=='static':
 run('types-final',['./node_modules/.bin/tsc','-p','tsconfig.mbt.json'],True)
 def diagnostics(name):return {re.sub(r'\(\d+,\d+\)','',s) for s in (out/f'types-{name}.log').read_text().splitlines() if 'error TS' in s}
 new=diagnostics('final')-diagnostics('baseline')
 if new:raise SystemExit('New type errors: '+str(sorted(new)))
 run('lint-final',['./node_modules/.bin/eslint','--config','tools/netsuite-attention-20261003/eslint.config.mjs',
  'src/sales-order-auto-fulfillment-service.js','src/sales-order-auto-fulfillment-repository.js',
  'src/netsuite-fulfillment-exclusions.js','src/sales-order-fulfillment-first-split.js'])
 run('secrets-final',['node','test/support/scan-diff-secrets.mjs','--unified-diff','test-artifacts/netsuite-attention-20261003/task.diff'])
elif mode=='mutation':run('mutation-final',['node','tools/netsuite-attention-20261003/mutate.mjs'])
else:raise SystemExit('Expected focused, static or mutation')
(out/f'{mode}-manifest.json').write_text(json.dumps({'tests':tests,'files':{f:hashlib.sha256((root/f).read_bytes()).hexdigest() for f in files}},indent=2)+'\n')
