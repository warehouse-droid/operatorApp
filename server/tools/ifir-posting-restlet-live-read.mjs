// Operational read-only check. Run through Node stdin in the existing app container.
// Credentials stay in memory; this script only sends GET to the supplied deployment.
import { config } from './src/config.js';
import { getNetSuiteM2mAccessToken, getNetSuiteM2mStatus } from './src/netsuite-m2m-runtime.js';
import { netSuiteRequestScheduler } from './src/netsuite-request-scheduler.js';
import { closeDb } from './src/db.js';

const target = new URL('https://6518947.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=507&deploy=1');
const started = Date.now();
try {
  const account = String(config.netsuite.accountId).toLowerCase().replaceAll('_', '-');
  if (target.hostname !== `${account}.restlets.api.netsuite.com`
    || target.protocol !== 'https:' || target.pathname !== '/app/site/hosting/restlet.nl'
    || target.username || target.password || target.port || target.hash) {
    throw new Error('Deployment URL does not match the configured NetSuite account.');
  }
  const auth = await getNetSuiteM2mStatus();
  if (auth.prerequisites?.directAccessEnabled !== true
    || auth.authMode !== 'client_credentials' || !auth.active?.scopes?.includes('restlets')) {
    throw new Error('The existing connection does not have active M2M RESTlet access.');
  }
  const token = await getNetSuiteM2mAccessToken();
  const result = await netSuiteRequestScheduler.run(async signal => {
    const response = await fetch(target, {
      method: 'GET', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' }
    });
    const body = await response.text();
    let data;
    try {
      data = JSON.parse(body);
      if (typeof data === 'string') data = JSON.parse(data);
    } catch {
      data = { unparsedResponse: body.slice(0, 2000) };
    }
    return { status: response.status, contentType: response.headers.get('content-type'), data };
  }, { priority: 'background', timeoutMs: 30000 });
  const health = result.data;
  const expectedTransforms = ['PO:IR', 'SO:IF', 'TO:IF', 'TO:IR'];
  const checks = {
    http200: result.status === 200,
    healthy: health?.ok === true,
    contractVersion: health?.contractVersion === 1,
    productionAccount: health?.environment === 'PRODUCTION',
    activationFlags: typeof health?.writesEnabled === 'boolean' && typeof health?.productionAllowed === 'boolean',
    supportedTransforms: Array.isArray(health?.supportedTransforms)
      && health.supportedTransforms.length === expectedTransforms.length
      && expectedTransforms.every(pair => health.supportedTransforms.includes(pair)),
    savedRecordReadback: health?.savedRecordReadback === true,
    expectedLimits: health?.maxLines === 1000 && health?.explicitInventoryAssignments === false && health?.kits === false
  };
  const contractMatches = Object.values(checks).every(Boolean);
  console.log(JSON.stringify({
    observedAt: new Date().toISOString(), elapsedMs: Date.now() - started,
    method: 'GET', endpoint: target.toString(), authMode: auth.authMode,
    restletScopeActive: auth.active.scopes.includes('restlets'), ...result, checks, contractMatches,
    transactionPostingTested: false, applicationPostingConfigurationChanged: false
  }, null, 2));
  if (!contractMatches) process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({
    observedAt: new Date().toISOString(), method: 'GET', endpoint: target.toString(),
    error: { name: error.name, code: error.code || null, message: error.message },
    transactionPostingTested: false, applicationPostingConfigurationChanged: false
  }, null, 2));
  process.exitCode = 1;
} finally {
  await closeDb();
}
