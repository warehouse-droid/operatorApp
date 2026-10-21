"""Reproduce local closure checks using installed isolated tools and database."""
import difflib
import json
from pathlib import Path
import subprocess
import tarfile

SERVER=Path(__file__).resolve().parents[1]
OUT=SERVER/'test-artifacts/special-local-closure'
ROOT='/tmp/special-local-closure'
RUNNER='mbbs-special-review-runner'
OUT.mkdir(parents=True,exist_ok=True)
FILES=['src/special-stock-closed-orders.js','src/special-stock-closure-service.js','src/special-stock-request-repository.js']
candidate=OUT/'candidate'
for file in FILES:
    target=candidate/file
    target.parent.mkdir(parents=True,exist_ok=True)
    source=(SERVER/file).read_text()
    if file.endswith('special-stock-request-repository.js'):
        baseline=(OUT/'baseline'/file).read_text()
        def section(text,start,end):
            return text[text.index(start):text.index(end,text.index(start))]
        old=section(baseline,'async function assertSpecialClosureUnplanned(', 'function matchingClosureReview(')
        new=section(source,'async function assertSpecialClosureUnplanned(', 'function matchingClosureReview(')
        own=section(source,'export async function closeSpecialCaseForClosedOrders(', 'export async function rejectSpecialClosureReview(')
        source=baseline.replace(old,new).replace('export async function rejectSpecialClosureReview(',own+'export async function rejectSpecialClosureReview(')
        anchor="import { isLocalPickupChange } from './special-stock-fulfillment-policy.js';\n"
        source=source.replace(anchor,anchor+"import { assertSpecialClosedOrderEvidence } from './special-stock-closed-orders.js';\n")
    target.write_text(source)
diff=[]
for file in FILES:
    before=OUT/'baseline'/file
    diff.extend(difflib.unified_diff(before.read_text().splitlines(True) if before.exists() else [],
        (candidate/file).read_text().splitlines(True),fromfile='a/'+file,tofile='b/'+file,n=0))
(OUT/'runtime.diff').write_text(''.join(diff))
archive=OUT/'input.tar'
with tarfile.open(archive,'w') as tar:
    for file in ['src','public','test','migrations','contracts','tools','package.json',
                 'netsuite-smart-scm-picking-ticket-restlet.js',
                 'eslint.mbt.config.js','test-artifacts/special-local-closure/runtime.diff']:
        tar.add(SERVER/file,arcname=file)
    for file in FILES:tar.add(candidate/file,arcname=file)
    tar.add(OUT/'baseline',arcname='test-artifacts/special-local-closure/baseline')
subprocess.run(['sudo','-n','docker','cp',str(archive),RUNNER+':/tmp/special-local-closure-input.tar'],check=True)
script="""mkdir -p /tmp/special-local-closure
tar -xf /tmp/special-local-closure-input.tar -C /tmp/special-local-closure
test -e /tmp/special-local-closure/node_modules || ln -s /app/node_modules /tmp/special-local-closure/node_modules
"""
subprocess.run(['sudo','-n','docker','exec',RUNNER,'sh','-c',script],check=True)
result=subprocess.run(['sudo','-n','docker','exec','-w',ROOT,'-e','MBT_TEST_ISOLATED=1',
    '-e','PLAYWRIGHT_BROWSERS_PATH=/browsers',
    '-e','DATABASE_URL=postgres://mbt_test:special_review_only@mbbs-special-review-db:5432/mbt_verify',
    RUNNER,'node','tools/special-local-closure-check.mjs'])
output=subprocess.check_output(['sudo','-n','docker','exec',RUNNER,'tar','-cf','-',
    '-C',ROOT+'/test-artifacts/special-local-closure','.'])
(OUT/'output.tar').write_bytes(output)
with tarfile.open(OUT/'output.tar') as tar:tar.extractall(OUT,filter='data')
raise SystemExit(result.returncode)
