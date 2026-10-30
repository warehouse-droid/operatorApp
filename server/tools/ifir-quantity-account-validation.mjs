// Operational no-save validation in the existing app, after the user uploads the RESTlet.
// Every transform includes a nonexistent selected line. applyLines must reject it
// before saveOnce; no valid posting payload is ever sent by this script.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { config } from './src/config.js';
import { closeDb } from './src/db.js';
import { suiteql, fetchOperatorNetSuiteSourceItemLinesFromNetSuite } from './src/netsuite.js';
import { fetchLiveSourceFromNetSuite } from './src/operator-netsuite-posting-targets.js';
import { getNetSuiteM2mAccessToken } from './src/netsuite-m2m-runtime.js';
import { netSuiteRequestScheduler } from './src/netsuite-request-scheduler.js';

const policy = 'sqft_remaining_v1';
const sentinel = 2147483647;
const report = { observedAt: new Date().toISOString(), quantityPolicy: policy, passed: false,
  transactionsCreated: 0, noSaveGuard: 'Nonexistent selected order line checked before saveOnce', cases: [] };
const cases = JSON.parse(process.env.IFIR_QUANTITY_VALIDATION_CASES || '[]');
try {
  assert.equal(config.netsuite.accountId, '6518947');
  assert.ok(cases.length > 0 && cases.length <= 4);
  const endpoint = new URL(config.netsuite.ifirPostingRestletUrl);
  assert.equal(endpoint.hostname, '6518947.restlets.api.netsuite.com');
  assert.equal(endpoint.protocol, 'https:');
  assert.equal(endpoint.pathname, '/app/site/hosting/restlet.nl');
  assert.equal(endpoint.searchParams.get('script'), '507');
  assert.equal(endpoint.searchParams.get('deploy'), '1');
  const token = await getNetSuiteM2mAccessToken();
  async function request(body) {
    return netSuiteRequestScheduler.run(async signal => {
      const response = await fetch(endpoint, { method: body ? 'POST' : 'GET', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(response.status, 200);
      let data = JSON.parse(await response.text());
      if (typeof data === 'string') data = JSON.parse(data);
      return data;
    }, { priority: 'background', timeoutMs: 45000 });
  }
  const health = await request();
  assert.equal(health.ok, true);
  assert.equal(health.contractVersion, 1);
  assert.equal(health.writesEnabled, true);
  assert.equal(health.productionAllowed, true);
  assert.ok(health.quantityPolicies.includes(policy));
  report.health = health;
  for (const test of cases) {
    const { kind, transactionType, id, orderLine: sourceOrderLine } = test;
    let orderLine = sourceOrderLine;
    assert.ok(['SO:IF', 'PO:IR', 'TO:IF', 'TO:IR'].includes(`${kind}:${transactionType}`));
    assert.ok(Number.isSafeInteger(id) && id > 0 && Number.isSafeInteger(orderLine) && orderLine > 0);
    const lines = await fetchOperatorNetSuiteSourceItemLinesFromNetSuite(kind, id);
    assert.ok(lines.length > 0 && lines.length < 1000);
    assert.ok(lines.every(line => Number(line.orderLine ?? line.line) < sentinel));
    const line = lines.find(line => Number(line.orderLine ?? line.line) === orderLine);
    assert.ok(line && line.isClosed === false);
    const unit = (await suiteql(`SELECT BUILTIN.DF(units) AS unit FROM transactionline WHERE transaction=${id} AND id=${orderLine}`, [], { limit: 2 })).items;
    assert.equal(unit.length, 1);
    const salesUom = String(unit[0].unit).toUpperCase();
    assert.ok(salesUom);
    if (!test.allowOtherUnit) assert.equal(salesUom, 'SQFT');
    if (kind === 'TO') {
      const live = await fetchLiveSourceFromNetSuite({ sourceOrderKind: kind, sourceNetSuiteId: id });
      const stage = transactionType === 'IF' ? 'outbound' : 'receiving';
      const matches = live.lines.filter(row => row.stage === stage && Number(row.itemId) === Number(line.item.id));
      assert.equal(matches.length, 1);
      assert.equal(matches[0].identityStatus, 'exact');
      orderLine = Number(matches[0].restOrderLine);
      assert.ok(Number.isSafeInteger(orderLine) && orderLine > 0 && orderLine < sentinel);
    }
    const remaining = transactionType === 'IR' && kind === 'TO'
      ? Number(line.quantityFulfilled) - Number(line.quantityReceived || 0)
      : Number(line.quantity) - Number(transactionType === 'IF' ? line.quantityFulfilled || 0 : line.quantityReceived || 0);
    assert.ok(Number.isFinite(remaining) && remaining > 0);
    for (const [name, delta, expected] of [
      [salesUom === 'SQFT' ? 'near-remaining' : 'exact-remaining', salesUom === 'SQFT' ? 0.0000001 : 0, 'IFIR_MISSING_LINE'],
      ['excess-one-hundredth', 0.01, 'IFIR_QUANTITY_EXCEEDS_REMAINING']
    ]) {
      const externalId = 'mbbs_quantity_nosave_' + crypto.randomUUID();
      const payload = { externalId, item: { items: [
        { orderLine, itemReceive: true, quantity: remaining + delta },
        { orderLine: sentinel, itemReceive: true, quantity: 1 }
      ] } };
      if (transactionType === 'IF') payload.shipStatus = 'C';
      const result = await request({ action: 'post', sourceOrderKind: kind, transactionType,
        sourceNetSuiteId: id, quantityPolicy: policy, payload });
      const row = { name, kind, transactionType, sourceId: id, orderLine, remaining,
        requested: remaining + delta, externalId, code: result.code, stage: result.stage,
        sourceOrderLine, salesUom, message: result.message,
        postingNotAttempted: result.postingNotAttempted, ambiguous: result.ambiguous, id: result.id };
      report.cases.push(row);
      console.log(JSON.stringify({ event: 'no-save-validation', ...row }));
      assert.equal(result.ok, false);
      assert.equal(result.postingNotAttempted, true);
      assert.equal(result.ambiguous, false);
      assert.equal(result.id, null);
      assert.equal(result.stage, 'transform');
      assert.equal(result.code, expected);
      if (expected === 'IFIR_MISSING_LINE') assert.ok(result.message.includes(String(sentinel)));
    }
  }
  report.passed = true;
} catch (error) {
  report.error = { code: error.code || null, message: error.message };
  process.exitCode = 1;
} finally {
  console.log(JSON.stringify({ event: 'account-validation-summary', ...report }));
  await closeDb();
}
