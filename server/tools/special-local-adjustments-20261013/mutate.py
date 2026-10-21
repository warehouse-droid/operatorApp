"""Throwaway source mounts; never modify the shared source tree for a mutant."""
import hashlib,json,subprocess,sys
from pathlib import Path
SERVER=Path(__file__).resolve().parents[2]
OUT=SERVER/'test-artifacts/special-local-adjustments-20261013'
REPO=SERVER.parent
PROJECT='mbbs-special-local-adjustments-20261013'
compose=['sudo','-n','docker','compose','--project-name',PROJECT,'--project-directory',str(REPO),'-f',str(REPO/'docker-compose.mbt-test.yml'),'-f',str(OUT/'compose.test.json')]
mutants=[('ignore-removal','src/special-stock-local-adjustments.js','if (input.remove === true)','if (input.remove === false)','unit'),
 ('allow-duplicate-lines','src/special-stock-local-adjustments.js','|| new Set(input.lines.map(line=>Number(line.caseLineId))).size !== accepted.length','|| false','unit'),
 ('sync-issued-orders','src/special-stock-local-adjustments.js',"return review.mode === 'issued' && review.remoteStarted !== true;",'return false;','unit'),
 ('forget-removal-history','src/special-stock-request-repository.js',"'special_request_line_removed',context.operatorId","'special_request_line_missing',context.operatorId",'integration'),
 ('hide-removal-notice','public/sales-special-stock-requests.js','<p>Remove item: ${escapeHtml(line.productName)}</p>','<p>Keep item: ${escapeHtml(line.productName)}</p>','browser'),
 ('drop-po-draft-ancillary','src/special-stock-local-adjustments.js','return [line];','return [];','unit')]
results=[]
for name,file,before,after,kind in mutants:
    original=(SERVER/file).read_bytes();text=original.decode();assert text.count(before)==1,(name,'mutation point changed')
    target=OUT/'mutants'/name/file;target.parent.mkdir(parents=True,exist_ok=True);target.write_text(text.replace(before,after,1))
    override=OUT/'mutants'/name/'compose.json';override.write_text(json.dumps({'services':{'test':{'volumes':[str(target)+':/app/'+file+':ro']}}}))
    log=OUT/'mutants'/name/'test.log'
    tests=['--test-name-pattern=local adjustment','test/mbt/integration/special-approval-browser.test.js'] if kind=='browser' else ['test/mbt/'+kind+'/special-local-adjustments.test.js']
    with log.open('w') as output:
        result=subprocess.run(compose+['-f',str(override),'run','--rm','--no-deps','-T','test','node','--test',*tests],stdout=output,stderr=subprocess.STDOUT,cwd=REPO)
    assert (SERVER/file).read_bytes()==original,'Shared source changed during mutation'
    results.append({'mutant':name,'killed':result.returncode!=0,'exit':result.returncode,'originalSha256':hashlib.sha256(original).hexdigest()})
(OUT/'mutations.json').write_text(json.dumps(results,indent=2)+'\n')
print(json.dumps({'mutantsKilled':sum(r['killed'] for r in results),'mutants':len(results)}),flush=True)
assert all(r['killed'] for r in results)
