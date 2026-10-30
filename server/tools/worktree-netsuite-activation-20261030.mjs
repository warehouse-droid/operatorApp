// Use worktree-netsuite-activation-20261030.py to supply the local script inventory.
// Only health requests, a saved-search read, and SELECT metadata queries are issued.
import {config} from './src/config.js';
import {closeDb} from './src/db.js';
import {probeNetSuiteRestlet, readNetSuiteRestlet, callFieldSalesRestlet} from './src/netsuite.js';
import {isNetSuiteM2mActive, getNetSuiteM2mAccessToken} from './src/netsuite-m2m-runtime.js';

const entries = JSON.parse(process.argv[2] || '[]');
const report = {at: new Date().toISOString(), readOnly: true, endpoints: {}, inventory: []};
const keys = ['ok', 'version', 'contractVersion', 'environment', 'sandbox', 'capabilities',
  'writesEnabled', 'productionAllowed', 'customerMode', 'savedRecordReadback', 'supportedTransforms',
  'explicitInventoryAssignments', 'kits', 'quantityPolicies', 'savedSearchId'];
const select = value => Object.fromEntries(keys.filter(key => key in value).map(key => [key, value[key]]));
async function check(name, configured, read) {
  if (!configured) {report.endpoints[name] = {configured: false}; return;}
  try {report.endpoints[name] = {configured: true, reachable: true, ...select(await read())};}
  catch (error) {report.endpoints[name] = {configured: true, reachable: false, code: error.code || null,
    message: String(error.message).replace(/https?:\/\/\S+/g, '[endpoint]').slice(0, 500)};}
}
try {
  await check('smartScm', config.smartScm?.pickingTicketRestletUrl, () => probeNetSuiteRestlet({requireSandbox: false}));
  await check('ifirPosting', config.netsuite.ifirPostingRestletUrl,
    () => readNetSuiteRestlet(config.netsuite.ifirPostingRestletUrl));
  const previous = process.env.FIELD_SALES_NETSUITE_REQUIRE_SANDBOX;
  try {
    // This affects this read-only probe process only, never the application settings.
    process.env.FIELD_SALES_NETSUITE_REQUIRE_SANDBOX = 'false';
    await check('fieldSales', process.env.FIELD_SALES_RESTLET_URL, () => callFieldSalesRestlet('order.health'));
  } finally {
    if (previous === undefined) delete process.env.FIELD_SALES_NETSUITE_REQUIRE_SANDBOX;
    else process.env.FIELD_SALES_NETSUITE_REQUIRE_SANDBOX = previous;
  }
  await check('palletBalance', config.netsuite.palletBalanceRestletUrl, () => {
    const url = new URL(config.netsuite.palletBalanceRestletUrl);
    url.searchParams.set('customerId', '1');
    return readNetSuiteRestlet(url.toString());
  });
  if (await isNetSuiteM2mActive()) {
    const token = await getNetSuiteM2mAccessToken();
    const query = async q => {
      const endpoint = new URL('/services/rest/query/v1/suiteql?limit=1000', config.netsuite.restBaseUrl);
      const response = await fetch(endpoint, {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'transient'},
        body: JSON.stringify({q})});
      const body = await response.json();
      if (!response.ok || body.hasMore) throw new Error(`Incomplete script inventory query (${response.status})`);
      return body.items || [];
    };
    const scripts = await query('SELECT id, scriptid, name, isinactive, scriptfile FROM script');
    const deployments = await query('SELECT id, scriptid, script, isdeployed, status, recordtype FROM scriptdeployment');
    const ids = scripts.map(row => String(row.scriptfile || '')).filter(id => /^\d+$/.test(id));
    const names = entries.map(row => {
      if (!/^[a-z0-9_-]+\.js$/.test(row.name)) throw new Error('Invalid local script filename');
      return `'${row.name}'`;
    });
    const files = await query(`SELECT id, name, folder, lastmodifieddate FROM file WHERE id IN (${ids.join(',')})`
      + (names.length ? ` OR LOWER(name) IN (${names.join(',')})` : ''));
    const normalized = name => name.toLowerCase().replace(/_\d{4,8}(?=\.js$)/, '');
    for (const entry of entries) {
      const uploaded = files.filter(file => normalized(file.name) === entry.name);
      const matching = scripts.filter(script => uploaded.some(file => file.id === script.scriptfile));
      const matches = matching.map(script => ({id: script.id, scriptId: script.scriptid,
        name: script.name, inactive: script.isinactive === 'T', file: uploaded.find(file => file.id === script.scriptfile)?.name,
        deployments: deployments.filter(deployment => deployment.script === script.id).map(deployment => ({
          id: deployment.id, scriptId: deployment.scriptid, deployed: deployment.isdeployed === 'T', status: deployment.status,
          recordType: deployment.recordtype || null}))}));
      const active = matches.some(script => !script.inactive && script.deployments.some(deployment => deployment.deployed));
      const status = entry.type === 'library' ? (uploaded.length ? 'supporting-file-present' : 'supporting-file-missing')
        : active ? 'deployed' : matching.length ? 'inactive-or-not-deployed'
          : uploaded.length ? 'uploaded-without-script-record' : 'no-matching-file-or-script';
      report.inventory.push({...entry, status, uploadedFiles: uploaded.map(file => ({id: file.id, name: file.name,
        modified: file.lastmodifieddate})), scripts: matches});
    }
    report.metadata = {complete: true, scriptRecordsChecked: scripts.length, deploymentRecordsChecked: deployments.length,
      matchingAndReferencedFilesChecked: files.length, sourceContentCompared: false};
    const file = files.find(row => row.name === 'netsuite-ifir-posting-restlet.js');
    if (file) {
      const response = await fetch(new URL('/services/rest/record/v1/file/' + file.id, config.netsuite.restBaseUrl), {
        headers: {Authorization: `Bearer ${token}`, Accept: 'application/json'}, redirect: 'error', signal: AbortSignal.timeout(30000)});
      const body = await response.json();
      report.metadata.sourceFileRead = {status: response.status, available: response.ok,
        errors: (body['o:errorDetails'] || []).map(row => ({code: row['o:errorCode'], detail: row.detail}))};
    }
  } else report.metadata = {complete: false, reason: 'M2M metadata read unavailable'};
} finally {await closeDb();}
console.log(JSON.stringify(report));
