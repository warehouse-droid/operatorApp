import assert from 'node:assert/strict';
import { query, withTransaction, closeDb } from '../src/db.js';
import { getOrderDependencyOptions } from '../src/order-dependency-repository.js';
import { previewScmDependencyMutation } from '../src/scm-dependency-preview-service.js';
import { getDeliveryOrder } from '../src/delivery-repository.js';
import { operatorLinkedTransferPlanJoinSql } from '../src/operator-linked-transfer-plan.js';

try {
  const result = await withTransaction(async () => {
    await query('SET TRANSACTION READ ONLY');
    await query("SET LOCAL statement_timeout='30s'");
    const targetRef = 'GOM-6531-6537';
    const transferOrderRef = 'TOB01103';
    const dates = [];
    for (const planDate of ['2026-09-18', '2026-09-19']) {
      const options = await getOrderDependencyOptions({ dispatchTargetRef: targetRef, transferOrderRef, planDate });
      assert.equal(options.dispatchTargetKind, 'group');
      assert.equal(options.matchError, '');
      assert.ok(options.matchingLines.length >= 2);
      const preview = await previewScmDependencyMutation({ action: 'link_to', targetRef, planDate,
        targetSignature: options.targetSignature, payload: { transferOrderRef, mode: 'direct_to_customer',
          allocations: options.matchingLines.map(line => ({ targetLineKey: line.targetLineKey, quantities: line.suggestedQuantities })) } });
      assert.equal(preview.allowed, true, JSON.stringify(preview.blockers));
      dates.push({ planDate, allowed: preview.allowed, lines: options.matchingLines.map(line => ({
        sourceOrderRef: line.sourceOrderRef, itemId: line.itemId, suggestedQuantity: line.suggestedQuantity })) });
    }
    const linked = (await query(`SELECT t.netsuite_id,t.tranid,t.dispatch_planned,linked_plan_date,linked_truck_plate,linked_load_name
      FROM transfer_orders t ${operatorLinkedTransferPlanJoinSql('t')}
      WHERE linked_plan_id IS NOT NULL ORDER BY linked_plan_date DESC LIMIT 10`)).rows;
    for (const row of linked) {
      const detail = await getDeliveryOrder(row.netsuite_id);
      assert.equal(detail.dispatch_planned, true);
      assert.equal(detail.dispatch_truck_plate, row.linked_truck_plate);
      assert.equal(detail.dispatch_load_name, row.linked_load_name);
    }
    return { passed: true, readOnly: true, targetRef, transferOrderRef, dates,
      inheritedOperatorAssignmentsVerified: linked.map(row => row.tranid), businessLinkCreated: false };
  });
  console.log(JSON.stringify(result));
} finally { await closeDb(); }
