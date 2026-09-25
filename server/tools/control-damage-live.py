"""Read-only candidate probe: inspect UOM metadata and verify original cleanup."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
SERVER=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('control_release',SERVER/'tools/control-damage-deploy.py')
release=importlib.util.module_from_spec(spec);spec.loader.exec_module(release)
core=release.core
state=json.loads(core.docker('inspect',core.APP))[0]
network=next(iter(state['NetworkSettings']['Networks']))
image=core.IMAGE if '--candidate' in sys.argv else state['Image']
script="""import assert from 'node:assert/strict';
import {fetchInventoryItemUnitsFromNetSuite} from './netsuite.js';
import {damageNetSuite} from './inventory-damage-netsuite.js';
import {pool,query} from './db.js';
try {
 const units=await fetchInventoryItemUnitsFromNetSuite(5020);assert.ok(units.some(unit=>unit.label.toUpperCase()==='SQFT'));
 const record=await damageNetSuite.get(998187);assert.equal(record.tranId,'IT00551');
 assert.equal(record.location.id,'1');assert.equal(record.transferLocation.id,'10');
 assert.ok(record.inventory.items.every(line=>String(line.item?.id)!=='5020'));
 const id='c419bbbe-fde7-4263-b97a-d3cf44449c44';
 for(const [table,column] of [['inventory_damage_reports','id'],['inventory_damage_photos','report_id'],['inventory_damage_events','report_id']])
  assert.equal(Number((await query(`SELECT count(*) FROM ${table} WHERE ${column}=$1`,[id])).rows[0].count),0);
 let controlReview;
 if(CHECK_REVIEW) {
  const {reviewControlDamageMonth}=await import('./control-damage-review.js');
  const review=await reviewControlDamageMonth({id:'read-only-probe',role:'admin',roles:['admin']},1,'2026-09');
  assert.equal(review.syncError,null);assert.ok(review.transfers.some(row=>row.id==='998187'));
  assert.ok(review.reports.every(row=>row.id!==id));
  controlReview={transfers:review.transfers.length,lines:review.transfers.flatMap(row=>row.lines).length,removedReportAbsent:true};
 }
 console.log(JSON.stringify({units,transfer:record.tranId,lineCount:record.inventory.items.length,originalReportRemoved:true,controlReview,netSuiteWrites:0}));
} finally {await pool.end();}""".replace('CHECK_REVIEW','true' if '--review' in sys.argv else 'false')
with tempfile.NamedTemporaryFile(mode='w',dir=core.RELEASE,prefix='.read-probe-env-',delete=True) as env:
 os.chmod(env.name,0o600)
 for entry in state['Config']['Env']:
  assert '\n' not in entry
  env.write(entry+'\n')
 env.flush()
 output=core.docker('run','--rm','-i','--network',network,'--volumes-from',core.APP+':ro','--env-file',env.name,'-w','/app/src','--entrypoint','node',image,'--input-type=module','-',input=script.encode())
 result=json.loads(output)
 core.save('read-only-candidate-probe.json',result)
 print(json.dumps(result))
