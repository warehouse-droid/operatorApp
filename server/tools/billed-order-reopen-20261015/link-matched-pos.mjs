// Operational repair requested by the user. Default mode is a read-only preview.
// Uses the application's normal atomic dependency command, locks and audit receipts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { query, withTransaction, closeDb } from './src/db.js';
import { getSalesOrderPoAllocationOptions } from './src/dispatch-repository.js';
import { previewScmDependencyMutation } from './src/scm-dependency-preview-service.js';
import { executeScmDependencyCommand, scmDependencyPayloadHash } from './src/scm-dependency-command-service.js';
import { DISPATCH_FLEET_PLANNING_LOCK } from './src/dispatch-fleet-status.js';

const apply = process.env.SOM06964_LINK_APPLY === '1';
const actor = { id: 'codex:SOM06964:20261015', sessionId: 'codex:SOM06964:20261015', surface: 'dispatch' };
const selections = [
  { requestId: '615c6885-a501-43b2-a808-4338cda536b8', caseId: 141, poRef: '#263967', originalPoRef: 'POB04024', orderId: 1051715,
    lines: [
      { salesLineId: 526508, poLineId: 529995, salesQty: 26.66, exact: true },
      { salesLineId: 526510, poLineId: 529997, salesQty: 9, exact: true },
      { salesLineId: 526512, poLineId: 529998, salesQty: 72, exact: true }
    ] },
  { requestId: '9a8fa0fe-06ac-4cea-98bd-b2ee74dd4338', caseId: 142, poRef: '#263968', originalPoRef: 'POB04022', orderId: 1051487,
    lines: [
      { salesLineId: 526505, poLineId: 529950, salesQty: 60, exact: false },
      { salesLineId: 526505, poLineId: 529951, salesQty: 28, exact: false }
    ] }
];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const snapshot = async () => {
  const sales = (await query(`SELECT to_jsonb(s) header,
    (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM sales_order_lines l WHERE l.sales_order_id=s.netsuite_id) lines
    FROM sales_orders s WHERE s.netsuite_id=1049213`)).rows;
  const purchase = (await query(`SELECT to_jsonb(p) header,
    (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM purchase_order_lines l WHERE l.purchase_order_id=p.netsuite_id) lines
    FROM purchase_orders p WHERE p.netsuite_id=ANY($1::bigint[]) ORDER BY p.netsuite_id`, [selections.map(s => s.orderId)])).rows;
  return { sales, purchase };
};

try {
  const result = await withTransaction(async () => {
    if (!apply) await query('SET TRANSACTION READ ONLY');
    else {
      await query("SET LOCAL lock_timeout = '5s'");
      await query("SET LOCAL statement_timeout = '60s'");
      await query('SELECT pg_advisory_xact_lock(hashtext($1))', [DISPATCH_FLEET_PLANNING_LOCK]);
      await query('SELECT netsuite_id FROM sales_orders WHERE netsuite_id=1049213 FOR UPDATE');
      await query('SELECT id FROM sales_order_lines WHERE sales_order_id=1049213 ORDER BY id FOR UPDATE');
      await query('SELECT netsuite_id FROM purchase_orders WHERE netsuite_id=ANY($1::bigint[]) ORDER BY netsuite_id FOR UPDATE', [selections.map(s => s.orderId)]);
      await query('SELECT id FROM purchase_order_lines WHERE purchase_order_id=ANY($1::bigint[]) ORDER BY id FOR UPDATE', [selections.map(s => s.orderId)]);
    }
    const prior = (await query('SELECT request_id,status,result FROM scm_dependency_action_receipts WHERE request_id=ANY($1::uuid[])', [selections.map(s => s.requestId)])).rows;
    if (prior.length) {
      assert.equal(prior.length, 2, 'Unexpected partial receipt set; inspect before continuing');
      assert.ok(prior.every(row => row.status === 'succeeded'));
      return { applied: true, idempotent: true, receipts: prior.map(row => ({ requestId: row.request_id, allocationIds: row.result.allocationIds })) };
    }
    const before = await snapshot();
    assert.equal(before.sales[0].header.tranid, 'SOM06964');
    assert.equal(before.sales[0].header.operator_status, 'open');
    assert.equal(before.sales[0].header.fulfillment_status, 'not_fulfilled');
    const cases = (await query(`SELECT request_id, sales_order_ref, sales_order_netsuite_id, purchase_order_ref,
      purchase_order_netsuite_id, close_status FROM sales_special_stock_cases
      WHERE request_id=ANY($1::bigint[]) ${apply ? 'FOR SHARE' : ''}`, [selections.map(s => s.caseId)])).rows;
    const options = await getSalesOrderPoAllocationOptions('SOM06964');
    assert.equal(options.allocations.length, 0, 'Existing links changed; inspect before allocation');
    const commands = [];
    const previews = [];
    for (const selection of selections) {
      const saved = cases.find(row => Number(row.request_id) === selection.caseId);
      assert.ok(saved);
      assert.equal(saved.sales_order_ref, 'SOM06964');
      assert.equal(Number(saved.sales_order_netsuite_id), 1049213);
      assert.equal(saved.purchase_order_ref, selection.originalPoRef);
      assert.equal(Number(saved.purchase_order_netsuite_id), selection.orderId);
      assert.equal(saved.close_status, 'active');
      const totals = new Map();
      const lines = selection.lines.map(pick => {
        const sales = options.salesLines.find(row => Number(row.id) === pick.salesLineId);
        const purchase = options.poLines.find(row => Number(row.id) === pick.poLineId);
        assert.ok(sales && purchase, 'Selected material is unavailable');
        assert.equal(Number(purchase.orderId), selection.orderId);
        assert.equal(purchase.originalPoRef, selection.originalPoRef);
        assert.equal(sales.required.unit, purchase.required.unit);
        assert.equal(purchase.available.salesQty, pick.salesQty);
        assert.equal(purchase.allocated.salesQty, 0);
        assert.equal(sales.allocated.salesQty, 0);
        const match = sales.poCandidates.find(row => Number(row.poLineId) === pick.poLineId);
        assert.ok(match && match.unitMatch);
        if (pick.exact) assert.equal(match.exactMatch, true);
        else {
          // Case 142 explicitly joins these orders. Vendor and SO descriptions
          // differ in formatting; both specify identical Onyx Black coping.
          for (const term of [/onyx\s*black/i, /rockface/i, /flamed/i, /2x12x48/i, /4sqft\/pc/i]) {
            assert.match(sales.description, term);
            assert.match(purchase.description, term);
          }
        }
        totals.set(pick.salesLineId, (totals.get(pick.salesLineId) || 0) + pick.salesQty);
        return { salesLineId: pick.salesLineId, targetLineKey: sales.targetLineKey, poLineId: pick.poLineId, quantities: { salesQty: pick.salesQty } };
      });
      for (const [lineId, quantity] of totals) {
        assert.equal(quantity, options.salesLines.find(row => Number(row.id) === lineId).required.salesQty);
      }
      const command = { requestId: selection.requestId, action: 'link_po', targetRef: 'SOM06964',
        targetSignature: options.order.targetSignature, payload: { poRef: selection.poRef, lines } };
      command.payloadHash = scmDependencyPayloadHash(command);
      const preview = await previewScmDependencyMutation(command, actor);
      assert.equal(preview.allowed, true, JSON.stringify(preview.blockers));
      assert.equal(preview.affectedPlan, null, 'A dispatch route is now affected; inspect its revision before proceeding');
      commands.push(command);
      previews.push({ originalPoRef: selection.originalPoRef, poRef: selection.poRef, caseId: selection.caseId,
        allowed: preview.allowed, affectedPlan: null, lines });
    }
    const applied = [];
    if (apply) for (const command of commands) {
      const response = await executeScmDependencyCommand(command, actor);
      assert.equal(response.status, 'applied');
      assert.equal(response.allocations.length, command.payload.lines.length);
      applied.push({ requestId: command.requestId, poRef: command.payload.poRef, allocationIds: response.allocationIds });
    }
    const after = await snapshot();
    assert.equal(hash(before), hash(after), 'Canonical sales/PO headers or lines changed');
    const final = await getSalesOrderPoAllocationOptions('SOM06964');
    if (apply) {
      assert.equal(final.allocations.length, 5);
      for (const line of final.salesLines) assert.equal(line.allocated.salesQty,
        Number(line.id) === 526507 ? 0 : line.required.salesQty);
    }
    return { applied: apply, readOnly: !apply, actor: actor.id, previews, receipts: applied,
      canonicalDataUnchanged: true, canonicalHash: hash(after),
      allocationCount: final.allocations.length,
      salesLines: final.salesLines.map(row => ({ id: row.id, description: row.description, required: row.required, allocated: row.allocated })),
      unlinkedPierCaps: { salesLineId: 526507, pieces: 2, salesQty: 10.88, unit: 'SQFT', reason: 'No matching available PO line; no allocation inferred.' }
    };
  });
  console.log(JSON.stringify(result, null, 2));
} finally { await closeDb(); }
