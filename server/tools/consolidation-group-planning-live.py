"""Compare production and candidate consolidation reads without changing production state."""
import base64
import json
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[1]
source = (root / 'src/consolidation-load-repository.js').read_text()
# Production does not yet contain the pending photo worker. This write boundary must never run.
source = source.replace('import { enqueuePostingPhotos } from "./operator-netsuite-posting-photo-queue.js";',
                        'const enqueuePostingPhotos = () => { throw new Error("Read-only replay cannot enqueue photos"); };')
source = source.replace('from "./', 'from "file:///app/src/')
module = 'data:text/javascript;base64,' + base64.b64encode(source.encode()).decode()
script = '''
import assert from 'node:assert/strict';
import {query,withTransaction,pool} from './src/db.js';
import * as current from './src/consolidation-load-repository.js';
import {buildConsolidationSnapshot} from './src/consolidation-load-domain.js';
const candidate = await import(MODULE);
const operator={id:'diagnostic-read-only',role:'admin',roles:['admin'],operatorYardLocationIds:[1,15,28,26]};
const expected=['SOA08600','SOA08648','SOB120124','SOB120358','SOB120251','SOB120252','SOB120300','SOB120301','SOB120385','RP-UNI-GORMLEY-3445-0915-1'];
try {
 await withTransaction(async()=>{
  await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
  const options={locationId:1,planDate:'2026-09-16'};
  const before=await current.listConsolidationLoadOrders(operator,options);
  const after=await candidate.listConsolidationLoadOrders(operator,options);
  assert.deepEqual(after.orders.map(order=>order.tranid).sort(),expected.sort());
  const selections=[['SOA08600','SOA08648','SOB120124','SOB120358'],['SOB120251','SOB120252'],['SOB120300','SOB120301']];
  const previews=[];
  for(const refs of selections){
   const ids=after.orders.filter(order=>refs.includes(order.tranid)).map(order=>order.netsuite_id);
   const rows=await candidate.readConsolidationOrders(operator,1,ids);
   const snapshot=buildConsolidationSnapshot(rows);
   assert.equal(snapshot.orders.length,refs.length);
   previews.push({orders:refs,assignment:rows[0].assignment});
  }
  console.log(JSON.stringify({checkedAt:new Date().toISOString(),mode:'READ ONLY transaction; candidate module in memory; photo writes disabled',date:options.planDate,locationId:1,
   before:before.orders.map(({tranid})=>tranid),after:after.orders.map(({tranid,assignment})=>({tranid,assignment})),previews}));
 });
} finally {await pool.end();}
'''.replace('MODULE', json.dumps(module))
result = subprocess.run(['docker', 'exec', '-i', 'mbbs-operator-app-app-1', 'node', '--input-type=module'], input=script, text=True, capture_output=True)
if result.returncode:
    # Do not echo the data URL or a possible full module in a Node import error.
    raise RuntimeError('Read-only live replay failed: ' + '\n'.join(line for line in result.stderr.splitlines() if 'data:text/javascript' not in line)[-2000:])
report = json.loads(result.stdout)
(root / 'test-artifacts/consolidation-group-planning/live.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
