import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, symlinkSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.equal(new URL(process.env.DATABASE_URL).hostname, 'mbbs-special-updates-db-20261002');
const out = resolve('test-artifacts/special-workflow-review/sales-internal-remark-20261003/mutations'); mkdirSync(out, { recursive: true });
const root = mkdtempSync('/tmp/stock-updates-mutations-');
const mutations = [
  ['length-overflow', 'public/special-stock-internal-remark.js', 'value.length > 8000', 'value.length > 8001'],
  ['whitespace-lost', 'public/special-stock-internal-remark.js', "return value.replace", "return value.trim().replace"],
  ['scm-privacy-bypass', 'src/special-stock-request-policy.js', "audience !== 'sales'", "!['sales', 'scm'].includes(audience)"],
  ['revision-check-bypass', 'src/special-stock-request-repository.js', 'mapCase(await lockCase(id, input.expectedRevision))', 'mapCase(await selectCaseRow(id))'],
  ['remark-not-persisted', 'src/special-stock-request-repository.js', 'SET sales_internal_remark=$2,updated_at=now()', 'SET sales_internal_remark=substring($2 from 1 for 0),updated_at=now()'],
  ['quote-leaks-remark', 'src/special-stock-documents.js', "draft ? 'Draft quote' : '', detail.remarks", "draft ? 'Draft quote' : '', detail.remarks, detail.salesInternalRemark"]
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
      const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', 'test/mbt/unit/special-sales-internal-remark.test.js', 'test/mbt/integration/special-sales-internal-remark-http.test.js'],
        { cwd: root, env: process.env, encoding: 'utf8', timeout: 30000 });
      const log = (result.stdout || '') + (result.stderr || ''); writeFileSync(out + '/' + name + '.log', log);
      assert.equal(result.status, 1, name + ' must be killed by a behavioral assertion');
      assert.match(log, /failureType: 'testCodeFailure'/);
      const property = spawnSync(process.execPath, ['--test', '--test-name-pattern=Property:', 'test/mbt/unit/special-sales-internal-remark.test.js'],
        { cwd: root, env: process.env, encoding: 'utf8', timeout: 30000 });
      assert.ok([0, 1].includes(property.status), 'Property-only mutant run must complete');
      writeFileSync(out + '/' + name + '-property.log', (property.stdout || '') + (property.stderr || ''));
      results.push({ name, killed: true, propertyOnlyKilled: property.status === 1 }); console.log(name + ': killed');
    } finally { writeFileSync(root + '/' + file, source); }
  }
  writeFileSync(out + '/results.json', JSON.stringify(results, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
