import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, symlink, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const directory = await mkdtemp('/tmp/special-so-confirmation-mutants-');
const artifact = 'test-artifacts/special-so-122477/mutations';
const service = 'src/special-stock-request-service.js';
const marker = 'src/netsuite.js';
const repository = 'src/special-stock-request-repository.js';
const unit = 'test/mbt/unit/special-so-creation-confirmation.test.js';
const lookup = 'test/mbt/unit/special-so-creation-marker.test.js';
const integration = 'test/mbt/integration/special-so-creation-confirmation.test.js';
const mutations = [
  ['content-verification', service, 'const reference = await deps.fetchSalesOrderReference(remoteId);',
    'await deps.verifyDiscountSalesOrder(remoteId, {});\n      const reference = await deps.fetchSalesOrderReference(remoteId);', unit],
  ['customer-filter', service, 'entityId: null,', 'entityId: claimed.netsuiteCustomerId || claimed.customerId,', unit],
  ['external-id-omitted', marker, "UPPER(COALESCE(t.externalid, '')) = '${marker}'\n         OR UPPER", 'UPPER', lookup],
  ['empty-number-accepted', service,
    'if (!reference?.tranid) {\n        throw serviceError("The Sales Order exists but could not be hydrated from NetSuite.", "SPECIAL_REMOTE_HYDRATION_FAILED", 502);',
    'if (false) {\n        throw serviceError("The Sales Order exists but could not be hydrated from NetSuite.", "SPECIAL_REMOTE_HYDRATION_FAILED", 502);', unit],
  ['submitted-order-reposted', service,
    "if (claimed.salesOrderSubmissionStartedAt) throw serviceError('The SO submission already started. Its marker is not yet visible; recover again after NetSuite sync.', 'SPECIAL_REMOTE_OUTCOME_UNCERTAIN');",
    '', unit],
  ['webhook-content-attention', repository,
    "if (special && !special.purchase_order_netsuite_id\n      && !['creating', 'attention'].includes(special.purchase_order_operation_status)\n      && !quantityReviewPending(special.quantity_review)) return false;",
    'if (false) return false;', integration]
];
await mkdir(artifact, { recursive: true });
try {
  for (const name of ['src', 'public']) await cp(name, `${directory}/${name}`, { recursive: true });
  await cp('package.json', `${directory}/package.json`);
  await symlink('/app/node_modules', `${directory}/node_modules`);
  for (const name of [unit, lookup, integration]) {
    await mkdir(`${directory}/${name.substring(0, name.lastIndexOf('/'))}`, { recursive: true });
    await cp(name, `${directory}/${name}`);
  }
  const results = [];
  for (const propertyOnly of [false, true]) {
    for (const [name, file, before, after, testFile] of mutations) {
      if (propertyOnly && testFile === integration) continue;
      const path = `${directory}/${file}`, original = await readFile(path, 'utf8');
      assert.equal(original.split(before).length, 2, `Unique mutation anchor: ${name}`);
      await writeFile(path, original.replace(before, after));
      const args = ['--test', '--test-concurrency=1'];
      if (propertyOnly) args.push('--test-name-pattern=property');
      args.push(testFile);
      const result = spawnSync(process.execPath, args, { cwd: directory, encoding: 'utf8', timeout: 30000 });
      const log = (result.stdout || '') + (result.stderr || '');
      await writeFile(`${artifact}/${propertyOnly ? 'property-' : ''}${name}.log`, log);
      await writeFile(path, original);
      assert.ok(result.status !== 0 && /not ok/u.test(log) && !/SyntaxError|ERR_MODULE_NOT_FOUND/u.test(log), `Mutation survived or failed infrastructure: ${name}`);
      results.push({ name, propertyOnly, killed: true });
      console.log(JSON.stringify(results.at(-1)));
    }
  }
  await writeFile(`${artifact}/results.json`, JSON.stringify(results, null, 2) + '\n');
} finally { await rm(directory, { recursive: true, force: true }); }
