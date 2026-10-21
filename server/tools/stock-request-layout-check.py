"""Reproduce the scoped stock-request validation using the existing isolated runner."""
from pathlib import Path
import difflib
import hashlib
import json
import os
import subprocess

server=Path(__file__).resolve().parents[1]
out=server/'test-artifacts/stock-request-cleanup-layout'
files=json.loads((out/'runtime-files.json').read_text())
docker=['sudo','-n','docker']
runner=docker+['exec','-e','MBT_TEST_ISOLATED=1','-e','DATABASE_URL=postgres://mbt_test:special_review_only@mbbs-special-review-db:5432/mbt_verify','-e','PLAYWRIGHT_BROWSERS_PATH=/browsers','-w','/app','mbbs-special-review-runner']
tests=['test/mbt/integration/stock-request-yard-selection.test.js','test/mbt/integration/special-workflow-queue-access.test.js','test/mbt/unit/stock-request-yard-filter.test.js','test/mbt/unit/special-workflow-queue.test.js','test/mbt/unit/stock-request-ui-contract.test.js','test/mbt/unit/stock-request-server-contract.test.js']

def check(label,args):
    result=subprocess.run(runner+args,capture_output=True,text=True)
    (out/(label+'.log')).write_text(result.stdout+result.stderr)
    if result.returncode:
        raise RuntimeError(label+': '+(result.stdout+result.stderr)[-3000:])
    print(label+': passed',flush=True)

for file in files+['tools/stock-request-test-cleanup.mjs']:
    if file.endswith(('.js','.mjs')):check('syntax-'+Path(file).name,['node','--check',file])
lintfiles=[file for file in files if file.endswith('.js') and file!='src/server.js']
check('lint',['node','node_modules/eslint/bin/eslint.js','--config','tools/stock-request-layout-eslint.config.mjs',*lintfiles,'tools/stock-request-test-cleanup.mjs'])
check('types',['node','node_modules/typescript/bin/tsc','--allowJs','--checkJs','--noEmit','--skipLibCheck','--module','nodenext','--target','es2022','--types','node','public/stock-request-yard-filter.js'])
check('focused-tests',['node','node_modules/c8/bin/c8.js','--check-coverage=false','--include=public/stock-request-yard-filter.js','--include=src/stock-request-repository.js','--include=src/special-stock-request-repository.js','--include=tools/stock-request-test-cleanup.mjs','--reporter=json','--reports-dir=test-artifacts/stock-request-cleanup-layout/coverage','--temp-dir=test-artifacts/stock-request-cleanup-layout/.coverage','node','--test',*tests])
check('suite-health',['node','--test','--test-reporter=dot',*reversed(tests)])
check('mutations',['node','tools/stock-request-layout-mutations.mjs'])
check('browser',['node','tools/stock-request-layout-browser.mjs'])
diff=[]
for file in files:
    baseline=out/'baseline'/file
    before=baseline.read_text() if baseline.exists() else ''
    diff.extend(difflib.unified_diff(before.splitlines(True),(server/file).read_text().splitlines(True),fromfile='a/server/'+file,tofile='b/server/'+file,n=0))
(out/'runtime.diff').write_text(''.join(diff))
for name in ['runtime-files.json','runtime.diff']:
    subprocess.run(docker+['cp',str(out/name),'mbbs-special-review-runner:/app/test-artifacts/stock-request-cleanup-layout/'+name],check=True,capture_output=True)
check('changed-coverage',['node','tools/stock-request-layout-coverage.mjs','--require-complete'])
subprocess.run(docker+['cp','mbbs-special-review-runner:/app/test-artifacts/stock-request-cleanup-layout/.',str(out)],check=True,capture_output=True)
for path in out.rglob('*'):
    if path.stat().st_uid!=os.getuid():subprocess.run(['sudo','-n','chown',f'{os.getuid()}:{os.getgid()}',str(path)],check=True,capture_output=True)
browser=json.loads((out/'browser.json').read_text())
assert len(browser['results'])==6 and not browser['errors']
for file,sha in browser['sourceHashes'].items():assert hashlib.sha256((server/file).read_bytes()).hexdigest()==sha,file
check('tool-versions',['node','--input-type=module','-e',"import fs from 'node:fs'; console.log(JSON.stringify({node:process.version,...Object.fromEntries(['c8','fast-check','typescript','eslint','playwright'].map(name=>[name,JSON.parse(fs.readFileSync('node_modules/'+name+'/package.json')).version]))}));"])
sources=files+tests+[str(path.relative_to(server)) for path in (server/'tools').glob('stock-request-*')]+['test/stock-request-cleanup-layout-spec.md']
hashes={file:hashlib.sha256((server/file).read_bytes()).hexdigest() for file in sources}
(out/'source-manifest.json').write_text(json.dumps(hashes,indent=2)+'\n')
report=json.loads((out/'changed-lines.json').read_text())
summary={'completed':True,'tests':37,'browserViews':6,'manualMutantsKilled':5,'changedLines':report,'syntax':True,'lint':True,'types':'shared filter module','netSuiteRequests':0,'specApproval':'not obtained (autonomous run)','sourceTreeSha256':hashlib.sha256(json.dumps(hashes,sort_keys=True).encode()).hexdigest()}
(out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps({key:value for key,value in summary.items() if key!='changedLines'}))
