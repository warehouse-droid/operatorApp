import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ESLint } from 'eslint';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.equal(new URL(process.env.DATABASE_URL).hostname, 'mbbs-special-updates-db-20261002');
const out = resolve('test-artifacts/special-workflow-review/stock-updates-20261002'); mkdirSync(out, { recursive: true });
const files = JSON.parse(readFileSync('tools/special-stock-updates-files.json'));
const js = files.filter(file => file.endsWith('.js'));
const own = ['test/mbt/unit/special-stock-updates.test.js', 'test/mbt/integration/special-stock-updates.test.js',
  'test/mbt/integration/stocking-customer-browser.test.js', 'test/mbt/integration/special-stock-updates-http.test.js', 'test/mbt/integration/special-stock-updates-browser.test.js'];
const updatedTests = ['test/mbt/integration/special-request-enhancements.test.js', 'test/mbt/integration/special-enhancements-http.test.js'];
const regressionEnv = { ...process.env, DATABASE_URL: 'postgres://mbt_test:special_review_only@mbbs-special-review-db:5432/mbt_verify' };
const existing = [
  'unit/special-stock-request-domain.red.test.js', 'unit/special-stock-request-policy.red.test.js',
  'unit/special-stock-request-service.red.test.js', 'unit/special-workflow-review.test.js', 'unit/special-workflow-polish.test.js',
  'unit/special-stock-transfer.test.js', 'unit/special-planning-arrival.test.js', 'unit/special-operation-progress.test.js', 'unit/special-workflow-documents.test.js',
  'unit/regular-stock-purchase-domain.test.js', 'property/regular-stock-purchase.property.test.js',
  'integration/special-stock-request-workflow.red.test.js', 'integration/special-workflow-review.test.js',
  'integration/special-workflow-enquiry.test.js', 'integration/special-workflow-polish.test.js',
  'integration/special-workflow-polish-http.test.js', 'integration/special-stock-transfer.test.js',
  'integration/special-stock-alert-counts.test.js', 'integration/special-stock-alert-http.test.js',
  'integration/special-stock-alert-browser.test.js', 'integration/special-sales-alert-browser.test.js',
  'integration/special-request-enhancements.test.js', 'integration/special-enhancements-http.test.js',
  'integration/special-batch-save.test.js', 'integration/special-batch-browser.test.js',
  'integration/special-case-edits-http.test.js', 'integration/special-case-edits-browser.test.js',
  'integration/special-header-note-http.test.js', 'integration/special-header-note-browser.test.js',
  'integration/regular-stock-purchase.test.js', 'integration/regular-stock-stocking.test.js'
].map(file => 'test/mbt/' + file);
for (const file of existing) assert.ok(existsSync(file), file);
const failures = log => [...log.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]);
const counts = log => Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key => [key, Number(log.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] || 0)]));
function run(label, command, args, { cwd = process.cwd(), allowFailure = false, env = process.env } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 300000, maxBuffer: 50000000, env });
  const log = (result.stdout || '') + (result.stderr || ''); writeFileSync(out + '/' + label + '.log', log);
  console.log(JSON.stringify({ label, exitCode: result.status, ...counts(log) }));
  assert.ok(result.status === 0 || allowFailure && [1, 2].includes(result.status), label + ': ' + log.slice(-6000));
  return { log, status: result.status };
}
function tree() {
  const root = mkdtempSync('/tmp/special-stock-updates-check-');
  for (const folder of ['src', 'public', 'migrations', 'test', 'tools']) cpSync(folder, root + '/' + folder, { recursive: true });
  for (const file of ['package.json', 'netsuite-smart-scm-picking-ticket-restlet.js']) cpSync(file, root + '/' + file);
  symlinkSync(resolve('node_modules'), root + '/node_modules', 'dir'); return root;
}
const baseline = tree();
try {
  for (const file of [...files, ...updatedTests]) if (existsSync(out + '/before/' + file)) cpSync(out + '/before/' + file, baseline + '/' + file);
  if (process.argv.includes('--baseline')) {
    run('baseline-tests', process.execPath, ['--test', '--test-concurrency=1', ...existing], { cwd: baseline, allowFailure: true, env: regressionEnv });
    const red = run('red-unit-tests', process.execPath, ['--test', own[0]], { cwd: baseline, allowFailure: true });
    assert.equal(counts(red.log).fail, 7);
    process.exitCode = 0;
  } else {
    for (const file of js) run('syntax-' + file.replaceAll('/', '-'), process.execPath, ['--check', file]);
    const typeFiles = js.filter(file => file !== 'src/server.js' && file !== 'public/app-sidebar.js');
    const typeArgs = ['--noEmit', '--allowJs', '--checkJs', '--skipLibCheck', '--types', 'node', '--target', 'ES2022', '--module', 'NodeNext', ...typeFiles];
    // Compare diagnostic multisets by source and message; moved lines keep their original identity.
    const diagnostics = result => result.log.split('\n').filter(line => /error TS\d+/.test(line))
      .map(line => line.replace(/\(\d+,\d+\): /, ': ')).sort();
    const oldTypes = diagnostics(run('types-before', resolve('node_modules/.bin/tsc'), typeArgs, { cwd: baseline, allowFailure: true }));
    const newTypes = diagnostics(run('types-after', resolve('node_modules/.bin/tsc'), typeArgs, { allowFailure: true }), true);
    const remaining = [...oldTypes], added = newTypes.filter(line => { const i = remaining.indexOf(line); if (i < 0) return true; remaining.splice(i, 1); return false; });
    writeFileSync(out + '/new-types.json', JSON.stringify(added, null, 2)); assert.deepEqual(added, [], 'No new type errors');
    const lint = new ESLint({ overrideConfigFile: resolve('tools/stock-request-layout-eslint.config.mjs') });
    const messages = async (source, file) => (await lint.lintText(source, { filePath: file }))[0].messages.map(({ ruleId, severity, message }) => JSON.stringify({ ruleId, severity, message }));
    for (const file of js) {
      const before = existsSync(out + '/before/' + file) ? await messages(readFileSync(out + '/before/' + file, 'utf8'), file) : [];
      const after = await messages(readFileSync(file, 'utf8'), file);
      assert.deepEqual(after.filter(message => { const i = before.indexOf(message); if (i < 0) return true; before.splice(i, 1); return false; }), [], file + ' new lint findings');
    }
    run('lint-tests', resolve('node_modules/.bin/eslint'), ['--config', 'tools/stock-request-layout-eslint.config.mjs', '--max-warnings=0', ...own, 'tools/special-stock-updates-check.mjs', 'tools/special-stock-updates-mutations.mjs', 'tools/special-stock-updates-coverage.mjs']);
    const final = run('final-tests', resolve('node_modules/.bin/c8'), ['--all=false', '--check-coverage=false', ...js.map(file => '--include=' + file),
      '--temp-directory=' + out + '/regression-c8', '--report-dir=' + out + '/regression-coverage', '--reporter=json', process.execPath,
      '--test', '--test-concurrency=1', ...existing], { allowFailure: true, env: regressionEnv });
    const baselineFailures = failures(readFileSync(out + '/baseline-tests.log', 'utf8'));
    assert.deepEqual(failures(final.log).filter(name => !baselineFailures.includes(name)), [], 'No new affected-suite regressions');
    const focused = run('focused-tests', resolve('node_modules/.bin/c8'), ['--all=false', '--check-coverage=false', ...js.map(file => '--include=' + file),
      '--temp-directory=' + out + '/c8', '--report-dir=' + out + '/coverage', '--reporter=json', process.execPath, '--test', '--test-concurrency=1', ...own]);
    const shuffled = run('reverse-order-tests', process.execPath, ['--test', '--test-concurrency=1', ...own.toReversed()]);
    const hash = value => createHash('sha256').update(value).digest('hex');
    const report = { final: counts(final.log), focused: counts(focused.log), reverseOrder: counts(shuffled.log), baselineFailures, newTypeErrors: 0, newLintFindings: 0,
      sourceHashes: Object.fromEntries([...files, ...own, ...updatedTests].map(file => [file, hash(readFileSync(file))])),
      tools: { node: process.version, ...Object.fromEntries(['typescript', 'eslint', 'c8', 'fast-check', '@playwright/test'].map(name => [name, JSON.parse(readFileSync('node_modules/' + name + '/package.json')).version])) } };
    writeFileSync(out + '/checks.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report.final));
  }
} finally { rmSync(baseline, { recursive: true, force: true }); }
