import assert from 'node:assert/strict';
import { fetchItemReceiptFromNetSuite, fetchPurchaseOrderHistorySnapshotFromNetSuite } from '../../src/netsuite.js';
import { getOperatorNetSuitePostingCommand } from '../../src/operator-netsuite-posting-repository.js';
import { listReceivingReceipts } from '../../src/receiving-repository.js';
import { publicOperatorNetSuitePostingCommand } from '../../src/operator-netsuite-posting-controller.js';
import { query, pool } from '../../src/db.js';
import { commandId, verifyReceiptRecovery } from './proof.mjs';
import { recoverReceipt } from './recover.mjs';

try {
  const mode = process.argv[2];
  assert.ok(['--preview', '--apply', '--verify'].includes(mode), 'Explicit mode required');
  const [receipt, source, command] = await Promise.all([
    fetchItemReceiptFromNetSuite(1071915), fetchPurchaseOrderHistorySnapshotFromNetSuite(1059322),
    getOperatorNetSuitePostingCommand(commandId)
  ]);
  const evidence = { receipt, source, command };
  const proof = verifyReceiptRecovery(evidence);
  const result = mode === '--apply' ? await recoverReceipt({ evidence }) : command;
  const receipts = (await listReceivingReceipts({ operatorId: result.actorOperatorId, limit: 100 }))
    .filter(row => String(row.order_id) === '1059322');
  const publicJob = publicOperatorNetSuitePostingCommand(result);
  const order = (await query('SELECT tranid,receipt_status,last_item_receipt_id,last_item_receipt_tranid FROM purchase_orders WHERE netsuite_id=1059322')).rows[0];
  if (mode !== '--preview') {
    assert.equal(result.status, 'completed');
    assert.equal(publicJob.result.localFinalization.itemReceiptTranid, 'IR15183');
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].item_receipt_tranid, 'IR15183');
    assert.equal(order.receipt_status, 'received');
    assert.equal(order.last_item_receipt_tranid, 'IR15183');
  }
  console.log(JSON.stringify({ at: new Date().toISOString(), mode, proof, order,
    command: { id: result.id, status: result.status, attempts: result.steps[0].attemptCount,
      transactionRef: publicJob.steps[0].transactionRef, result: publicJob.result },
    history: receipts.map(r => ({ id: r.id, orderRef: r.tranid, itemReceiptTranid: r.item_receipt_tranid,
      receiptStatus: r.receipt_status })), netSuiteWrites: 0 }, null, 2));
  await pool.end(); process.exit(0);
} catch (error) {
  console.error(JSON.stringify({ message: error.message, code: error.code }));
  await pool.end(); process.exit(1);
}
