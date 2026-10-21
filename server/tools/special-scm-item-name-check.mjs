import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ESLint } from 'eslint';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.ok(process.env.DATABASE_URL.endsWith('/mbt_verify'));
const out = resolve('test-artifacts/special-workflow-review/scm-item-name-20260930');
const runtime = ['src/special-stock-request-domain.js', 'src/special-stock-request-repository.js',
  'public/scm-special-stock-requests.js', 'public/scm-stock-requests.html'];
const own = ['test/mbt/unit/special-scm-item-name.test.js', 'test/mbt/integration/special-scm-item-name.test.js'];
const existing = ['test/mbt/unit/special-workflow-review.test.js', 'test/mbt/unit/special-workflow-enquiry.test.js',
  'test/mbt/unit/special-workflow-polish.test.js', 'test/mbt/integration/special-workflow-review.test.js',
  'test/mbt/integration/special-workflow-enquiry.test.js', 'test/mbt/integration/special-batch-save.test.js',
  'test/mbt/integration/special-batch-browser.test.js', 'test/mbt/integration/special-enhancements-http.test.js',
  'test/mbt/unit/special-workflow-documents.test.js', 'test/mbt/unit/special-quote-discount-summary.test.js'];
const suites = [...existing, ...own];
const hash = source => createHash('sha256').update(source).digest('hex');
const sourceHashes = Object.fromEntries(runtime.map(file => [file, hash(readFileSync(file))]));
const failures = log => [...log.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]);
const summary = log => Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key => [key, Number(log.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] || 0)]));
function run(name, command, args, { cwd = process.cwd(), allowedFailure = false, browserDir = name } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 180000, maxBuffer: 30000000,
    env: { ...process.env, SPECIAL_BATCH_BROWSER_OUTPUT: out + '/' + browserDir } });
  const log = (result.stdout || '') + (result.stderr || '');
  writeFileSync(`${out}/${name}.log`, log);
  assert.ok(result.status === 0 || allowedFailure && result.status === 1 && failures(log).length,
    `${name}: ${log.slice(-6000)}`);
  console.log(JSON.stringify({ check: name, exitCode: result.status, ...summary(log) }));
  return { log, exitCode: result.status };
}
function tree(from = process.cwd()) {
  const root = mkdtempSync('/tmp/scm-item-name-check-');
  for (const folder of ['src', 'public', 'test', 'tools', 'migrations']) cpSync(from + '/' + folder, root + '/' + folder, { recursive: true });
  cpSync(from + '/package.json', root + '/package.json');
  symlinkSync(resolve('node_modules'), root + '/node_modules', 'dir');
  return root;
}

rmSync(out + '/coverage', { recursive: true, force: true });
rmSync(out + '/c8', { recursive: true, force: true });
const frozenRoot = tree();
assert.deepEqual(Object.fromEntries(runtime.map(file => [file, hash(readFileSync(frozenRoot + '/' + file))])), sourceHashes);
const baselineRoot = tree(frozenRoot);
let baseline;
try {
  const beforeFiles = Object.keys(JSON.parse(readFileSync(out + '/baseline.json')).files);
  for (const file of beforeFiles) cpSync(out + '/before/' + file, baselineRoot + '/' + file);
  const red = run('red-before', process.execPath, ['--test', '--test-concurrency=1', ...own], { cwd: baselineRoot, allowedFailure: true });
  assert.equal(summary(red.log).fail, 6, 'The captured sources must reproduce all six new failures');
  baseline = run('baseline-regressions', process.execPath, ['--test', '--test-concurrency=1', ...existing], { cwd: baselineRoot, allowedFailure: true });
  cpSync(frozenRoot + '/test/mbt/integration/special-enhancements-http.test.js', baselineRoot + '/test/mbt/integration/special-enhancements-http.test.js');
  const redHttp = run('red-http-before', process.execPath, ['--test', '--test-name-pattern=SCM item-name correction uses',
    'test/mbt/integration/special-enhancements-http.test.js'], { cwd: baselineRoot, allowedFailure: true });
  assert.equal(summary(redHttp.log).fail, 1);
  cpSync(frozenRoot + '/test/mbt/integration/special-batch-browser.test.js', baselineRoot + '/test/mbt/integration/special-batch-browser.test.js');
  const redBrowser = run('red-browser-before', process.execPath, ['--test', '--test-name-pattern=SCM edits item names awaiting',
    'test/mbt/integration/special-batch-browser.test.js'], { cwd: baselineRoot, allowedFailure: true });
  assert.equal(summary(redBrowser.log).fail, 2);
  const typesArgs = ['--noEmit', '--allowJs', '--checkJs', '--skipLibCheck', '--types', 'node',
    '--target', 'ES2022', '--module', 'NodeNext', ...runtime.filter(file => file.endsWith('.js'))];
  const diagnostics = (cwd, name) => {
    const result = spawnSync(resolve('node_modules/.bin/tsc'), typesArgs, { cwd, encoding: 'utf8', timeout: 180000, maxBuffer: 30000000 });
    const log = (result.stdout || '') + (result.stderr || '');
    writeFileSync(out + '/' + name + '.log', log);
    assert.ok(result.status === 0 || [1, 2].includes(result.status) && /error TS\d+/.test(log), log.slice(-2000));
    return log.split('\n').filter(line => /error TS\d+/.test(line)).map(line => line.replace(/\(\d+,\d+\)/g, '(location)')).sort();
  };
  const previousTypes = diagnostics(baselineRoot, 'types-baseline');
  const remainingTypes = [...previousTypes];
  const newTypes = diagnostics(frozenRoot, 'types-current').filter(message => {
    const index = remainingTypes.indexOf(message);
    if (index === -1) return true;
    remainingTypes.splice(index, 1); return false;
  });
  assert.deepEqual(newTypes, [], 'No new type diagnostics');
} finally { rmSync(baselineRoot, { recursive: true, force: true }); }

const lint = new ESLint({ overrideConfigFile: resolve('tools/stock-request-layout-eslint.config.mjs') });
const messages = async (source, file) => (await lint.lintText(source, { filePath: file }))[0].messages
  .map(({ ruleId, severity, message }) => ({ ruleId, severity, message }));
for (const file of runtime.filter(file => file.endsWith('.js'))) {
  run('syntax-' + file.split('/').at(-1), process.execPath, ['--check', file], { cwd: frozenRoot });
  assert.deepEqual(await messages(readFileSync(frozenRoot + '/' + file, 'utf8'), file), await messages(readFileSync(out + '/before/' + file, 'utf8'), file));
}
run('lint-tests', resolve('node_modules/.bin/eslint'), ['--config', resolve('tools/stock-request-layout-eslint.config.mjs'), '--max-warnings=0', ...own], { cwd: frozenRoot });
run('secrets', process.execPath, ['test/support/scan-diff-secrets.mjs', ...runtime, ...own, 'tools/special-scm-item-name-check.mjs']);

const mutantRoot = tree(frozenRoot);
const mutants = [
  ['blank-name-accepted', 'src/special-stock-request-domain.js', "required: true, label: 'Item name'", "required: false, label: 'Item name'", [own[0]]],
  ['item-name-not-saved', 'src/special-stock-request-repository.js', 'product_name = COALESCE($15, product_name)', 'product_name = COALESCE(product_name, $15)', [own[1]]],
  ['vendor-brand-not-saved', 'src/special-stock-request-repository.js', 'response_vendor_name = $7, brand = $7', 'response_vendor_name = $7, brand = COALESCE(response_vendor_name, brand)', [own[1]]],
  ['so-lock-bypassed', 'src/special-stock-request-repository.js', "if (special.sales_order_netsuite_id || special.sales_order_skipped) throw workflowError('Use the readiness", "if (false && (special.sales_order_netsuite_id || special.sales_order_skipped)) throw workflowError('Use the readiness", [own[1]]],
  ['issued-name-input', 'public/scm-special-stock-requests.js', '<span>Stock readiness</span>', '<span>Stock readiness</span><input name="productName" />',
    ['--test-name-pattern=SCM retains readiness fields', 'test/mbt/integration/special-batch-browser.test.js']],
  ['normalized-name-corrupted', 'src/special-stock-request-domain.js', 'productName: text(productName, {', "productName: text('WRONG', {", ['--test-name-pattern=^property:', own[0]]]
];
try {
  for (const [name, file, old, replacement, tests] of mutants) {
    const path = mutantRoot + '/' + file, source = readFileSync(path, 'utf8');
    assert.equal(source.split(old).length, 2, name + ' must have one target');
    try {
      writeFileSync(path, source.replace(old, replacement));
      const result = run('mutant-' + name, process.execPath, ['--test', ...tests], { cwd: mutantRoot, allowedFailure: true });
      assert.equal(result.exitCode, 1, name + ' survived');
    } finally { writeFileSync(path, source); }
  }
} finally { rmSync(mutantRoot, { recursive: true, force: true }); }
assert.deepEqual(Object.fromEntries(runtime.map(file => [file, hash(readFileSync(file))])), sourceHashes);
const final = run('final-regressions', resolve('node_modules/.bin/c8'), ['--all=false', '--check-coverage=false',
  ...runtime.filter(file => file.endsWith('.js')).map(file => '--include=' + file), '--temp-directory=' + out + '/c8',
  '--report-dir=' + out + '/coverage', '--reporter=json', process.execPath, '--test', '--test-concurrency=1', ...suites],
  { cwd: frozenRoot, allowedFailure: true, browserDir: 'browser-final' });
const newFailures = failures(final.log).filter(name => !failures(baseline.log).includes(name));
assert.deepEqual(newFailures, []);
const health = run('suite-health', process.execPath, ['--test', '--test-concurrency=1', ...suites.toReversed()], { cwd: frozenRoot, allowedFailure: true });
assert.deepEqual(failures(health.log).filter(name => !failures(baseline.log).includes(name)), []);
assert.deepEqual(Object.fromEntries(runtime.map(file => [file, hash(readFileSync(file))])), sourceHashes);
const measured = JSON.parse(readFileSync(out + '/coverage/coverage-final.json'));
const canonical = {};
for (const [path, entry] of Object.entries(measured)) {
  const file = runtime.find(file => path.endsWith('/' + file));
  assert.ok(file, 'Unexpected coverage source: ' + path);
  entry.path = resolve(file);
  canonical[entry.path] = entry;
}
writeFileSync(out + '/coverage/coverage-final.json', JSON.stringify(canonical));
run('changed-coverage', process.execPath, ['tools/special-scm-item-name-coverage.mjs']);
const result = { completed: true, sourceHashes, ...summary(final.log), newFailures,
  baselineFailures: failures(baseline.log), mutantsKilled: mutants.length, propertyMutantsKilled: 1,
  syntax: true, lint: 'zero new diagnostics', types: 'zero new diagnostics', suiteHealth: 'zero new failures',
  coverage: JSON.parse(readFileSync(out + '/coverage-result.json')), frozenSources: true,
  tools: { node: process.version, ...Object.fromEntries(['typescript', 'eslint', 'c8', 'fast-check', 'playwright']
    .map(name => [name, JSON.parse(readFileSync('node_modules/' + name + '/package.json')).version])) } };
writeFileSync(out + '/checks.json', JSON.stringify(result, null, 2) + '\n');
rmSync(frozenRoot, { recursive: true, force: true });
console.log(JSON.stringify(result));
