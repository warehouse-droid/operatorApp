// Operational read-only inspection; execute through node stdin in the live app.
import assert from 'node:assert/strict';
const root = process.cwd();
const { query, closeDb } = await import(`${root}/src/db.js`);
const { findCustomerPickupOrder, getDeliveryOrder } = await import(`${root}/src/delivery-repository.js`);
const { assertOperatorOrderYard } = await import(`${root}/src/operator-yard-authorization.js`);
try {
  const row = (await query(`SELECT id,role,roles,operator_yard_location_ids,active,
    (SELECT max(last_seen_at) FROM operator_sessions WHERE operator_id=operators.id AND expires_at>now()) AS last_seen
    FROM operators WHERE username='qin'`)).rows[0];
  assert.equal(row.active, true);
  assert.deepEqual(row.operator_yard_location_ids, [1, 15]);
  const operator = { id: row.id, role: row.role, roles: row.roles,
    operatorYardLocationIds: row.operator_yard_location_ids };
  const results = [];
  for (const [code, own] of [['SOA10099', '531490'], ['SOA10159', '532526']]) {
    const id = await findCustomerPickupOrder(code, { locationId: 1 });
    assert.ok(id);
    const full = await getDeliveryOrder(id, { includeNetSuiteClosed: true });
    const detail = await assertOperatorOrderYard(operator, id,
      { customerPickup: true, destinationLocationId: 1 });
    assert.equal(detail.tranid, code);
    assert.equal(Number(detail.order_location_id), 28);
    assert.deepEqual(detail.lines.map(line => String(line.id)), [own]);
    assert.equal(detail.pickup_location_id, 1);
    await assert.rejects(assertOperatorOrderYard(operator, id,
      { customerPickup: true, destinationLocationId: 28 }), { status: 403, code: 'OPERATOR_YARD_FORBIDDEN' });
    results.push({ ref: code, orderId: id, placedAt: '2967', selectedYard: '3445',
      fullLineCount: full.lines.length, visibleLineIds: detail.lines.map(line => String(line.id)),
      otherYardDenied: true });
  }
  console.log(JSON.stringify({ at: new Date().toISOString(), mode: 'operational-read-only',
    operator: 'qin', grants: row.operator_yard_location_ids, lastSessionActivity: row.last_seen, orders: results }));
} finally { await closeDb(); }
