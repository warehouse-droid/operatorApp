import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, cpSync, mkdtempSync, mkdirSync, symlinkSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.ok(process.env.DATABASE_URL.endsWith('/mbt_verify'));
const out = 'test-artifacts/special-workflow-review/po-line-discount-20260928';
const runtime = JSON.parse(readFileSync(`${out}/runtime-files.json`));
const js = runtime.filter(f => f.endsWith('.js'));
const own = ['test/mbt/unit/special-po-line-discount.test.js', 'test/mbt/unit/special-native-po-restlet.test.js', 'test/mbt/unit/special-workflow-native-po.test.js', 'test/mbt/unit/special-workflow-quantity-service.test.js', 'test/mbt/integration/special-workflow-description-race.test.js', 'test/mbt/unit/special-discount-summary.test.js', 'test/mbt/unit/special-purchase-discount-reps.test.js',
  'test/mbt/integration/special-batch-save.test.js', 'test/mbt/integration/special-batch-browser.test.js', 'test/mbt/integration/special-standalone-po.test.js'];
const tests = [...new Set([...JSON.parse(readFileSync(`${out}/suite-files.json`)), ...own,
  'test/mbt/integration/special-stock-alert-browser.test.js'])];
function run(name, command, args, { failure = false, cwd = process.cwd() } = {}) {
  const r = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 300000, maxBuffer: 20 * 1024 * 1024 });
  const log = (r.stdout || '') + (r.stderr || ''); writeFileSync(`${out}/${name}.log`, log);
  if (failure) assert.ok(r.status !== 0 && /^not ok /m.test(log), `${name} survived`);
  else assert.equal(r.status, 0, `${name} failed: ${log.slice(-2500)}`);
  console.log(JSON.stringify({ check: name, passed: true })); return log;
}
for (const file of js) run('syntax-' + file.split('/').pop(), process.execPath, ['--check', file]);
run('types', 'node_modules/.bin/tsc', ['--noEmit', '--allowJs', '--checkJs', '--skipLibCheck', '--types', 'node', '--target', 'ES2022', '--module', 'NodeNext',
  'public/special-stock-purchase-pricing.js', 'src/special-stock-discount-total.js', 'src/special-stock-rest-orders.js', 'src/special-stock-adjustment-adapter.js', 'src/special-stock-netsuite-adapter.js', 'src/special-stock-native-po-adapter.js']);
run('lint', 'node_modules/.bin/eslint', ['--config', 'tools/stock-request-layout-eslint.config.mjs', '--max-warnings=0', ...js.filter(f => f !== 'src/server.js'), ...own, 'tools/special-po-line-check.mjs']);
for(const entry of readdirSync(out).filter(name=>name.startsWith('browser-coverage-'))) unlinkSync(`${out}/${entry}`);
const suite = run('feature-final', 'node_modules/.bin/c8', ['--all=false', '--check-coverage=false', ...js.map(f => `--include=${f}`),
  `--temp-directory=${out}/c8`, `--report-dir=${out}/coverage`, '--reporter=json', process.execPath, '--test', '--test-concurrency=1', ...tests]);
run('suite-health', process.execPath, ['--test', '--test-concurrency=1', ...own.toReversed()]);
const root = mkdtempSync('/tmp/special-commercial-mutants-');
for (const folder of ['src', 'public']) cpSync(folder, `${root}/${folder}`, { recursive: true });
cpSync('package.json', `${root}/package.json`); symlinkSync(resolve('node_modules'), `${root}/node_modules`, 'dir');
mkdirSync(`${root}/test/mbt/unit`, { recursive: true });
cpSync('test/mbt', `${root}/test/mbt`, {recursive:true});
cpSync('netsuite-smart-scm-picking-ticket-restlet.js', `${root}/netsuite-smart-scm-picking-ticket-restlet.js`);
const mutants = [
  ['public/special-stock-purchase-pricing.js', 'const discount = reviewed.reduce', 'const discount = reviewed.slice(0,1).reduce', 'unit/special-po-line-discount', true],
  ['public/special-stock-purchase-pricing.js', "if (line.vendorDiscountPercent == null || String(line.vendorDiscountPercent).trim() === '')", 'if (false)', 'unit/special-po-line-discount', true],
  ['src/special-stock-native-po-adapter.js', 'const appendDiscount = discountMissing(po,discount);', 'const appendDiscount = Boolean(discount);', 'unit/special-workflow-native-po', false],
  ['src/special-stock-request-repository.js', "if (special.vendor_discount_review?.mode === 'per_line')", 'if (false)', 'integration/special-workflow-description-race', false],
  ['src/special-stock-request-service.js', 'createPurchaseOrder: createPurchaseOrderInNetSuite,', 'createPurchaseOrder: createSalesOrderInNetSuite,', 'integration/special-standalone-po', false]
];
for (const [i, [file, old, replacement, name, property]] of mutants.entries()) {
  const path = `${root}/${file}`, source = readFileSync(path, 'utf8'); assert.equal(source.split(old).length, 2);
  try {
    writeFileSync(path, source.replace(old, replacement));
    run(`mutant-${i+1}`, process.execPath, ['--test', ...(property ? ['--test-name-pattern=^property:'] : []), `test/mbt/${name}.test.js`], { failure: true, cwd: root });
  } finally { writeFileSync(path, source); }
  assert.equal(readFileSync(file, 'utf8'), source);
}
run('secrets', process.execPath, ['test/support/scan-diff-secrets.mjs', ...runtime, ...own, 'tools/special-po-line-check.mjs']);
const manifest = Object.fromEntries(runtime.map(f => [f, createHash('sha256').update(readFileSync(f)).digest('hex')]));
writeFileSync(`${out}/source-manifest.json`, JSON.stringify(manifest, null, 2));
const summary = { completed: true, tests: Number(/^# tests (\d+)$/m.exec(suite)?.[1]), pass: Number(/^# pass (\d+)$/m.exec(suite)?.[1]), fail: Number(/^# fail (\d+)$/m.exec(suite)?.[1]),
  mutantsKilled: mutants.length, propertyMutantsKilled: 2, syntax: true, lint: true, types: true, fullRegressionRun: false, backupsRun: false,
  tools: { node: process.version, ...Object.fromEntries(['typescript', 'eslint', 'c8', 'fast-check', 'playwright'].map(name => [name, JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version])) } };
writeFileSync(`${out}/checks.json`, JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary));
run('coverage',process.execPath,['tools/special-po-line-coverage.mjs']);
