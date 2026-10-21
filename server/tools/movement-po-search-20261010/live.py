"""Read-only production verification; keep only PO identities and movement counts."""
import json
from pathlib import Path
import subprocess
import sys

OUT = Path(__file__).resolve().parents[2] / 'test-artifacts/movement-po-search-20261010'
phase = sys.argv[1]
assert phase in ['before', 'after']
source = """import {query,closeDb} from './src/db.js';import {listYardMovements} from './src/yard-movement-repository.js';
const refs=['POB04006','POB03810'], result=[];
try{for(const parent of refs){
 const children=(await query(`SELECT split.split_po_id,split.split_po_ref
   FROM dispatch_scm_po_splits split
   WHERE split.source_po_ref=$1 AND (EXISTS(SELECT 1 FROM receiving_receipt_records r WHERE r.order_id=split.split_po_id AND r.receipt_status<>'failed')
     OR EXISTS(SELECT 1 FROM driver_job_records r WHERE r.status IN ('complete','in_progress') AND r.order_refs @> to_jsonb(ARRAY[split.split_po_ref])))`,[parent])).rows;
 // Historical ledger IDs can share a reference. Driver records resolve to one
 // order in the history repository; matching that reference alone does not
 // establish that every old ledger ID has a displayed movement record.
 const recorded=new Map(), childIds=new Set(children.map(r=>String(r.split_po_id)));
 for(const ref of new Set(children.map(r=>r.split_po_ref))){
   const history=await listYardMovements({search:ref,from:'2000-01-01',to:'2099-12-31'});
   for(const row of history.filter(r=>r.order_type==='purchase_order'&&childIds.has(String(r.order_id)))){
     recorded.set(`${row.direction}:${row.order_id}`,{id:row.order_id,ref:row.tranid,direction:row.direction,records:row.process_count,driverRecords:row.driver_record_count,photos:row.photo_count});
   }
 }
 const found=await listYardMovements({search:parent,from:'2000-01-01',to:'2099-12-31'});
 const matches=found.filter(r=>r.order_type==='purchase_order');
 result.push({parent,ledgerChildren:children.map(r=>({id:r.split_po_id,ref:r.split_po_ref})),recordedChildren:[...recorded.values()],matches:matches.map(r=>({id:r.order_id,ref:r.tranid,direction:r.direction,records:r.process_count,driverRecords:r.driver_record_count,photos:r.photo_count}))});
}console.log(JSON.stringify({applicationWrites:0,netSuiteWrites:0,orders:result}));}finally{await closeDb();}"""
result = subprocess.run(['sudo','-n','docker','exec','-i','-w','/app','mbbs-operator-app-app-1','node','--input-type=module'], input=source, text=True, capture_output=True)
if result.returncode:
    print(result.stderr[-3000:])
    raise SystemExit(result.returncode)
data = json.loads(result.stdout)
(OUT / f'live-{phase}.json').write_text(json.dumps(data, indent=2) + '\n')
if phase == 'after':
    for entry in data['orders']:
        assert entry['recordedChildren'], 'Expected real child movement history for this PO'
        actual = {(r['direction'], str(r['id'])): r for r in entry['matches']}
        assert len(actual) == len(entry['matches']), 'Duplicate parent search results'
        for child in entry['recordedChildren']:
            assert actual[(child['direction'], str(child['id']))] == child, 'Child movement evidence changed under parent search'
print(json.dumps({'phase': phase, 'applicationWrites':0, 'netSuiteWrites':0, 'orders': [{'parent': e['parent'], 'recordedChildren':len(e['recordedChildren']), 'searchMatches':len(e['matches'])} for e in data['orders']]}))
