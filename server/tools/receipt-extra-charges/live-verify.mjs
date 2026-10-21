import assert from 'node:assert/strict';
import { operatorNetSuitePostingAdapter } from '../../src/operator-netsuite-posting-netsuite-adapter.js';
import { getOperatorNetSuitePostingCommand } from '../../src/operator-netsuite-posting-repository.js';
import { publicOperatorNetSuitePostingCommand } from '../../src/operator-netsuite-posting-controller.js';
import { listReceivingReceipts } from '../../src/receiving-repository.js';
import { query, pool } from '../../src/db.js';

try {
  const command = await getOperatorNetSuitePostingCommand('537ee8b8-2967-4f52-a992-590bc4336837');
  const record = await operatorNetSuitePostingAdapter.fetchById(command.steps[0], 1071915);
  const verified = operatorNetSuitePostingAdapter.verify(command.steps[0], record);
  assert.equal(verified.transactionRef, 'IR15183');
  assert.equal(verified.additionalPurchaseCharges.length, 1);
  assert.equal(verified.additionalPurchaseCharges[0].itemId, 3025);
  assert.equal(verified.additionalPurchaseCharges[0].amount, 130.42);
  assert.equal(command.status, 'completed');
  assert.equal(command.inputHash, '03ed74c080dce3f42accef077cede70125073fc46f410d12ae4e3c509f2f6eba');
  assert.equal(publicOperatorNetSuitePostingCommand(command).result.localFinalization.itemReceiptTranid, 'IR15183');
  const history = (await listReceivingReceipts({ operatorId: command.actorOperatorId, limit: 100 }))
    .filter(row => String(row.order_id) === '1059322');
  assert.equal(history.length, 1);
  assert.equal(history[0].item_receipt_tranid, 'IR15183');
  const order = (await query('SELECT tranid,receipt_status,last_item_receipt_id,last_item_receipt_tranid FROM purchase_orders WHERE netsuite_id=1059322')).rows[0];
  assert.equal(order.receipt_status, 'received');
  assert.equal(order.last_item_receipt_tranid, 'IR15183');
  console.log(JSON.stringify({ verifiedAt: new Date().toISOString(), order, verified,
    command: { id: command.id, status: command.status, inputHash: command.inputHash },
    history: history.map(row => ({ id: row.id, itemReceiptTranid: row.item_receipt_tranid, receiptStatus: row.receipt_status })),
    localWrites: 0, netSuiteWrites: 0 }, null, 2));
  await pool.end(); process.exit(0);
} catch (error) {
  console.error(JSON.stringify({ message: error.message, code: error.code }));
  await pool.end(); process.exit(1);
}
