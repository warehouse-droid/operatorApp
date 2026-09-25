"""Retire only proven-obsolete TOB00025 ID 777039; default is a full rollback rehearsal."""
import argparse
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--apply', action='store_true')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
sql = (root / 'tools/retire-obsolete-operator-to.sql').read_text()
script = r'''
import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from './src/db.js';
import {fetchTransferOrderByIdFromNetSuite} from './src/netsuite.js';
import {listDeliveryOrders} from './src/delivery-repository.js';
try {
  const obsolete = await fetchTransferOrderByIdFromNetSuite(777039);
  const canonical = await fetchTransferOrderByIdFromNetSuite(799386);
  assert.equal(obsolete, null, 'Obsolete ID is present in NetSuite; stop');
  assert.equal(String(canonical?.id), '799386');
  assert.equal(canonical.tranid, 'TOB00025');
  assert.equal(canonical.status, 'G');
  const verifiedAt = new Date().toISOString();
  const result = await withTransaction(async () => {
    await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const before = await listDeliveryOrders({orderType:'transfer_order',status:'active'});
    await query(repairSql);
    const after = await listDeliveryOrders({orderType:'transfer_order',status:'active'});
    assert.deepEqual(after.map(o=>o.netsuite_id).sort(),
      before.filter(o=>String(o.netsuite_id)!=='777039').map(o=>o.netsuite_id).sort());
    assert.ok(!after.some(o=>o.tranid==='TOB00025'));
    const row = (await query("SELECT netsuite_id,tranid,netsuite_active,fulfillment_status,receiving_status FROM transfer_orders WHERE netsuite_id=799386")).rows[0];
    assert.equal(row.netsuite_active,true);
    assert.equal(row.fulfillment_status,'fulfilled');
    assert.equal(row.receiving_status,'received');
    return {applied:apply,verifiedAt,obsoleteNetSuiteIdAbsent:true,canonical:row,
      activeBefore:before.length,activeAfter:after.length,otherActiveOrdersUnchanged:true};
  }, {rollback:!apply});
  console.log(JSON.stringify(result));
} finally { await closeDb(); }
'''
source = 'const repairSql = ' + json.dumps(sql) + ';\nconst apply = ' + json.dumps(args.apply) + ';\n' + script
result = subprocess.run(['sudo','-n','docker','exec','-i','mbbs-operator-app-app-1',
                         'node','--input-type=module'], input=source, text=True, capture_output=True)
artifact = root / 'test-artifacts/obsolete-operator-to-20260918'
artifact.mkdir(parents=True, exist_ok=True)
(artifact / ('apply.log' if args.apply else 'feed-rehearsal.log')).write_text(result.stdout + result.stderr)
print(result.stdout + result.stderr, end='')
raise SystemExit(result.returncode)
