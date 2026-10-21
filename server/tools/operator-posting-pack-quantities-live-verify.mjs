// Read-only operational verification; run through node stdin in the live app.
import assert from 'node:assert/strict';
const root = process.cwd();
const { closeDb } = await import(`${root}/src/db.js`);
const { getDeliveryOrder } = await import(`${root}/src/delivery-repository.js`);
const { assertOperatorOrderYard } = await import(`${root}/src/operator-yard-authorization.js`);
const { resolveOperatorNetSuitePostingTargets } = await import(`${root}/src/operator-netsuite-posting-targets.js`);
const { fetchItemFulfillmentFromNetSuite } = await import(`${root}/src/netsuite.js`);

try {
  const scopes = [];
  const original = await getDeliveryOrder(1053286, { includeNetSuiteClosed: true });
  assert.equal(original.tranid, 'SOA10099');
  for (const [yard, lineId] of [[1, '531490'], [28, '531491']]) {
    const operator = { operatorYardLocationIds: [yard] };
    const order = await assertOperatorOrderYard(operator, 1053286,
      { customerPickup: true, destinationLocationId: yard });
    assert.equal(order.pickup_location_id, yard);
    assert.deepEqual(order.lines.map(line => String(line.id)), [lineId]);
    assert.ok(order.confirmationSummary.missing.every(line => line.id === lineId));
    const resolution = await resolveOperatorNetSuitePostingTargets({ functionKey: 'customer_pickup',
      orderId: 1053286, clientLocationId: yard, deferTargets: true });
    assert.equal(resolution.canonicalLocationId, yard);
    scopes.push({ yard, lines: order.lines.map(line => ({ id: String(line.id), inventoryLocationId: Number(line.location_id) })),
      confirmationTotal: order.confirmationSummary.total, canonicalPostingYard: resolution.canonicalLocationId });
  }
  const record = await fetchItemFulfillmentFromNetSuite(1053555);
  assert.equal(record.tranId, 'IF157565');
  assert.equal(String(record.createdFrom.id), '1053767');
  const line = record.item.items.find(item => Number(item.orderLine) === 1 && Number(item.item.id) === 4756);
  assert.equal(line.quantity, 31.38);
  assert.equal(line.custcol_lyr, 3);
  console.log(JSON.stringify({ at: new Date().toISOString(), SOA10099: scopes,
    SOA10124: { fulfillmentId: Number(record.id), fulfillmentRef: record.tranId,
      quantity: line.quantity, units: line.unitsDisplay, layers: line.custcol_lyr },
    operationalMode: 'read-only' }));
} finally { await closeDb(); }
