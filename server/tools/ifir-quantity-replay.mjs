// Operational verification: load and verify existing transactions before replay.
// Stable existing external IDs force RESTlet readback, never a new transform/save.
import assert from 'node:assert/strict';
import { query, closeDb } from './src/db.js';
import { config } from './src/config.js';
import { fetchItemFulfillmentFromNetSuite, fetchItemReceiptFromNetSuite,
  postIfirViaNetSuiteRestlet } from './src/netsuite.js';

const results = [];
try {
  assert.equal(config.netsuite.ifirPostingQuantityPolicyEnabled, true);
  const rows = (await query(`SELECT s.* FROM operator_netsuite_posting_steps s
    JOIN operator_netsuite_posting_commands c ON c.id=s.command_id
    WHERE s.status='posted' AND c.status='completed' AND s.netsuite_transaction_id IS NOT NULL
      AND NOT (s.response ? 'fulfillmentParts')
    ORDER BY s.posted_at DESC LIMIT 1000`)).rows;
  const chosen = new Map();
  for (const row of rows) {
    if (row.line_snapshot?.some(line => line.kit)) continue;
    const pair = `${row.source_order_kind}:${row.transaction_type}`;
    if (['SO:IF', 'PO:IR', 'TO:IF', 'TO:IR'].includes(pair) && !chosen.has(pair)) chosen.set(pair, row);
  }
  assert.ok(chosen.has('SO:IF') && chosen.has('PO:IR'));
  for (const [pair, row] of chosen) {
    const step = { sourceOrderKind: row.source_order_kind, transactionType: row.transaction_type,
      sourceNetSuiteId: Number(row.source_netsuite_id), externalId: row.external_id,
      payload: row.payload, lineSnapshot: row.line_snapshot };
    assert.equal(step.payload.externalId, step.externalId);
    const existing = await (step.transactionType === 'IF' ? fetchItemFulfillmentFromNetSuite
      : fetchItemReceiptFromNetSuite)(Number(row.netsuite_transaction_id));
    assert.equal(Number(existing.id), Number(row.netsuite_transaction_id));
    assert.equal(String(existing.externalId ?? existing.externalid), step.externalId);
    assert.equal(Number(existing.createdFromId ?? existing.createdFrom?.id ?? existing.createdfrom), step.sourceNetSuiteId);
    assert.equal(existing.tranId ?? existing.tranid, row.netsuite_transaction_ref);
    const result = await postIfirViaNetSuiteRestlet(step);
    assert.ok(result);
    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'existing');
    assert.equal(result.quantityPolicy, 'sqft_remaining_v1');
    assert.equal(Number(result.id), Number(row.netsuite_transaction_id));
    assert.equal(result.tranId, row.netsuite_transaction_ref);
    assert.ok(result.record.item.items.length > 0);
    assert.ok(Array.isArray(result.quantityAdjustments));
    const proof = { pair, id: result.id, tranId: result.tranId, outcome: result.outcome,
      quantityPolicy: result.quantityPolicy, savedLines: result.record.item.items.length,
      adjustmentCount: result.quantityAdjustments.length,
      savedFieldsVerifiedByAppClient: true };
    results.push(proof);
    console.log(JSON.stringify({ event: 'quantity-replay', ...proof }));
  }
  console.log(JSON.stringify({ event: 'quantity-replay-summary', at: new Date().toISOString(),
    passed: true, transactionsCreated: 0, cases: results }));
} catch (error) {
  console.log(JSON.stringify({ event: 'quantity-replay-summary', at: new Date().toISOString(),
    passed: false, cases: results, error: { code: error.code || null, message: error.message } }));
  process.exitCode = 1;
} finally { await closeDb(); }
