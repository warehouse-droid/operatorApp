// Run via Node stdin in the production app after deployment. No return is submitted.
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root = pathToFileURL(`${process.cwd()}/`);
const { lookupReturnCustomerPalletBalance } = await import(new URL('src/return-repository.js', root));
const { closeDb } = await import(new URL('src/db.js', root));
const started = Date.now();
try {
  const balance = await lookupReturnCustomerPalletBalance(5240);
  const result = {
    observedAt: new Date().toISOString(), elapsedMs: Date.now() - started,
    customerId: balance.customer.id, customerCode: balance.customer.code,
    itemId: balance.item.id, fulfilled: balance.fulfilled,
    netsuiteReturned: balance.netsuiteReturned, localReserved: balance.localReserved,
    available: balance.available, lookedUpAt: balance.lookedUpAt,
    sourceHash: createHash('sha256').update(readFileSync('src/return-netsuite.js')).digest('hex'),
    matchesInvestigatedBalance: balance.fulfilled === 206 && balance.netsuiteReturned === 194
      && balance.localReserved === 0 && balance.available === 12
  };
  console.log(JSON.stringify(result));
  if (!result.matchesInvestigatedBalance) {
    process.exitCode = 1;
  }
} finally {
  await closeDb();
}
