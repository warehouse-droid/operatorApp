"""Run the linked-TO regression layers using the existing isolated runner."""
import hashlib,json,pathlib,re,subprocess,sys
root=pathlib.Path(__file__).resolve().parents[2];out=root/'test-artifacts/to-linked-so-20261004';out.mkdir(exist_ok=True)
files=json.loads((root/'tools/to-linked-so-20261004/deployment-files.json').read_text())
runner='mbbs-to-reference-20261003-runner'
pattern=r'to-linked-so-completion|netsuite-attention|sales-order-auto-fulfillment|operator-netsuite-posting-(service|runtime-adapters|targets|domain)|noninventory-fulfillment|operator-direct-orderline|operator-linked-fulfillment|transfer-order-background-posting|to-posting-reference|child-location-fulfillment|child-location-parts|netsuite-transaction-units'
tests=sorted(str(p.relative_to(root)) for area in ['unit','integration'] for p in (root/'test/mbt'/area).glob('*.test.js') if re.search(pattern,p.name))
def run(name,cmd,allow=False):
 with (out/(name+'.log')).open('w') as log:r=subprocess.run(['docker','exec','-w','/app',runner,*cmd],stdout=log,stderr=subprocess.STDOUT)
 print(json.dumps({'layer':name,'exit':r.returncode}),flush=True)
 if r.returncode and not allow:raise SystemExit(name+' failed')
def focused(cmd):return ['node','tools/to-line-reference-20261003/focused.mjs',*cmd]
mode=sys.argv[1]
if mode=='full':run('full-final',['npm','test'],True)
elif mode=='focused':
 run('focused-final',focused(['./node_modules/.bin/c8','--all=false','--check-coverage=false',
  *['--include='+f for f in files if f.startswith('src/')], '--temp-directory=/tmp/to-linked-so-c8',
  '--report-dir=test-artifacts/to-linked-so-20261004/coverage','--reporter=text','--reporter=json','--reporter=json-summary',
  'node','--test','--test-concurrency=1',*tests]))
 run('shuffled-final',focused(['node','--test','--test-concurrency=1',*sorted(tests,key=lambda f:hashlib.sha256(f.encode()).hexdigest())]))
 run('browser-final',['node','tools/to-linked-so-20261004/browser.mjs'])
elif mode=='static':
 run('types-final',['./node_modules/.bin/tsc','-p','tsconfig.mbt.json'],True)
 def types(name):return {re.sub(r'\(\d+,\d+\)','',s) for s in (out/f'types-{name}.log').read_text().splitlines() if 'error TS' in s}
 assert not types('final')-types('baseline'),sorted(types('final')-types('baseline'))
 run('lint-final',['./node_modules/.bin/eslint','--config','tools/to-line-reference-20261003/eslint.config.mjs',*[f for f in files if f.startswith('src/')]])
 run('secrets-final',['node','test/support/scan-diff-secrets.mjs','--unified-diff','test-artifacts/to-linked-so-20261004/task.diff'])
elif mode=='mutation':run('mutation-final',['node','tools/to-linked-so-20261004/mutate.mjs'])
elif mode=='all':
 for phase in ['full','focused','static','mutation']:subprocess.run([sys.executable,__file__,phase],check=True)
else:raise SystemExit('Expected all, full, focused, static or mutation')
(out/f'{mode}-manifest.json').write_text(json.dumps({'tests':tests,'files':{f:hashlib.sha256((root/f).read_bytes()).hexdigest() for f in files}},indent=2)+'\n')
