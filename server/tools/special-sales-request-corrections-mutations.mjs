import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, symlinkSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.equal(new URL(process.env.DATABASE_URL).hostname, 'mbbs-special-updates-db-20261002');
const out = resolve('test-artifacts/special-workflow-review/sales-request-corrections-20261003/mutations'); mkdirSync(out, { recursive: true });
const root = mkdtempSync('/tmp/stock-updates-mutations-');
const mutations = [
  ['declined-in-quote', 'src/special-stock-documents.js', "!['declined', 'closed'].includes(line.salesDecision)", 'true'],
  ['fee-not-planned', 'public/special-stock-case-edits.js', 'deliveryFeeRate = candidate;', 'deliveryFeeRate = undefined;'],
  ['fee-not-persisted', 'src/special-stock-request-repository.js', 'SET delivery_fee_rate=$2 WHERE request_id=$1', 'SET delivery_fee_rate=$2*0 WHERE request_id=$1'],
  ['draft-fee-stale', 'src/special-stock-request-repository.js', "description='Delivery Charge',quantity=1,uom=NULL,unit_rate=$2,updated_at=now()", "description='Delivery Charge',quantity=1,uom=NULL,unit_rate=$2*0,updated_at=now()"],
  ['note-html-injection', 'public/special-stock-line-notes.js', '${escape(value)}', '${value}']
];
try {
  for (const dir of ['src', 'public', 'migrations', 'test']) cpSync(dir, root + '/' + dir, { recursive: true });
  cpSync('package.json', root + '/package.json'); symlinkSync(resolve('node_modules'), root + '/node_modules', 'dir');
  const control = spawnSync(process.execPath, ['--test', '--test-concurrency=1', 'test/mbt/unit/special-sales-request-corrections.test.js', 'test/mbt/integration/special-sales-request-corrections-http.test.js'],
    { cwd: root, env: process.env, encoding: 'utf8', timeout: 60000 });
  writeFileSync(out + '/control.log', (control.stdout || '') + (control.stderr || ''));
  assert.equal(control.status, 0, 'The unmodified mutation control must pass');
  const results = [];
  for (const [name, file, from, to] of mutations) {
    const source = readFileSync(file, 'utf8'); assert.ok(source.includes(from), name);
    writeFileSync(root + '/' + file, source.replace(from, to));
    try {
      assert.equal(spawnSync(process.execPath, ['--check', file], { cwd: root }).status, 0, 'Mutant must compile');
      const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', 'test/mbt/unit/special-sales-request-corrections.test.js', 'test/mbt/integration/special-sales-request-corrections-http.test.js'],
        { cwd: root, env: process.env, encoding: 'utf8', timeout: 30000 });
      const log = (result.stdout || '') + (result.stderr || ''); writeFileSync(out + '/' + name + '.log', log);
      assert.equal(result.status, 1, name + ' must be killed by a behavioral assertion');
      assert.match(log, /failureType: 'testCodeFailure'/);
      const property = spawnSync(process.execPath, ['--test', '--test-name-pattern=Property:', 'test/mbt/unit/special-sales-request-corrections.test.js'],
        { cwd: root, env: process.env, encoding: 'utf8', timeout: 30000 });
      assert.ok([0, 1].includes(property.status), 'Property-only mutant run must complete');
      writeFileSync(out + '/' + name + '-property.log', (property.stdout || '') + (property.stderr || ''));
      results.push({ name, killed: true, propertyOnlyKilled: property.status === 1 }); console.log(name + ': killed');
    } finally { writeFileSync(root + '/' + file, source); }
  }
  writeFileSync(out + '/results.json', JSON.stringify(results, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
