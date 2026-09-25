import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchOperatorNetSuiteKitEvidenceFromNetSuite } from '../../../src/netsuite.js';
import { createOperatorNetSuitePostingRealSourceResolver, createOperatorNetSuitePostingTargetResolver } from '../../../src/operator-netsuite-posting-targets.js';
import { normalizeOperatorKitSource } from '../../../src/operator-netsuite-posting-kits.js';
import { fetchOperatorKitSource } from '../../../src/operator-netsuite-posting-kit-source.js';
import { kitFixture, sobFixture } from '../../support/operator-kit-fixture.mjs';
import { kitRemote, kitServiceHarness } from '../../support/operator-kit-service-fixture.mjs';

test('kit reader uses validated source ID, exact SuiteQL relationship and GET kit definitions', async () => {
  const fixture = sobFixture(); const calls = [];
  const dependencies = {
    queryAll: async sql => { calls.push(sql); return fixture.evidence.sourceRows; },
    rest: async (path, options) => {
      calls.push([path, options]);
      assert.equal(options.method, 'GET');
      return { data: path.includes('/salesOrder/') ? { item: { items: fixture.evidence.sourceItems } } : fixture.evidence.kitDefinitions[0] };
    }
  };
  assert.deepEqual(await fetchOperatorNetSuiteKitEvidenceFromNetSuite(997764, dependencies), fixture.evidence);
  assert.ok(calls.some(call => typeof call === 'string' && /tl\.kitmemberof/u.test(call) && /tl\.transaction = 997764/u.test(call)));
  assert.ok(calls.some(call => Array.isArray(call) && call[0] === '/record/v1/kitItem/10126?expandSubResources=true'));
  for (const invalid of ['997764 OR 1=1', 0, -1, 1.5]) {
    const before = calls.length;
    await assert.rejects(fetchOperatorNetSuiteKitEvidenceFromNetSuite(invalid, dependencies), /valid|positive/iu);
    assert.equal(calls.length, before);
  }
});

test('database source resolution detects Kit rows and maps selected physical lines to the live parent', async () => {
  const f = sobFixture(); const calls = [];
  const order = { netsuite_id: 997764, tranid: 'SOB120656', order_type: 'sales_order',
    delivery_method: 'Pick-Up', outbound_location_id: 1, lines: f.selected.map(line => ({
      id: Number(line.localLineId), line_id: Number(line.sourceLineKey), item_id: line.itemId,
      item_type: 'InvtPart', netsuite_active: true, quantity: line.quantity, packed_sales_qty: line.quantity,
      unit: 'EA', location_id: 1, loaded_qty: 0
    })) };
  const source = createOperatorNetSuitePostingRealSourceResolver({ useStoredOrderLines: true,
    query: async sql => { calls.push(sql); return { rows: f.evidence.sourceRows.map(row => ({
      source_line_key: row.uniquekey, netsuite_order_line: row.id, item_id: row.item, item_type: row.itemtype,
      quantity: Math.abs(Number(row.quantity)), location_id: row.location
    })) }; }, fetchKitSource: async id => { assert.equal(id, 997764); return normalizeOperatorKitSource(f.evidence); } });
  const resolve = createOperatorNetSuitePostingTargetResolver({ getDeliveryOrder: async () => order, resolveRealSource: source });
  const result = await resolve({ functionKey: 'customer_pickup', orderId: 997764, clientLocationId: 1 });
  assert.deepEqual(result.targets[0].selectedLines.map(line => [line.orderLine, line.quantity]), [[1, 95.6], [2, 1]]);
  assert.match(calls[0], /'Kit'/u);
  assert.equal(result.targets[0].selectedLines[1].kit.physicalLines[0].localLineId, '458353');
});

test('fresh kit posting checks duplicate ID, revalidates, posts once, then verifies and finalizes', async () => {
  const h = kitServiceHarness();
  assert.equal((await h.processor.process(h.command.id)).status, 'completed');
  assert.deepEqual(h.calls, ['find', 'source', 'post', 'fetch', 'finalize']);
  await h.processor.process(h.command.id);
  assert.equal(h.calls.filter(call => call === 'post').length, 1);
  assert.equal(h.calls.filter(call => call === 'finalize').length, 1);
});

test('changed source fails safely before POST and releases the failed command for a refreshed retry', async () => {
  const h = kitServiceHarness({ readSource: source => { source.kitGroups[0].members[0].quantityPerKit = 2; return source; } });
  assert.equal((await h.processor.process(h.command.id)).status, 'failed');
  assert.deepEqual(h.calls, ['find', 'source']);
  assert.equal(h.command.error.code, 'OPERATOR_NETSUITE_POSTING_KIT_INVALID');
});

test('recovery verifies an existing kit IF even if the definition has subsequently changed', async () => {
  const h = kitServiceHarness({ find: step => ({ id: 8001, record: kitRemote(step) }),
    readSource: () => { throw new Error('Must not reread source after existing IF'); } });
  assert.equal((await h.processor.process(h.command.id)).status, 'completed');
  assert.deepEqual(h.calls, ['find', 'finalize']);
});

test('a timeout is recovered without a second kit POST', async () => {
  const h = kitServiceHarness({ find: (step, calls) => calls.includes('post') ? { id: 8001, record: kitRemote(step) } : null,
    transform: () => { throw Object.assign(new Error('timed out'), { code: 'NETSUITE_REQUEST_TIMEOUT' }); } });
  assert.equal((await h.processor.process(h.command.id)).status, 'completed');
  assert.deepEqual(h.calls, ['find', 'source', 'post', 'find', 'finalize']);
});

test('a kit IF with the wrong parent item cannot finalize', async () => {
  const h = kitServiceHarness({ remote: step => { const record = kitRemote(step); record.item.items[1].item.id = '599'; return record; } });
  assert.equal((await h.processor.process(h.command.id)).status, 'attention');
  assert.ok(!h.calls.includes('finalize'));
  assert.equal(h.command.error.code, 'OPERATOR_NETSUITE_POSTING_REMOTE_MISMATCH');
});

test('an uncertain kit attempt without a matching remote IF remains recovery-only', async () => {
  const h = kitServiceHarness({ attemptCount: 1 });
  assert.equal((await h.processor.process(h.command.id)).status, 'attention');
  assert.deepEqual(h.calls, ['find']);
});

test('a noninventory component is supported while inventory-detail members remain blocked', () => {
  const f = kitFixture(); f.evidence.sourceRows[1].itemtype = 'NonInvtPart';
  delete f.evidence.sourceRows[1].usebins;
  assert.equal(normalizeOperatorKitSource(f.evidence).kitGroups[0].members[0].itemId, 599);
});

test('the runtime source reader joins REST and SuiteQL evidence into the exact kit parent', async () => {
  const f = sobFixture();
  const source = await fetchOperatorKitSource(997764, {
    queryAll: async () => f.evidence.sourceRows,
    rest: async path => ({ data: path.includes('/salesOrder/') ? { item: { items: f.evidence.sourceItems } } : f.evidence.kitDefinitions[0] })
  });
  assert.deepEqual(source.availableLines.map(line => line.orderLine), [1, 2]);
  assert.equal(source.kitGroups[0].members[0].sourceLineKey, '4974658');
});

test('failure to read the current kit source is a safe rejection with no POST', async () => {
  const h = kitServiceHarness({ readSource: () => { throw new Error('NetSuite read unavailable'); } });
  assert.equal((await h.processor.process(h.command.id)).status, 'failed');
  assert.deepEqual(h.calls, ['find', 'source']);
  assert.match(h.command.error.message, /could not be rechecked/u);
});
