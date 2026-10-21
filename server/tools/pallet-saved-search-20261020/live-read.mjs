// Run with Node stdin from /app in the production app. No return is submitted.
// Only request categories, durations and selected balance fields are recorded.
import { lookupReturnCustomerPalletBalance } from './src/return-repository.js';
import { query, closeDb } from './src/db.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const transport = globalThis.fetch;
let requests = [];
globalThis.fetch = async (url, options = {}) => {
  const address = new URL(String(url));
  let category = 'other-read';
  if (address.pathname.includes('/token')) { category = 'authentication'; }
  else if (address.pathname === '/app/site/hosting/restlet.nl') { category = 'saved-search'; }
  else if (address.pathname.includes('/query/')) {
    const sql = JSON.parse(options.body || '{}').q || '';
    category = sql.includes("'ItemShip' AS transaction_type") ? 'historical-balance'
      : sql.includes('return_pallet_credit_identity') ? 'credit-identities' : 'other-suiteql';
  }
  const method = options.method || 'GET';
  if (method !== 'GET' && category === 'other-read') {
    throw new Error('Live balance probe blocked an unexpected write request.');
  }
  const start = performance.now();
  const response = await transport(url, options);
  requests.push({ category, method, status: response.status, elapsedMs: Math.round(performance.now() - start) });
  return response;
};

try {
  const locals = await query(`SELECT count(*)::int AS n FROM return_records
    WHERE customer_id IN (5240,1959) AND record_type='pallet' AND status NOT IN ('rejected','voided')`);
  if (locals.rows[0].n !== 0) {
    throw new Error('These customers now have local returns; review them before running this no-return probe.');
  }
  const samples = [];
  for (const customerId of [5240, 1959, 5240, 1959]) {
    requests = [];
    const start = performance.now();
    const value = await lookupReturnCustomerPalletBalance(customerId);
    const sample = {
      customerId, customerCode: value.customer.code,
      source: value.source || 'netsuite_itemship_creditmemo_transactions',
      savedSearchId: value.savedSearchId || null,
      netBalance: value.netBalance ?? null, fulfilled: value.fulfilled,
      netsuiteReturned: value.netsuiteReturned, localReserved: value.localReserved,
      available: value.available, balanceFound: value.balanceFound,
      elapsedMs: Math.round(performance.now() - start),
      lookedUpAt: value.lookedUpAt, requests: [...requests]
    };
    samples.push(sample);
  }
  console.log(JSON.stringify({
    observedAt: new Date().toISOString(),
    sourceHash: createHash('sha256').update(readFileSync('src/return-netsuite.js')).digest('hex'),
    samples
  }));
} finally {
  globalThis.fetch = transport;
  await closeDb();
}
