import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ESLint } from 'eslint';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.equal(new URL(process.env.DATABASE_URL).hostname, 'mbbs-special-updates-db-20261002');
const out = resolve('test-artifacts/special-workflow-review/sales-request-corrections-20261003'); mkdirSync(out, { recursive: true });
const files = JSON.parse(readFileSync('tools/special-sales-request-corrections-files.json'));
const js = files.filter(file => file.endsWith('.js'));
const own = ['test/mbt/unit/special-sales-request-corrections.test.js', 'test/mbt/integration/special-sales-request-corrections-http.test.js', 'test/mbt/integration/special-sales-request-corrections-browser.test.js'];
const updatedTests = [];
const regressionEnv = { ...process.env, DATABASE_URL: 'postgres://mbt_test:special_review_only@mbbs-special-review-db:5432/mbt_verify', NETSUITE_DIRECT_ACCESS_ENABLED: 'false', SPECIAL_CASE_EDITS_BROWSER_OUTPUT: out + '/regression-browser/case-edits', SPECIAL_DELIVERY_FEE_BROWSER_OUTPUT: out + '/regression-browser/delivery-fee' };
const existing = ["unit/special-case-edits.test.js", "unit/special-delivery-fee.test.js", "unit/special-workflow-documents.test.js", "unit/special-sales-internal-remark.test.js", "integration/special-case-edits-http.test.js", "integration/special-case-edits-browser.test.js", "integration/special-delivery-fee-http.test.js", "integration/special-delivery-fee-browser.test.js"].map(file => 'test/mbt/' + file);
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
  for (const file of [...files, ...updatedTests]) if (existsSync(out + '/before/' + file)) cpSync(out + '/before/' + file, baseline + '/' + file); else rmSync(baseline + '/' + file, { force: true });
  mkdirSync(baseline + '/test-artifacts/special-workflow-review', { recursive: true });
  symlinkSync(out, baseline + '/test-artifacts/special-workflow-review/sales-request-corrections-20261003', 'dir');
  if (process.argv.includes('--baseline')) {
    run('baseline-tests', process.execPath, ['--test', '--test-concurrency=1', ...existing], { cwd: baseline, allowFailure: true, env: regressionEnv });
  } else if (process.argv.includes('--red')) {
    const red = run('red-tests', process.execPath, ['--test', '--test-concurrency=1', ...own], { cwd: baseline, allowFailure: true });
    assert.ok(counts(red.log).fail >= 3, 'Feature acceptance must fail against previous source');
  } else {
    for (const file of js) run('syntax-' + file.replaceAll('/', '-'), process.execPath, ['--check', file]);
    const typeFiles = js.filter(file => file !== 'src/server.js' && file !== 'public/app-sidebar.js');
    const typeOptions = ['--noEmit', '--allowJs', '--checkJs', '--skipLibCheck', '--types', 'node', '--target', 'ES2022', '--module', 'NodeNext'];
    const typeArgs = [...typeOptions, ...typeFiles];
    // Compare diagnostic multisets by source and message; moved lines keep their original identity.
    const diagnostics = result => result.log.split('\n').filter(line => /error TS\d+/.test(line))
      .map(line => line.replace(/\(\d+,\d+\): /, ': ').replace(/\.\.\. \d+ more \.\.\./g, '... more ...')).sort();
    const oldTypes = diagnostics(run('types-before', resolve('node_modules/.bin/tsc'), [...typeOptions, ...typeFiles.filter(file => existsSync(baseline + '/' + file))], { cwd: baseline, allowFailure: true }));
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
    run('lint-tests', resolve('node_modules/.bin/eslint'), ['--config', 'tools/stock-request-layout-eslint.config.mjs', '--max-warnings=0', ...own, 'tools/special-sales-request-corrections-check.mjs', 'tools/special-sales-request-corrections-mutations.mjs', 'tools/special-sales-request-corrections-coverage.mjs']);
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
