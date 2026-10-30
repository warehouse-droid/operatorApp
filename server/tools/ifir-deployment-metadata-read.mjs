// Operational GET only; token stays in the existing app process.
import { config } from './src/config.js';
import { getNetSuiteM2mAccessToken } from './src/netsuite-m2m-runtime.js';
import { netSuiteRequestScheduler } from './src/netsuite-request-scheduler.js';
import { closeDb } from './src/db.js';
try {
  const token = await getNetSuiteM2mAccessToken();
  const url = `${config.netsuite.restBaseUrl.replace(/\/$/, '')}/record/v1/metadata-catalog/scriptDeployment`;
  const result = await netSuiteRequestScheduler.run(async signal => {
    const response = await fetch(url, { method: 'GET', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/schema+json' } });
    return { status: response.status, body: (await response.text()).slice(0, 4000) };
  }, { priority: 'background', timeoutMs: 30000 });
  console.log(JSON.stringify({ observedAt: new Date().toISOString(), ...result }));
} finally { await closeDb(); }
