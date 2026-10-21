import assert from 'node:assert/strict';
import test from 'node:test';
import {netSuiteReceivedTransferOrderSql} from '../../../src/operator-transfer-completion.js';

test('completion SQL only accepts a single safe table alias',()=>{
  for(const alias of ['',null,undefined,'t.status','t; DROP TABLE transfer_orders','t--','t\nstatus']) {
    assert.throws(()=>netSuiteReceivedTransferOrderSql(alias),TypeError);
  }
  assert.ok(netSuiteReceivedTransferOrderSql('transfer_order_1').includes('transfer_order_1.status'));
});
