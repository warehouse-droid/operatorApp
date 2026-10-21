"""Read-only preview of the scoped candidate against the current application."""
import base64
import json
from pathlib import Path
import re
import subprocess

SERVER = Path(__file__).resolve().parents[1]
OUT = SERVER / 'test-artifacts/damage-photos-20261001'

def module_uri(file, overrides=None):
    overrides = overrides or {}
    source = (SERVER / file).read_text()
    def resolve(match):
        relative = match[1]
        target = overrides.get(relative, 'file:///app/src/' + relative.removeprefix('./'))
        return "from '" + target + "'"
    source = re.sub(r"from ['\"](\./[^'\"]+)['\"]", resolve, source)
    return 'data:text/javascript;base64,' + base64.b64encode(source.encode()).decode()

helper = module_uri('src/inventory-damage-photo-links.js')
service = module_uri('src/inventory-damage-service.js', {'./inventory-damage-photo-links.js': helper})
review = module_uri('src/control-damage-review.js', {'./inventory-damage-service.js': service})
adapter = module_uri('src/inventory-damage-netsuite.js')
script = """import assert from 'node:assert/strict';
import {query,pool} from './db.js';
import {activeNetSuiteLocationDirectory,inventoryTransferRest,suiteqlAll} from './netsuite.js';
const {createDamageNetSuite}=await import(ADAPTER);
const {reviewControlDamageMonth}=await import(REVIEW);
const timings=[];
const timed=(name,fn)=>async(...args)=>{const start=performance.now();try{return await fn(...args);}finally{timings.push({name,ms:Math.round(performance.now()-start)});}};
const remote=createDamageNetSuite({rest:async(...args)=>timed('transfer '+args[0],inventoryTransferRest)(...args),
directory:timed('yard directory',activeNetSuiteLocationDirectory),sql:async(...args)=>timed(args[0].includes('transactionline')?'units query':'damage transfer list',suiteqlAll)(...args)});
try {
 const id='bd4d6c99-5431-4dea-b51a-b0d9c86dc46f';
 const before=(await query('SELECT * FROM inventory_damage_reports WHERE id=$1',[id])).rows[0];
 const start=performance.now();
 const review=await reviewControlDamageMonth({role:'admin',roles:['admin']},1,'2026-10',{remote});
 assert.equal(review.syncError,null);
 const transfer=review.transfers.find(row=>row.ref==='IT00571');assert.ok(transfer);
 const line=transfer.lines.find(row=>row.line===1);assert.equal(line.reportId,id);assert.equal(line.photos.length,1);
 assert.equal(line.itemName,'UNI-PISAS-COP-SAFARI');
 assert.deepEqual((await query('SELECT * FROM inventory_damage_reports WHERE id=$1',[id])).rows[0],before);
 assert.ok(!timings.some(row=>row.name==='units query'));
 console.log(JSON.stringify({totalMs:Math.round(performance.now()-start),timings,transfer:transfer.ref,line:line.line,sku:line.itemName,
   photos:line.photos.length,reportStatus:before.status,stockWrites:0,reportUnchanged:true}));
} finally {await pool.end();}
""".replace('ADAPTER', json.dumps(adapter)).replace('REVIEW', json.dumps(review))
result = subprocess.check_output(['sudo','-n','docker','exec','-i','-w','/app/src','mbbs-operator-app-app-1',
                                  'node','--input-type=module'], input=script.encode(), timeout=90)
data=json.loads(result)
OUT.mkdir(exist_ok=True)
(OUT / 'live-candidate-probe.json').write_text(json.dumps(data,indent=2)+'\n')
print(json.dumps(data),flush=True)
