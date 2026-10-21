// @ts-check
import assert from 'node:assert/strict';
import { query, withTransaction } from '../../src/db.js';
import { writeAudit } from '../../src/auth-repository.js';
import * as repository from '../../src/operator-netsuite-posting-repository.js';
import { finalizeOperatorNetSuitePosting } from '../../src/operator-netsuite-posting-finalizer.js';
import { fulfillmentTransactions } from '../../src/item-fulfillment-parts-domain.js';
import { commandId, verifyReceiptRecovery } from './proof.mjs';

/** @param {{evidence:any,rollback?:boolean,finalize?:Function}} options */
export async function recoverReceipt({ evidence, rollback = false, finalize = finalizeOperatorNetSuitePosting }) {
  return withTransaction(async () => {
    await query('SELECT id FROM operator_netsuite_posting_commands WHERE id=$1 FOR UPDATE', [commandId]);
    const original = await repository.getOperatorNetSuitePostingCommand(commandId);
    assert.ok(original, 'The original command must exist');
    const proof = verifyReceiptRecovery({ ...evidence, command: original });
    if (original.status === 'completed') {
      assert.equal(original.steps[0].netSuiteTransactionId, proof.id);
      assert.equal(original.result.localFinalization.itemReceiptTranid, proof.transactionRef);
      return original;
    }
    assert.equal(original.status, 'attention');
    assert.equal(original.steps[0].status, 'uncertain');
    assert.equal(original.steps[0].response.observedTransaction.id, proof.id);
    assert.equal(original.steps[0].response.observedTransaction.tranId, proof.transactionRef);
    assert.equal(original.steps[0].response.observedTransaction.externalId, evidence.receipt.externalId);
    await repository.resumeOperatorNetSuitePostingCommand(commandId);
    const command = await repository.claimOperatorNetSuitePostingCommand({ commandId,
      workerId: 'incident-pob04042-source-verified-recovery', leaseSeconds: 180 });
    assert.ok(command, 'The recovery must own the command lease');
    const step = command.steps[0];
    const attempt = await repository.startOperatorNetSuitePostingAttempt({ commandId,
      stepId: step.id, leaseToken: command.leaseToken });
    const recovery = { reason: 'source_verified_purchase_freight', freight: proof.freight,
      sourceOrderId: 1059322, verifiedAt: new Date().toISOString(), createsNetSuiteTransaction: false };
    const posted = await repository.recordOperatorNetSuitePostingStepSuccess({ commandId,
      stepId: step.id, leaseToken: command.leaseToken, attemptNumber: attempt.attemptNumber,
      transactionId: proof.id, transactionRef: proof.transactionRef, recovered: true,
      response: { id: proof.id, tranId: proof.transactionRef, externalId: step.externalId, recovery } });
    command.steps = [posted];
    const completed = await repository.completeOperatorNetSuitePostingCommand({ commandId,
      leaseToken: command.leaseToken, result: { ok: true, commandId, transactions: fulfillmentTransactions(posted), recovery },
      finalize: () => finalize(command) });
    assert.equal(completed.result.localFinalization.itemReceiptTranid, 'IR15183');
    assert.equal(completed.result.localFinalization.receiptStatus, 'received');
    assert.deepEqual(completed.inputSnapshot, original.inputSnapshot);
    assert.deepEqual(completed.steps[0].payload, original.steps[0].payload);
    // The legacy audit signature infers orderId from a null default; its SQL column accepts bigint IDs.
    await writeAudit({ actorType: 'system', source: 'receiving', action: 'receiving.ir.reconcile_existing',
      orderId: /** @type {any} */ (1059322), details: { commandId, itemReceiptId: proof.id, itemReceiptTranid: proof.transactionRef, recovery } });
    return completed;
  }, { rollback });
}
