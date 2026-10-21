import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { after, before } from 'node:test';
import fc from 'fast-check';
import { closeDb, query, withTransaction } from '../../../src/db.js';
import { createOperator } from '../../../src/auth-repository.js';
import {
  cancelScmPurchaseOrderSplit, createScmPurchaseOrderSplit, listScmSchedule
} from '../../../src/dispatch-repository.js';
import { app } from '../../../src/server.js';

assert.equal(process.env.MBT_TEST_ISOLATED, '1', 'Only run in the disposable test database');
const prefix = `CANCELLED-SCHEDULE-${crypto.randomUUID().slice(0, 8)}`;
const baseId = 8_790_000_000_000 + crypto.randomInt(1_000_000) * 1000;
const sourceRef = `${prefix}-SOURCE`, reusedRef = `${prefix}-REUSED`, retiredRef = `${prefix}-RETIRED`;
const emptyRef = `${prefix}-EMPTY`, completedRef = `${prefix}-COMPLETED`, transferRef = `${prefix}-TO`;
let retired, replaced, active, snapshot, server, baseUrl, token;

async function insertPo(id, ref, activeFlag = true, pallets = 0) {
  await query(`INSERT INTO purchase_orders
    (netsuite_id,tranid,vendor,status,status_text,destination_location_id,destination_location,
     source_location_id,source_location,dispatch_vendor_yard,netsuite_active,initial_scm_status,synced_at)
    VALUES ($1,$2,'Schedule Regression Vendor','B','Purchase Order : Pending Receipt',
      1,'3445',15,'12441','Regression Yard',$3,'Queued',now())`, [id, ref, activeFlag]);
  if (!pallets) return null;
  const result = await query(`INSERT INTO purchase_order_lines
    (purchase_order_id,line_id,item_id,item_name,sku,quantity,unit,pallet_qty,
     to_plt,to_pcs,netsuite_active,item_weight,location_id,location)
    VALUES ($1,1,987654321,'Regression Item','REGRESSION-SKU',$2*10,'EA',$2,10,1,true,2,1,'3445')
    RETURNING id`, [id, pallets]);
  return result.rows[0].id;
}

async function history() {
  const result = await query(`SELECT json_build_object(
    'orders',(SELECT json_agg(p ORDER BY p.netsuite_id) FROM purchase_orders p WHERE p.tranid LIKE $1),
    'lines',(SELECT json_agg(l ORDER BY l.id) FROM purchase_order_lines l JOIN purchase_orders p ON p.netsuite_id=l.purchase_order_id WHERE p.tranid LIKE $1),
    'splits',(SELECT json_agg(s ORDER BY s.id) FROM dispatch_scm_po_splits s WHERE s.source_po_ref=$2),
    'splitLines',(SELECT json_agg(l ORDER BY l.id) FROM dispatch_scm_po_split_lines l JOIN dispatch_scm_po_splits s ON s.id=l.split_id WHERE s.source_po_ref=$2),
    'events',(SELECT json_agg(e ORDER BY e.id) FROM dispatch_scm_po_split_change_events e JOIN dispatch_scm_po_splits s ON s.id=e.split_id WHERE s.source_po_ref=$2),
    'schedule',(SELECT json_agg(s ORDER BY s.id) FROM scm_transport_schedule s WHERE s.order_ref LIKE $1)
  ) AS snapshot`, [`${prefix}%`, sourceRef]);
  return result.rows[0].snapshot;
}

before(async () => {
  const line = await insertPo(baseId, sourceRef, true, 30);
  async function split(ref, pallets) {
    return createScmPurchaseOrderSplit({ sourcePoRef: sourceRef, newPoRef: ref,
      destinationLocationId: 1, lines: [{ lineRowId: line, pallets }], createdBy: 'cancelled-schedule-test' });
  }
  retired = await split(retiredRef, 4);
  await cancelScmPurchaseOrderSplit({ splitPoRef: retiredRef, cancelledBy: 'cancelled-schedule-test' });
  replaced = await split(reusedRef, 4);
  await cancelScmPurchaseOrderSplit({ splitPoRef: reusedRef, cancelledBy: 'cancelled-schedule-test' });
  active = await split(reusedRef, 5);
  await insertPo(baseId + 1, emptyRef);
  await insertPo(baseId + 2, completedRef, false);
  await query(`INSERT INTO scm_transport_schedule (order_kind,order_ref,status)
    VALUES ('PO',$1,'Completed')`, [completedRef]);
  await query(`UPDATE scm_transport_schedule SET status='Completed' WHERE order_kind='PO' AND order_ref=$1`, [retiredRef]);
  await query(`INSERT INTO transfer_orders
    (netsuite_id,tranid,status,status_text,from_location_id,from_location,to_location_id,to_location,netsuite_active)
    VALUES ($1,$2,'B','Transfer Order : Pending Fulfillment',28,'2967',1,'3445',true)`, [baseId + 3, transferRef]);
  const password = crypto.randomUUID();
  await createOperator({ username: prefix, displayName: prefix, password, role: 'scm', roles: ['scm'] });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: prefix, password }) });
  assert.equal(login.status, 200);
  token = (await login.json()).token;
  snapshot = await history();
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await closeDb();
});

function assertReplacement(rows) {
  assert.equal(rows.length, 1, 'Exactly one current row must survive reference reuse');
  assert.equal(String(rows[0].sourceId), String(active.split.splitPoId));
  assert.equal(rows[0].sourceRef, sourceRef);
  assert.equal(rows[0].orderRef, reusedRef);
  assert.equal(rows[0].totalPalletQty, 5);
  assert.equal(rows[0].weightLbs, 100);
  assert.equal(rows[0].content, 'REGRESSION-SKU 5 PLT');
}

test('reference reuse hides the cancelled lifecycle and preserves the active replacement', async () => {
  assertReplacement(await listScmSchedule({ search: reusedRef.toLowerCase() }));
});

for (const [label, options] of [
  ['global search', { search: retiredRef }],
  ['completed search', { search: retiredRef, view: 'completed' }],
  ['completed filter', { exactRef: retiredRef, status: 'Completed' }],
  ['completed view', { exactRef: retiredRef, view: 'completed' }],
  ['exact-reference batch', { exactRefs: [retiredRef] }],
  ['status projection', { exactRefs: [retiredRef], statusProjectionOnly: true }]
]) {
  test(`a cancelled split with no replacement stays absent from ${label}`, async () => {
    assert.deepEqual(await listScmSchedule(options), []);
  });
}

test('source, active split, empty purchase order and transfer order remain visible', async () => {
  const rows = await listScmSchedule({ orderSearch: prefix });
  assert.deepEqual(rows.map(row => row.orderRef).sort(), [sourceRef, reusedRef, emptyRef, transferRef].sort());
  assert.equal(rows.find(row => row.orderRef === sourceRef).totalPalletQty, 25);
  assert.equal(rows.find(row => row.orderRef === emptyRef).content, '');
});

test('ordinary inactive completed purchase orders remain searchable and visible in history', async () => {
  for (const options of [{ search: completedRef }, { exactRef: completedRef, view: 'completed' }]) {
    const rows = await listScmSchedule(options);
    assert.equal(rows.length, 1);
    assert.equal(String(rows[0].sourceId), String(baseId + 2));
    assert.equal(rows[0].status, 'Completed');
  }
});

test('authenticated schedule HTTP search returns the replacement and denies anonymous access', async () => {
  for (const suffix of ['', '&view=completed', '&view=dispatch']) {
    const response = await fetch(`${baseUrl}/api/scm/schedule?search=${reusedRef}${suffix}`,
      { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    assertReplacement(await response.json());
  }
  assert.equal((await fetch(`${baseUrl}/api/scm/schedule?search=${reusedRef}`)).status, 401);
});

test('multiple cancelled lifecycles never hide their active replacement despite stale flags', async () => {
  let sequence = 0;
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 1, max: 4 }), fc.boolean(), fc.integer({ min: 1, max: 20 }),
    async (retiredCount, staleActive, pallets) => {
      const offset = 100 + sequence++ * 10;
      const ref = `${prefix}-PROPERTY-${offset}`;
      await withTransaction(async () => {
        const expectedId = baseId + offset;
        for (let index = retiredCount; index >= 0; index--) {
          const id = expectedId + index;
          await insertPo(id, ref, index === 0 || staleActive, pallets);
          await query(`INSERT INTO dispatch_scm_po_splits
            (source_po_id,source_po_ref,split_po_id,split_po_ref,status,cancelled_at)
            VALUES ($1,$2,$3,$4,$5,CASE WHEN $5='cancelled' THEN now() ELSE NULL END)`,
          [baseId, sourceRef, id, ref, index === 0 ? 'active' : 'cancelled']);
        }
        const rows = await listScmSchedule({ search: ref.toLowerCase() });
        assert.equal(rows.length, 1);
        assert.equal(String(rows[0].sourceId), String(expectedId));
        assert.equal(rows[0].totalPalletQty, pallets);
        assert.equal(rows[0].content, `REGRESSION-SKU ${pallets} PLT`);
      }, { rollback: true });
    }
  ), { seed: 1400761, numRuns: 16, endOnFailure: true });
});

test('schedule reads retain the original records and cancellation history', async () => {
  await listScmSchedule({ search: prefix });
  assert.deepEqual(await history(), snapshot);
  assert.notEqual(retired.split.splitPoId, active.split.splitPoId);
  assert.notEqual(replaced.split.splitPoId, active.split.splitPoId);
});
