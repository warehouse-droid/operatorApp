"""Exercise the candidate read queries against imported public City records, read-only."""
import base64
import json
from pathlib import Path
import re
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
FILES = {'src/field-sales/repository.js', 'src/field-sales/lead-filters.js', 'public/field-sales/lead-policy.js'}


def module_url(name):
    content = (SERVER / name).read_text()

    def replace(match):
        target = str((SERVER / name).parent.joinpath(match[2]).resolve().relative_to(SERVER))
        url = module_url(target) if target in FILES else 'file:///app/' + target
        return 'from ' + json.dumps(url)

    content = re.sub(r"from (['\"])(\.{1,2}/[^'\"]+)\1", replace, content)
    return 'data:text/javascript;base64,' + base64.b64encode(content.encode()).decode()


script = r"""import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from './src/db.js';
const {createFieldSalesRepository}=await import(MODULE);
let queries=[];
const repo=createFieldSalesRepository({query:async(sql,args)=>{const started=performance.now();const result=await query(sql,args);queries.push({operation:sql.includes('count(*)::int AS total')?'count':sql.includes('floor(j.latitude')?'map':sql.includes('WITH candidates')?'list':'detail',milliseconds:Math.round(performance.now()-started)});return result;},transaction:withTransaction});
try {
 const results=await withTransaction(async()=>{
  await query('SET TRANSACTION READ ONLY');await query("SET LOCAL statement_timeout='15s'");
  const probes=[];
  for(const filter of [{source:'recommended',recencyMonths:'12'},{source:'planning',recencyMonths:'12',milestone:'Notice of Complete Application Issued'},{source:'permit',recencyMonths:'all',includeMinor:'true',search:'276 PRINCE EDWARD DR S'}]){
   queries=[];const start=performance.now(),list=await repo.listJobsites({...filter,limit:50});
   const pins=await repo.mapJobsites({...filter,zoom:11});
   assert.ok(list.total>0);assert.ok(list.items.every(s=>!s.lead||!s.lead.date||/^\d{4}-\d{2}-\d{2}$/.test(s.lead.date)));
   probes.push({filter,queries,total:list.total,rows:list.items.length,clusters:pins.length,milliseconds:Math.round(performance.now()-start),sample:list.items.slice(0,2).map(s=>({address:s.address,lead:s.lead}))});
  }
  const sources=await query("SELECT jobsite_id FROM field_sales_sources WHERE source='permit' AND data->'raw'->>'PERMIT_NUM'='22 127851 DRN'");
  assert.ok(sources.rows.length);assert.equal((await query("SELECT count(*)::int AS count FROM field_sales_sources WHERE jobsite_id=$1 AND data->'raw'->>'PERMIT_NUM'='22 127851 DRN'",[sources.rows[0].jobsite_id])).rows[0].count,1);
  return {passed:true,readOnly:true,oldSourcePreserved:true,probes};
 });console.log(JSON.stringify(results));
}finally{await closeDb();}
""".replace('MODULE', json.dumps('file:///app/src/field-sales/repository.js' if '--deployed' in sys.argv else module_url('src/field-sales/repository.js')))
result = subprocess.check_output(['sudo', '-n', 'docker', 'exec', '-i', 'mbbs-operator-app-app-1', 'node', '--input-type=module'], input=script.encode(), timeout=70)
parsed = json.loads(result)
folder = SERVER / 'test-artifacts/field-sales/recent'
folder.mkdir(parents=True, exist_ok=True)
(folder / ('city-deployed-probe.json' if '--deployed' in sys.argv else 'city-read-probe.json')).write_text(json.dumps(parsed, indent=2) + '\n')
print(json.dumps(parsed))
