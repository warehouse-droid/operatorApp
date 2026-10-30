// Operational history verification in the existing app container only.
// inspect: database SELECT only. replay: require a live, verified existing
// external ID before asking the RESTlet to return that same saved transaction.
import assert from 'node:assert/strict';
import { query, closeDb } from './src/db.js';
import { config } from './src/config.js';
import { getNetSuiteM2mAccessToken } from './src/netsuite-m2m-runtime.js';
import { netSuiteRequestScheduler } from './src/netsuite-request-scheduler.js';
import { fetchItemFulfillmentFromNetSuite, fetchItemReceiptFromNetSuite,
  fetchPurchaseOrderHistorySnapshotFromNetSuite } from './src/netsuite.js';
import { verifyPurchaseReceiptWithCharges, purchaseReceiptNeedsChargeSource } from './src/operator-netsuite-receipt-charges.js';

const mode = process.env.IFIR_HISTORY_MODE || 'inspect';
const useAppClient = process.env.IFIR_USE_APP_CLIENT === 'true';
assert.ok(['inspect', 'replay'].includes(mode));
const endpoint = 'https://6518947.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=507&deploy=1';
const results = [];
try {
  assert.equal(config.netsuite.accountId, '6518947');
  const counts = await query(`SELECT source_order_kind, transaction_type, count(*)::int AS total
    FROM operator_netsuite_posting_steps WHERE status='posted' GROUP BY 1,2 ORDER BY 1,2`);
  const rows = (await query(`SELECT s.* FROM operator_netsuite_posting_steps s
    JOIN operator_netsuite_posting_commands c ON c.id=s.command_id
    WHERE s.status='posted' AND c.status='completed' AND s.netsuite_transaction_id IS NOT NULL
      AND NOT (s.response ? 'fulfillmentParts')
    ORDER BY s.posted_at DESC LIMIT 500`)).rows;
  const specialItems = (await query(`SELECT DISTINCT item_id, item_name FROM purchase_order_lines
    WHERE lower(coalesce(sku, item_name, '')) LIKE '%special%order%' LIMIT 20`)).rows;
  const specialIds = new Set(specialItems.map(row => Number(row.item_id)));
  const selected = new Map();
  for (const row of rows) {
    const pair = `${row.source_order_kind}:${row.transaction_type}`;
    const kit = row.line_snapshot?.some(line => line.kit);
    const special = row.line_snapshot?.some(line => specialIds.has(Number(line.itemId)));
    const packs = row.payload?.item?.items?.some(line => ['custcol_plt','custcol_lyr','custcol_sec','custcol_pcs']
      .some(field => Number(line[field]) > 0));
    const key = `${pair}:${kit ? 'kit' : special ? 'special-order' : packs ? 'packs' : 'ordinary'}`;
    if (!selected.has(key)) selected.set(key, row);
  }
  console.log(JSON.stringify({ event: 'history-selection', observedAt: new Date().toISOString(), mode, useAppClient,
    counts: counts.rows, specialItems, samples: [...selected].map(([category,row]) => ({ category, stepId: row.id,
      transactionId: row.netsuite_transaction_id, transactionRef: row.netsuite_transaction_ref,
      sourceId: row.source_netsuite_id, payloadLines: row.payload?.item?.items?.length })) }));
  if (mode === 'replay') {
    const appPost = useAppClient ? (await import('./src/netsuite.js')).postIfirViaNetSuiteRestlet : null;
    if (useAppClient) { assert.equal(config.netsuite.ifirPostingEnabled, true); }
    const token = useAppClient ? null : await getNetSuiteM2mAccessToken();
    for (const [category, row] of selected) {
      const step = { sourceOrderKind: row.source_order_kind, transactionType: row.transaction_type,
        sourceNetSuiteId: Number(row.source_netsuite_id), externalId: row.external_id,
        lineSnapshot: row.line_snapshot, payload: row.payload };
      const result = { category, stepId: row.id, transactionId: Number(row.netsuite_transaction_id),
        transactionRef: row.netsuite_transaction_ref, preflightPassed: false, postAttempted: false };
      try {
        assert.equal(step.payload.externalId, step.externalId);
        const existing = await (step.transactionType === 'IF' ? fetchItemFulfillmentFromNetSuite
          : fetchItemReceiptFromNetSuite)(result.transactionId);
        assert.equal(Number(existing.id), result.transactionId);
        assert.equal(String(existing.externalId ?? existing.externalid), step.externalId);
        assert.equal(Number(existing.createdFromId ?? existing.createdFrom?.id ?? existing.createdfrom), step.sourceNetSuiteId);
        assert.equal(existing.tranId ?? existing.tranid, result.transactionRef);
        const source = purchaseReceiptNeedsChargeSource(step, existing)
          ? await fetchPurchaseOrderHistorySnapshotFromNetSuite(step.sourceNetSuiteId) : null;
        verifyPurchaseReceiptWithCharges(step, { ...existing, transactionType: step.transactionType }, source);
        result.preflightPassed = true;
        if (category.endsWith(':kit')) {
          result.routing = 'native';
          result.reason = 'Kit readback is unsupported by RESTlet v1; native verification passed.';
          result.passed = true;
          results.push(result);
          console.log(JSON.stringify({ event: 'history-result', ...result }));
          continue;
        }
        const input = { action: 'post', sourceOrderKind: step.sourceOrderKind, transactionType: step.transactionType,
          sourceNetSuiteId: step.sourceNetSuiteId, payload: step.payload };
        let response;
        if (appPost) {
          result.postAttempted = true;
          result.transport = 'deployed-app-client';
          response = { status: null, data: await appPost(step) };
          assert.ok(response.data, 'An eligible history replay must use the enabled app client.');
        } else {
          response = await netSuiteRequestScheduler.run(async signal => {
          result.postAttempted = true;
          const http = await fetch(endpoint, { method: 'POST', redirect: 'error', signal,
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify(input) });
          let data = JSON.parse(await http.text());
          if (typeof data === 'string') data = JSON.parse(data);
          return { status: http.status, data };
          }, { priority: 'background', timeoutMs: 45000 });
        }
        result.httpStatus = response.status;
        result.response = response.data;
        if (!appPost) { assert.equal(response.status, 200); }
        assert.equal(response.data.ok, true);
        assert.equal(response.data.contractVersion, 1);
        assert.equal(response.data.outcome, 'existing');
        assert.equal(Number(response.data.id), result.transactionId);
        assert.equal(response.data.tranId, result.transactionRef);
        result.verified = verifyPurchaseReceiptWithCharges(step, response.data.record, response.data.source);
        result.packageChecks = [];
        for (const line of step.payload.item.items.filter(item => item.itemReceive === true)) {
          const saved = response.data.record.item.items.find(item => Number(item.orderLine) === Number(line.orderLine));
          for (const field of ['custcol_plt','custcol_lyr','custcol_sec','custcol_pcs']) {
            if (line[field] === undefined) continue;
            const unavailableOnReceipt = step.transactionType === 'IR' && (saved?.[field] === null || saved?.[field] === undefined);
            const matches = saved?.[field] !== null && saved?.[field] !== undefined
              && Math.abs(Number(saved[field]) - Number(line[field])) <= 0.000001;
            result.packageChecks.push({ orderLine: line.orderLine, field, expected: line[field], actual: saved?.[field],
              applicable: !unavailableOnReceipt, matches: unavailableOnReceipt ? null : matches });
            assert.ok(matches || unavailableOnReceipt, `Package field ${field} differs on line ${line.orderLine}`);
          }
        }
        result.passed = true;
      } catch (error) {
        result.passed = false;
        result.error = { code: error.code || null, message: error.message };
      }
      results.push(result);
      console.log(JSON.stringify({ event: 'history-result', ...result }));
      // Any unexpected outcome must be investigated before another replay.
      if (result.response?.outcome === 'created') break;
    }
    console.log(JSON.stringify({ event: 'history-summary', cases: results.length,
      passed: results.filter(row => row.passed).length,
      native: results.filter(row => row.routing === 'native').length,
      existing: results.filter(row => row.response?.outcome === 'existing').length,
      created: results.filter(row => row.response?.outcome === 'created').length }));
    if (results.some(row => !row.passed)) process.exitCode = 1;
  }
} finally { await closeDb(); }
