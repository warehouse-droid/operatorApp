import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { app } from '../../../src/server.js';
import { createOperator, loginOperator } from '../../../src/auth-repository.js';
import { query, closeDb, withTransaction, pool } from '../../../src/db.js';
import { assertOperatorOrderPhotoYard } from '../../../src/operator-yard-authorization.js';
import { recordCustomerPickupLoad, getDeliveryOrder } from '../../../src/delivery-repository.js';
import { finalizeOperatorNetSuitePosting } from '../../../src/operator-netsuite-posting-finalizer.js';
import { seedOperatorPickup } from '../../support/operator-ui-enhancements-fixture.mjs';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'espree';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createOperatorNetSuitePostingAdmission } from '../../../src/operator-netsuite-posting-admission.js';
import { createOperatorNetSuitePostingTargetResolver } from '../../../src/operator-netsuite-posting-targets.js';
import { createOrReplayOperatorNetSuitePostingCommand } from '../../../src/operator-netsuite-posting-repository.js';

let server, base, yard2967, both;
before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  for (const [name, grants] of [['2967', [28]], ['both', [1, 28]]]) {
    const username = `pickup-yards-${name}-${randomUUID()}`, password = randomUUID();
    await createOperator({ username, password, displayName: 'Pickup yards test', role: 'operator', operatorYardLocationIds: grants });
    const session = await loginOperator(username, password);
    if (name === '2967') { yard2967 = session; } else { both = session; }
  }
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) { await new Promise(resolve => server.close(resolve)); }
  await closeDb();
});
async function fixture() {
  const f = await seedOperatorPickup({ quantity: 20 });
  const row = (await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,netsuite_order_line,item_id,item_name,item_type,
    quantity,unit,location_id,location,layer_qty,to_lyr,packed_layer_qty,netsuite_active,confirmed,confirmed_at)
    VALUES($1,2,2,889202,'2967 Item','InvtPart',55.98,'SQFT',28,'2967',6,9.33,6,true,true,now()) RETURNING id`, [f.orderId])).rows[0];
  return { ...f, foreignLineId: String(row.id) };
}
async function request(session, path, body, method = 'POST') {
  const response = await fetch(`${base}${path}`, { method,
    headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: response.headers.get('content-type')?.includes('application/json')
    ? await response.json() : await response.text() };
}
async function state(id) {
  return (await query(`SELECT id::text,loaded_qty,packed_piece_qty,packed_layer_qty,confirmed,confirmed_at
    FROM sales_order_lines WHERE sales_order_id=$1 ORDER BY sales_order_lines.id`, [id])).rows;
}
const ownIds = order => order.lines.map(line => String(line.id));

test('E9 lookup of one mixed-yard SO returns only selected-yard lines for single or multiple grants', async () => {
  const f = await fixture();
  for (const [session, yard, expected] of [[f, 1, f.lineId], [both, 1, f.lineId], [yard2967, 28, f.foreignLineId], [both, 28, f.foreignLineId]]) {
    const result = await request(session, '/api/customer-pickup/lookup', { code: f.tranid, locationId: yard });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.deepEqual(ownIds(result.data), [expected]);
    assert.equal(result.data.pickup_location_id, yard);
    assert.equal(result.data.confirmationSummary.total, 1);
    assert.ok(result.data.confirmationSummary.missing.every(line => line.id === expected));
  }
  assert.equal(Number((await getDeliveryOrder(f.orderId)).outbound_location_id), 1);
});

test('E12 pickup load-screen refresh returns only its own line and confirmation summary', async () => {
  const f = await fixture();
  for (const [session, yard, own] of [[f, 1, f.lineId], [yard2967, 28, f.foreignLineId]]) {
    const refreshed = await request(session, `/api/customer-pickup/orders/${f.orderId}?locationId=${yard}`, undefined, 'GET');
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.data));
    assert.deepEqual(ownIds(refreshed.data), [own]);
    assert.equal(refreshed.data.confirmationSummary.total, 1);
    assert.ok(refreshed.data.confirmationSummary.missing.every(line => line.id === own));
  }
});

test('E12 pickup detail rejects non-pickup and closed orders', async () => {
  const f = await fixture(), path = `/api/customer-pickup/orders/${f.orderId}?locationId=1`;
  await query("UPDATE sales_orders SET sales_order_type='Delivery' WHERE netsuite_id=$1", [f.orderId]);
  assert.equal((await request(f, path, undefined, 'GET')).status, 409);
  await query("UPDATE sales_orders SET sales_order_type='Pick-Up',status='C',status_text='Closed' WHERE netsuite_id=$1", [f.orderId]);
  assert.equal((await request(f, path, undefined, 'GET')).status, 404);
});

test('E12 refresh reports a database failure after authorization without changing either draft', async () => {
  const f = await fixture(), original = await state(f.orderId), nativeQuery = pool.query;
  let detailReads = 0;
  pool.query = function (sql, ...args) {
    if (typeof sql === 'string' && sql.includes('WITH delivery_order_source') && ++detailReads === 2) {
      return Promise.reject(Object.assign(new Error('Test-only pickup detail unavailable'), { status: 503 }));
    }
    return nativeQuery.call(this, sql, ...args);
  };
  try {
    const result = await request(f, `/api/customer-pickup/orders/${f.orderId}?locationId=1`, undefined, 'GET');
    assert.equal(result.status, 503);
    assert.match(result.data.error, /pickup detail unavailable/u);
  } finally { pool.query = nativeQuery; }
  assert.deepEqual(await state(f.orderId), original);
});

test('E9 ordinary delivery photos retain the original whole-order yard check', async () => {
  const f = await fixture();
  const reference = `r2://operator/operator-load-photo/2026/10/10/${f.tranid}/load.jpg`;
  await assertOperatorOrderPhotoYard(both.operator, reference);
  await assert.rejects(assertOperatorOrderPhotoYard(f.operator, reference), { status: 403, code: 'OPERATOR_YARD_FORBIDDEN' });
});

test('E10 confirmation response stays scoped; forged single and bulk line IDs cannot write either yard', async () => {
  const f = await fixture(), path = `/api/customer-pickup/orders/${f.orderId}/lines`;
  const original = await state(f.orderId);
  assert.equal((await request(both, `${path}/${f.foreignLineId}/confirm`, { locationId: 1, layers: 1 })).status, 403);
  assert.equal((await request(both, `${path}/confirm-page`, { locationId: 1,
    lines: [{ lineId: f.lineId, pieces: 2 }, { lineId: f.foreignLineId, layers: 1 }] })).status, 403);
  assert.deepEqual(await state(f.orderId), original);
  const confirmed = await request(f, `${path}/${f.lineId}/confirm`, { locationId: 1, pieces: 2, quantityMode: 'absolute' });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
  assert.deepEqual(ownIds(confirmed.data), [f.lineId]);
  const page = await request(f, `${path}/confirm-page`, { locationId: 1, lines: [{ lineId: f.lineId, pieces: 3, quantityMode: 'absolute' }] });
  assert.equal(page.status, 200, JSON.stringify(page.data));
  assert.deepEqual(ownIds(page.data.order), [f.lineId]);
  assert.deepEqual((await state(f.orderId))[1], original[1]);
});

test('E10 clearing the 3445 draft leaves the 2967 confirmation and quantities intact', async () => {
  const f = await fixture();
  await query('UPDATE sales_order_lines SET packed_piece_qty=2,confirmed=true WHERE id=$1', [f.lineId]);
  const original = await state(f.orderId);
  const cleared = await request(both, `/api/customer-pickup/orders/${f.orderId}/clear-draft`, { locationId: 1 });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.data));
  assert.deepEqual(ownIds(cleared.data), [f.lineId]);
  assert.equal(Number((await state(f.orderId))[0].packed_piece_qty), 0);
  assert.deepEqual((await state(f.orderId))[1], original[1]);
});

test('E10 local load uses only 3445 lines, preserves the other draft, and records global partial status', async () => {
  const f = await fixture();
  await query('UPDATE sales_order_lines SET packed_piece_qty=20,confirmed=true WHERE id=$1', [f.lineId]);
  const original = await state(f.orderId);
  const loaded = await recordCustomerPickupLoad(f.orderId, f.operator.id,
    { locationId: 1, photoDataUrls: ['data:image/png;base64,dGVzdA=='] });
  assert.equal(loaded.loaded.salesQuantity, 20);
  assert.equal(loaded.pickupStatus, 'partial_loaded');
  assert.equal(Number((await state(f.orderId))[0].loaded_qty), 20);
  assert.deepEqual((await state(f.orderId))[1], original[1]);
  const record = (await query('SELECT response,line_snapshot FROM operator_load_records WHERE id=$1', [loaded.id])).rows[0];
  assert.equal(record.response.pickupLocationId, 1);
  assert.deepEqual(record.line_snapshot.map(line => Number(line.lineId)), [1]);
});

test('E11 durable finalizer uses its canonical yard and a later 2967 pickup completes the same SO', async () => {
  const f = await fixture();
  await query('UPDATE sales_order_lines SET packed_piece_qty=20,confirmed=true WHERE id=$1', [f.lineId]);
  const original = await state(f.orderId);
  const command = { id: randomUUID(), requestId: randomUUID(), functionKey: 'customer_pickup', actorOperatorId: f.operator.id,
    canonicalLocationId: 1, transactionType: 'IF', photoRefs: ['data:image/png;base64,dGVzdA=='], inputSnapshot: {
      localOperation: { kind: 'customer_pickup_load', orderId: f.orderId, orderType: 'sales_order' } }, steps: [] };
  const loaded = await finalizeOperatorNetSuitePosting(command);
  assert.equal(loaded.loaded.salesQuantity, 20);
  assert.deepEqual((await state(f.orderId))[1], original[1]);
  const later = await recordCustomerPickupLoad(f.orderId, yard2967.operator.id,
    { locationId: 28, photoDataUrls: ['data:image/png;base64,dGVzdA=='] });
  assert.equal(later.loaded.salesQuantity, 55.98);
  assert.equal(later.pickupStatus, 'loaded');
  const records = (await query('SELECT response,line_snapshot FROM operator_load_records WHERE order_id=$1 ORDER BY id', [f.orderId])).rows;
  assert.deepEqual(records.map(row => row.response.pickupLocationId), [1, 28]);
  assert.deepEqual(records.map(row => row.line_snapshot.map(line => Number(line.lineId))), [[1], [2]]);
});

test('E10 HTTP local load carries the selected yard through the actual load route', async () => {
  const f = await fixture();
  await query('UPDATE sales_order_lines SET packed_piece_qty=20,confirmed=true WHERE id=$1', [f.lineId]);
  const original = await state(f.orderId);
  const result = await request(f, `/api/customer-pickup/orders/${f.orderId}/load`,
    { locationId: 1, requestId: randomUUID(), photoDataUrls: ['data:image/png;base64,dGVzdA=='] });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.loaded.salesQuantity, 20);
  assert.deepEqual((await state(f.orderId))[1], original[1]);
});

test('E11 gated preflight validates only its canonical yard and rolls back all rehearsal mutations', async () => {
  const f = await fixture();
  await query('UPDATE sales_order_lines SET packed_piece_qty=20,confirmed=true,netsuite_order_line=1 WHERE id=$1', [f.lineId]);
  await query('UPDATE sales_order_lines SET packed_layer_qty=9999 WHERE id=$1', [f.foreignLineId]);
  const original = await state(f.orderId);
  // Execute the exact private controller boundary, retaining its filename and
  // line numbers for coverage, with the real DB/rollback and pickup repository.
  const filename = 'src/operator-netsuite-posting-controller.js', source = readFileSync(filename, 'utf8');
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module', range: true });
  const node = tree.body.find(item => item.type === 'FunctionDeclaration' && item.id.name === 'preflightExistingLocalCompletion');
  const context = vm.createContext({ withTransaction, recordCustomerPickupLoad });
  vm.runInContext(source.slice(0, node.start).replace(/[^\n]/gu, ' ') + source.slice(node.start, node.end), context,
    { filename: pathToFileURL(resolvePath(filename)).href });
  const resolveTargets = createOperatorNetSuitePostingTargetResolver({ getDeliveryOrder, getReceivableReceivingOrder: async () => null,
    resolveRealSource: async () => ({ sourceOrderKind: 'SO', sourceNetSuiteId: Number(f.orderId), sourceOrderRef: f.tranid,
      postingStrategy: 'stored_order_line_v1', availableLines: [{ orderLine: 1, sourceLineKey: '1', itemId: 889201,
        salesUom: 'PC', location: 1, orderedQuantity: 20, completedQuantity: 0, remainingQuantity: 20 },
      { orderLine: 2, sourceLineKey: '2', itemId: 889202, salesUom: 'SQFT', location: 28,
        orderedQuantity: 55.98, completedQuantity: 0, remainingQuantity: 55.98 }] }) });
  const policy = { effective: true, revision: 1, functionKey: 'customer_pickup', transactionType: 'IF',
    locationId: 1, yardCode: '3445', gateKey: 'operator_netsuite_customer_pickup_if_3445' };
  const admit = createOperatorNetSuitePostingAdmission({ resolveTargets, getPolicy: async () => policy,
    createCommand: createOrReplayOperatorNetSuitePostingCommand, preflight: context.preflightExistingLocalCompletion, onAccepted: async () => {} });
  const accepted = await admit({ functionKey: 'customer_pickup', orderId: f.orderId, clientLocationId: 1,
    actorOperatorId: f.operator.id, requestId: randomUUID(), photoRefs: ['data:image/png;base64,dGVzdA=='], expectedPolicy: policy });
  assert.equal(accepted.command.canonicalLocationId, 1);
  assert.equal(accepted.command.steps[0].payload.item.items.find(line => line.orderLine === 1).custcol_pcs, 20);
  assert.equal(accepted.command.steps[0].payload.item.items.find(line => line.orderLine === 2).itemReceive, false);
  assert.deepEqual(await state(f.orderId), original);
  assert.equal((await query('SELECT 1 FROM operator_load_records WHERE order_id=$1', [f.orderId])).rowCount, 0);
});
