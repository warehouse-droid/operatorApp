"""Read-only, same-process comparison of deployed and candidate queue loads."""
from pathlib import Path
import base64
import json
import re
import subprocess
from urllib.parse import urljoin
server=Path(__file__).resolve().parents[1]
def module_url(source):
    return 'data:text/javascript;base64,'+base64.b64encode(source.encode()).decode()
def absolute_imports(source):
    return re.sub(r'(from\s+[\'\"])(\.\.?/[^\'\"]+)', lambda match: match[1]+urljoin('file:///app/src/',match[2]), source)

planning=module_url(absolute_imports((server/'src/special-stock-planning.js').read_text()))
repository=absolute_imports((server/'src/special-stock-request-repository.js').read_text()).replace('file:///app/src/special-stock-planning.js',planning)
candidate=module_url(repository)
script="""import {listSpecialStockCases as deployed} from './src/special-stock-request-repository.js';
import {closeDb,pool} from './src/db.js';import {createHash} from 'node:crypto';
const {listSpecialStockCases:candidate}=await import(CANDIDATE);
const outputs=[],original=pool.query.bind(pool);let queries=[];
pool.query=async(...args)=>{const t=performance.now();try{return await original(...args);}finally{queries.push({sql:String(args[0]).slice(0,140),ms:Math.round(performance.now()-t)});}};
try{for(const audience of ['sales','scm']){
 const options={audience,...(audience==='sales'?{authorizedStoreLocationIds:[1]}:{})};
 for(const [version,list]of [['deployed',deployed],['candidate',candidate]]){
  queries=[];const start=performance.now(),cases=await list(options);
  outputs.push({audience,version,queries,count:cases.length,ms:Math.round(performance.now()-start),bytes:JSON.stringify(cases).length,hash:createHash('sha256').update(JSON.stringify(cases)).digest('hex')});
 }
}console.log(JSON.stringify(outputs));}finally{await closeDb();}
""".replace('CANDIDATE',json.dumps(candidate))
result=subprocess.run(['sudo','-n','docker','exec','-i','-w','/app','mbbs-operator-app-app-1','node','--input-type=module'],input=script,text=True,capture_output=True)
if result.returncode:
    print(re.sub(r"data:text/javascript;base64,[A-Za-z0-9+/=]+", "<candidate-module>",result.stderr)[-1600:]);raise SystemExit(result.returncode)
out=server/'test-artifacts/special-workflow-review/queue-access/timing.json';out.write_text(result.stdout)
print(result.stdout.strip())
