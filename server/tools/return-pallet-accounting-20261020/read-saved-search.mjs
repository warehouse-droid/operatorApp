// Operational read-only verification. Run from /app via Node stdin.
// The deployment URL was supplied by the user. Credentials stay in memory.
import { config } from './src/config.js';
import { getNetSuiteM2mAccessToken, getNetSuiteM2mStatus } from './src/netsuite-m2m-runtime.js';
import { netSuiteRequestScheduler } from './src/netsuite-request-scheduler.js';
import { closeDb } from './src/db.js';

try {
  const customerId = String(process.env.PALLET_SEARCH_CUSTOMER_ID || '5240');
  if (!/^[1-9]\d*$/.test(customerId) || !Number.isSafeInteger(Number(customerId))) {
    throw new Error('A positive NetSuite customer internal ID is required.');
  }
  const target = new URL('https://6518947.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=505&deploy=1');
  const expectedAccount = String(config.netsuite.accountId).toLowerCase().replaceAll('_', '-');
  if (target.hostname !== `${expectedAccount}.restlets.api.netsuite.com`
    || target.protocol !== 'https:' || target.pathname !== '/app/site/hosting/restlet.nl') {
    throw new Error('Deployment URL does not match the configured NetSuite account.');
  }
  target.searchParams.set('customerId', customerId);
  const status = await getNetSuiteM2mStatus();
  if (status.authMode !== 'client_credentials' || !status.active?.scopes?.includes('restlets')) {
    throw new Error('The existing connection does not have active M2M RESTlet access.');
  }
  const token = await getNetSuiteM2mAccessToken();
  const started = Date.now();
  const result = await netSuiteRequestScheduler.run(async signal => {
    const response = await fetch(target, {
      method: 'GET',
      redirect: 'error',
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      }
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
      if (typeof data === 'string') data = JSON.parse(data);
    } catch {
      data = { unparsedResponse: text.slice(0, 2000) };
    }
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      data
    };
  }, { priority: 'background', timeoutMs: 60000 });
  console.log(JSON.stringify({
    observedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    endpoint: target.toString(),
    authMode: status.authMode,
    requestedScopes: status.active.scopes,
    ...result
  }));
  if (result.status !== 200 || result.data?.savedSearchId !== 'customsearch503'
    || String(result.data?.customerId) !== customerId) {
    process.exitCode = 1;
  }
} finally {
  await closeDb();
}
