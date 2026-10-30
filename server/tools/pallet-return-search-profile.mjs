// Read-only operational diagnostic, executed via stdin from /app in the live app.
import assert from 'node:assert/strict';
import { lookupReturnSalesOrder } from './src/return-repository.js';
import { withOperatorNetSuitePriority } from './src/operator-netsuite-request-pool.js';
import { query, withTransaction, closeDb } from './src/db.js';

const transport = globalThis.fetch;
let requests = [];
let measurementStartedAt = 0;
globalThis.fetch = async (url, options = {}) => {
  const pathname = new URL(String(url)).pathname;
  const sql = pathname.includes('/query/v1/suiteql') ? JSON.parse(options.body).q : '';
  if ((options.method || 'GET') !== 'GET' && !/^\s*SELECT\b/i.test(sql) && !pathname.includes('/token')) {
    throw new Error('Diagnostic blocked a non-read NetSuite request.');
  }
  const category = sql.includes('return_pallet_order_header') ? 'order-header'
    : sql.includes('AS sales_quantity') ? 'order-lines'
      : sql.includes('return_pallet_credit_identity') ? 'credit-identities'
        : sql.includes('return_ra_credit_lines') ? 'linked-credits'
          : pathname.includes('restlet.nl') ? 'saved-search' : sql ? 'other-query' : 'other-read';
  const start = performance.now();
  const response = await transport(url, options);
  requests.push({ category, status: response.status, startedAfterMs: Math.round(start - measurementStartedAt),
    elapsedMs: Math.round(performance.now() - start) });
  return response;
};

async function measured(code, mode, work) {
  requests = [];
  const start = performance.now();
  measurementStartedAt = start;
  const result = await withOperatorNetSuitePriority(work);
  console.log(JSON.stringify({ at: new Date().toISOString(), phase: process.env.PALLET_PROFILE_PHASE,
    code, mode, elapsedMs: Math.round(performance.now() - start), requests }));
  return result;
}

try {
  for (const code of ['SOM07260', 'SOB122269', 'SOB123589']) {
    const value = await measured(code, 'complete-pallet-lookup', () => withTransaction(async () => {
      await query('SET TRANSACTION READ ONLY');
      return lookupReturnSalesOrder({ code, receivingLocationId: 1, includeStockReturns: false,
        includeNetSuiteOrderLines: false, enforceYardRestriction: false });
    }, { rollback: true }));
    assert.equal(value.palletBalance.source, 'netsuite_saved_search');
    console.log(JSON.stringify({ code, phase: process.env.PALLET_PROFILE_PHASE, customerId: value.customer.id,
      available: value.palletBalance.available, lookedUpAt: value.palletBalance.lookedUpAt }));
  }
} finally {
  globalThis.fetch = transport;
  await closeDb();
}
