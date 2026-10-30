import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import assert from 'node:assert/strict';
import pg from 'pg';
// The legacy Special Order regression expects its standard inventory fixture.
const database = new URL(process.env.DATABASE_URL);
assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.equal(database.hostname, 'db');
assert.equal(database.pathname, '/mbt_test');
const fixtureDb = new pg.Client({connectionString: database.href});
try {
  await fixtureDb.connect();
  await fixtureDb.query("INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(2055,'MBBS-Special Order','PC','{}',now()) ON CONFLICT DO NOTHING");
} finally { await fixtureDb.end(); }
const files = JSON.parse(readFileSync('tools/backorder-add-items-files.json', 'utf8'));
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const sourceHashes = Object.fromEntries(files.map(file => [file, hash(file)]));
const focused = ['test/mbt/property/backorder-add-items.property.test.js', 'test/mbt/integration/backorder-add-items.test.js', 'test/mbt/integration/backorder-add-items-browser.test.js'];
const suites = [...focused,
  'test/mbt/unit/backorder-workflow.test.js', 'test/mbt/unit/backorder-review-flow.test.js',
  'test/mbt/unit/special-sales-items-copy.test.js',
  'test/mbt/property/backorder-routing.property.test.js',
  'test/mbt/integration/backorder-requests.test.js', 'test/mbt/integration/backorder-routing.test.js',
  'test/mbt/integration/backorder-review-flow.test.js', 'test/mbt/integration/backorder-already-ordered.test.js',
  'test/mbt/integration/backorder-review-flow-browser.test.js',
  'test/mbt/integration/regular-stock-add-items.test.js',
  'test/mbt/integration/special-sales-items-copy-http.test.js', 'test/mbt/integration/special-sales-items-copy-browser.test.js'];
const steps = [
  ['static', ['tools/backorder-add-items-static.mjs']],
  ['tests', ['node_modules/c8/bin/c8.js', '--all', '--check-coverage=false', ...files.filter(file => file.endsWith('.js')).map(file => `--include=${file}`),
    '--temp-directory=test-artifacts/add-items-c8', '--report-dir=test-artifacts/mbr-aggregate-coverage', '--reporter=json',
    'node', 'tools/backorder-add-items-report.mjs', ...suites]],
  ['coverage', ['tools/stock-request-followups-coverage.mjs', '--require-complete']],
  ['reverse', ['tools/backorder-add-items-report.mjs', ...focused.toReversed()]],
  ['mutations', ['tools/backorder-add-items-mutations.mjs']]
];
const results = [];
for (const [name, args] of steps) {
  console.log(`Add item: ${name}`);
  const child = spawn(process.execPath, args, {env: {...process.env, RECEIPT_BASELINE_CAPTURE: '0',
    NODE_OPTIONS: '--require=/app/tools/regular-stock-add-items-test-env.cjs'}});
  let output = '';
  child.stdout.on('data', value => {output += value; process.stdout.write(value);});
  child.stderr.on('data', value => {output += value; process.stderr.write(value);});
  const exitCode = await new Promise((resolve, reject) => {child.on('error', reject); child.on('close', code => resolve(code ?? 1));});
  writeFileSync(`test-artifacts/add-items-${name}.log`, output);
  const audit = ['tests', 'reverse'].includes(name) && existsSync('test-artifacts/mbt-uat-results.json') ? JSON.parse(readFileSync('test-artifacts/mbt-uat-results.json', 'utf8')) : null;
  results.push({name, exitCode, ...(audit ? {tests: audit.tests, pass: audit.pass, fail: audit.fail, baselineFailures:audit.baselineFailures, newFailures:audit.newFailures, files: audit.fileCount} : {})});
  if (exitCode) break;
}
const json = name => existsSync(`test-artifacts/${name}.json`) ? JSON.parse(readFileSync(`test-artifacts/${name}.json`, 'utf8')) : null;
const report = {createdAt: new Date().toISOString(), sourceHashes, steps: results,
  sourceDrift: files.filter(file => hash(file) !== sourceHashes[file]),
  static: json('mbr-aggregate-static'), coverage: json('mbr-aggregate-changed-coverage'), mutations: json('backorder-add-items-mutations'),
  toolchain: {node: process.version, ...Object.fromEntries(['typescript', 'eslint', 'c8', 'fast-check', 'playwright'].map(name =>
    [name, JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')).version]))}};
report.passed = results.length === steps.length && results.every(row => row.exitCode === 0) && !report.sourceDrift.length;
writeFileSync('test-artifacts/backorder-add-items-validation.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
