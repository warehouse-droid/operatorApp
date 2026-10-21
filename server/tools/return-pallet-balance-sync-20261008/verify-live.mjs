import assert from 'node:assert/strict';
import { fetchCreditMemoFromNetSuite } from '../../src/netsuite.js';
import { lookupReturnCustomerPalletBalance } from '../../src/return-repository.js';
import { query, closeDb } from '../../src/db.js';

const transport = globalThis.fetch;
const requests = [];
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(String(url)).pathname;
  const method = options.method || 'GET';
  if (path.includes('/record/')) assert.equal(method, 'GET', 'Live verification must not write any NetSuite record');
  requests.push({ path, method });
  return transport(url, options);
};
try {
  assert.equal(await fetchCreditMemoFromNetSuite(1047372, { strictMissing: true }), null);
  const balance = await lookupReturnCustomerPalletBalance(8444);
  const records = (await query(`SELECT r.record_reference,r.pallet_quantity,r.netsuite_sync_status,
      a.netsuite_transaction_id,a.netsuite_transaction_ref,a.netsuite_transaction_status
    FROM return_records r JOIN return_batch_authorizations a ON a.batch_id=r.batch_id
    WHERE r.customer_id=8444 AND r.record_type='pallet' ORDER BY r.id`)).rows;
  const credit = records.find(row => Number(row.netsuite_transaction_id) === 1047372);
  assert.equal(credit.netsuite_sync_status, 'cancelled');
  assert.equal(credit.netsuite_transaction_status, 'Deleted');
  assert.equal(balance.available, Math.max(balance.fulfilled - balance.netsuiteReturned - balance.localReserved, 0));
  console.log(JSON.stringify({ customerId: 8444, creditMemoId: 1047372, deletionConfirmedByStrictRead: true,
    balance: { fulfilled: balance.fulfilled, netsuiteReturned: balance.netsuiteReturned,
      localReserved: balance.localReserved, available: balance.available, lookedUpAt: balance.lookedUpAt },
    records, netSuiteRecordWrites: 0, netSuiteRequests: requests.length }));
} finally {
  globalThis.fetch = transport;
  await closeDb();
}
