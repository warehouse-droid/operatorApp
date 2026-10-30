#!/usr/bin/env python3
"""Guarded, audited withdrawal of the user's unrequested BIN00003C draft."""
import hashlib,json,runpy
from pathlib import Path

base=runpy.run_path(str(Path(__file__).with_name('bin-selection-release.py')))
out=base['SERVER']/'deployments/bin-collection-request-20261023'
expected=json.loads((out/'deployment.json').read_text())
assert base['metadata'](base['APP'])['imageId']==expected['imageId'],'Application changed; review before repair'
source=(base['SERVER']/'tools/bin-withdraw-automatic-collection.mjs').read_text()
input_data={'actor':{'operatorId':'codex-user-request-20261023','roles':['admin']},
 'idempotencyKey':'withdraw-unrequested-BIN00003C-20261023','correlationId':'withdraw-unrequested-BIN00003C-20261023',
 'requestId':'withdraw-unrequested-BIN00003C-20261023','orderId':'c5b75b79-2724-4ebd-8ae5-a06a5ab0043d','reference':'BIN00003C'}
script=source.replace("'../src/","'/app/src/")+"\n"+"""
import assert from 'node:assert/strict';
import {closeDb} from '/app/src/db.js';
import {getFrontdeskContractTimeline} from '/app/src/mbt/frontdesk-service.js';
const command=COMMAND;
try {
  const line=(await query('SELECT * FROM mbt_contract_service_lines WHERE service_line_id=$1',
    ['975b7340-58b5-40cd-b0d7-dcb5c861143a'])).rows[0];
  assert.ok(line);
  const before=await getFrontdeskContractTimeline({contractId:line.contract_id,actor:command.actor});
  const result=await withdrawAutomaticCollection(command);
  const after=await getFrontdeskContractTimeline({contractId:line.contract_id,actor:command.actor});
  const logical=after.visits.filter(v=>!v.parentOrderId);
  assert.ok(!logical.some(v=>v.visitId===command.orderId));
  assert.equal(logical.filter(v=>v.displayReference==='BIN00003D').length,1);
  assert.equal(after.serviceLines.find(l=>l.serviceLineId===line.service_line_id).plannedReturnAt,
    before.serviceLines.find(l=>l.serviceLineId===line.service_line_id).plannedReturnAt);
  const preserved=(await query('SELECT status,service_snapshot,predecessor_visit_id FROM mbt_service_visits WHERE service_visit_id=$1',[command.orderId])).rows[0];
  assert.equal(preserved.status,'cancelled');
  assert.equal(preserved.service_snapshot.withdrawnAutomaticCollection,true);
  console.log(JSON.stringify({result,before,after,preserved}));
} finally {await closeDb();}
""".replace('COMMAND',json.dumps(input_data))
backup=out/'bin00003-before-repair.json'
if not backup.exists():
    sql="""SELECT json_build_object('orders',(SELECT json_agg(o) FROM mbt_bin_orders o WHERE service_line_id='975b7340-58b5-40cd-b0d7-dcb5c861143a'),
      'visits',(SELECT json_agg(v) FROM mbt_service_visits v WHERE service_line_id='975b7340-58b5-40cd-b0d7-dcb5c861143a'),
      'line',(SELECT row_to_json(l) FROM mbt_contract_service_lines l WHERE service_line_id='975b7340-58b5-40cd-b0d7-dcb5c861143a'));"""
    base['save'](backup,json.loads(base['db'](sql)))
result=json.loads(base['docker']('exec','-i',base['APP'],'node','--input-type=module',data=script.encode()))
record={'sourceSha256':hashlib.sha256(source.encode()).hexdigest(),'command':input_data,**result}
base['save'](out/'bin00003-repair-audit.json',record)
print(json.dumps({'withdrawn':result['result']['body']['reference'],'deliveryRetained':True,'expectedReturnRetained':True,
 'logicalOrders':[v['displayReference'] for v in result['after']['visits'] if not v['parentOrderId']]}))
