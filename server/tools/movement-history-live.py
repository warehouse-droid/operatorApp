"""Read-only comparison of the deployed and proposed movement/history lookups."""
import base64
import json
from pathlib import Path
import subprocess
import sys

server = Path(__file__).resolve().parents[1]
out = server / 'test-artifacts/movement-document-history'
def module(file, replacements=None):
    source = (server / file).read_text()
    for before, after in (replacements or {}).items():
        source = source.replace(before, after)
    import re
    source = re.sub(r'([\'"])\./([^\'"]+)\1', lambda match: json.dumps('file:///app/src/' + match[2]), source)
    return 'data:text/javascript;base64,' + base64.b64encode(source.encode()).decode()

evidence = module('src/movement-record-evidence.js')
replacements = {'"./movement-record-evidence.js"': json.dumps(evidence)}
history = module('src/history-repository.js', replacements)
yard = module('src/yard-movement-repository.js', replacements)
deployed = '--deployed' in sys.argv
if deployed:
    history = 'file:///app/src/history-repository.js'
    yard = 'file:///app/src/yard-movement-repository.js'
script = '''import {query,withTransaction,closeDb} from './src/db.js';
import {listYardMovements as previousYard} from './src/yard-movement-repository.js';
const {listYardMovements}=await import(YARD);
const {listOperatorHistory}=await import(HISTORY);
try {await withTransaction(async()=>{
 await query('SET TRANSACTION READ ONLY');
 await query("SET LOCAL statement_timeout='10s'");
 const filters={from:'2026-09-26',to:'2026-09-26',direction:'outbound',orderType:'sales_order',yard:'all'};
 const time=async fn=>{const start=performance.now();const rows=await fn();return {ms:Math.round(performance.now()-start),rows};};
 const before=await time(()=>previousYard(filters));
 const after=await time(()=>listYardMovements(filters));
 const operator=(await query('SELECT operator_id FROM operator_load_records WHERE id=1964')).rows[0].operator_id;
 const history=await time(()=>listOperatorHistory({operatorId:operator,date:'2026-09-26',yardLocationIds:[1]}));
 const inbound=await time(()=>listYardMovements({...filters,from:'2026-09-25',to:'2026-09-25',direction:'inbound',orderType:'purchase_order'}));
 const pick=row=>({ref:row.tranid,status:row.status||row.movement_status,documents:row.documents,waiting:row.waitingForDriverCompletion});
 console.log(JSON.stringify({beforeMs:before.ms,afterMs:after.ms,beforeCount:before.rows.length,afterCount:after.rows.length,
 historyMs:history.ms,inboundMs:inbound.ms,
 samples:after.rows.filter(row=>['SOB121478','SOM06707','SOB121445'].includes(row.tranid)).map(pick),
 waitingSamples:after.rows.filter(row=>row.waitingForDriverCompletion).slice(0,3).map(pick),
 pickupHistory:history.rows.filter(row=>row.tranid==='SOB121478').map(pick),
 receiptSamples:inbound.rows.filter(row=>row.documents?.length).slice(0,2).map(pick)}));
});}finally{await closeDb();}
'''.replace('YARD', json.dumps(yard)).replace('HISTORY', json.dumps(history))
result = subprocess.run(['sudo','-n','docker','exec','-i','-w','/app','mbbs-operator-app-app-1','node','--input-type=module','-'], input=script, text=True, capture_output=True)
if result.returncode:
    # Avoid logging the inline module bodies on an import error.
    print(result.stderr[-2500:])
    raise SystemExit(result.returncode)
data = json.loads(result.stdout)
(out / ('live-deployed.json' if deployed else 'live-read.json')).write_text(json.dumps(data, indent=2)+'\n')
assert data['beforeCount'] == data['afterCount']
print(json.dumps(data, indent=2))
