import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, symlinkSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.equal(new URL(process.env.DATABASE_URL).hostname, 'mbbs-special-updates-db-20261002');
const out = resolve('test-artifacts/special-workflow-review/stock-updates-20261002/mutations'); mkdirSync(out, { recursive: true });
const root = mkdtempSync('/tmp/stock-updates-mutations-');
const mutations = [
  ['low-inventory-unavailable', 'public/special-stock-workflow.js', "status === 'in_stock' || status === 'low_inventory'", "status === 'in_stock'"],
  ['pending-stage-lost', 'public/special-stock-workflow.js', "if (evidence.pendingUpdate) return 'pending_update'", "if (evidence.pendingUpdate) return 'new_enquiry'"],
  ['stock-check-before-update', 'src/special-stock-request-repository.js', "if (!allowPendingUpdate && special.information_request?.status === 'pending')", "if (false && !allowPendingUpdate && special.information_request?.status === 'pending')"],
  ['partial-fulfillment-green', 'public/special-stock-case-status.js', 'const fulfilled = !partial && Boolean(', 'const fulfilled = partial || Boolean('],
  ['sales-po-preview', 'public/special-stock-case-status.js', "(audience === 'scm' || kind === 'sales_order')", 'true'],
  ['missing-stocking-customer', 'public/regular-stock-ui.js', 'return name ? `<span class="regular-stock-customer">', 'return false ? `<span class="regular-stock-customer">'],
  ['sales-yard-bypass', 'src/special-stock-request-repository.js', "if (answering) assertScope(mapCase(special), context.authorizedStoreLocationIds || []);", 'if (false) assertScope(mapCase(special), context.authorizedStoreLocationIds || []);']
];
try {
  for (const dir of ['src', 'public', 'migrations', 'test']) cpSync(dir, root + '/' + dir, { recursive: true });
  cpSync('package.json', root + '/package.json'); symlinkSync(resolve('node_modules'), root + '/node_modules', 'dir');
  const results = [];
  for (const [name, file, from, to] of mutations) {
    const source = readFileSync(file, 'utf8'); assert.ok(source.includes(from), name);
    writeFileSync(root + '/' + file, source.replace(from, to));
    try {
      assert.equal(spawnSync(process.execPath, ['--check', file], { cwd: root }).status, 0, 'Mutant must compile');
      const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', 'test/mbt/unit/special-stock-updates.test.js', 'test/mbt/integration/special-stock-updates.test.js'],
        { cwd: root, env: process.env, encoding: 'utf8', timeout: 30000 });
      const log = (result.stdout || '') + (result.stderr || ''); writeFileSync(out + '/' + name + '.log', log);
      assert.equal(result.status, 1, name + ' must be killed by a behavioral assertion');
      assert.match(log, /failureType: 'testCodeFailure'/);
      const property = spawnSync(process.execPath, ['--test', '--test-name-pattern=Pending Update takes priority', 'test/mbt/unit/special-stock-updates.test.js'],
        { cwd: root, env: process.env, encoding: 'utf8', timeout: 30000 });
      assert.ok([0, 1].includes(property.status), 'Property-only mutant run must complete');
      writeFileSync(out + '/' + name + '-property.log', (property.stdout || '') + (property.stderr || ''));
      results.push({ name, killed: true, propertyOnlyKilled: property.status === 1 }); console.log(name + ': killed');
    } finally { writeFileSync(root + '/' + file, source); }
  }
  writeFileSync(out + '/results.json', JSON.stringify(results, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
