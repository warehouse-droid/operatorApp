import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, cpSync, mkdtempSync, symlinkSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
assert.equal(process.env.MBT_TEST_ISOLATED, '1'); assert.ok(process.env.DATABASE_URL?.endsWith('/mbt_verify'));
const out = 'test-artifacts/special-operation-progress';
const runtime = JSON.parse(readFileSync(`${out}/runtime-files.json`));
const tests = ['test/mbt/integration/special-operation-closure.test.js', 'test/mbt/integration/special-workflow-closure.test.js', 'test/mbt/integration/special-workflow-pricing-http.test.js',
  ...['special-operation-progress', 'special-workflow-closure', 'special-workflow-closure-lock', 'special-workflow-quantity-transition', 'special-workflow-queue', 'special-stock-request-service.red'].map(name => `test/mbt/unit/${name}.test.js`)];
const scripts = readdirSync('tools').filter(name => name.startsWith('special-operation-') && /\.(mjs|py)$/.test(name)).map(name => `tools/${name}`);
function run(name, command, args, failure = false, cwd = process.cwd()) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 180000, maxBuffer: 20 * 1024 * 1024 });
  const log = (result.stdout || '') + (result.stderr || ''); writeFileSync(`${out}/${name}.txt`, log);
  if (failure) assert.ok(result.status !== 0 && /^not ok /m.test(log), `${name} survived`);
  else assert.equal(result.status, 0, `${name} failed: ${log.slice(-1800)}`);
  console.log(JSON.stringify({ check: name, passed: true })); return log;
}
const suite = run('related-tests', 'node_modules/.bin/c8', ['--all=false', '--check-coverage=false', ...runtime.filter(f => f.endsWith('.js')).map(f => `--include=${f}`), `--temp-directory=${out}/c8`, `--report-dir=${out}/coverage`, '--reporter=json', process.execPath, '--test', '--test-concurrency=1', ...tests]);
run('types', 'node_modules/.bin/tsc', ['--noEmit', '--allowJs', '--checkJs', '--skipLibCheck', '--types', 'node', '--target', 'ES2022', '--module', 'NodeNext', 'public/special-stock-busy.js', 'src/special-stock-closure-adapter.js']);
for (const file of runtime.filter(f => f.endsWith('.js'))) run(`syntax-${file.split('/').pop()}`, process.execPath, ['--check', file]);
run('lint', 'node_modules/.bin/eslint', ['--config', 'tools/special-workflow-queue-eslint.config.mjs', '--max-warnings=0', ...runtime.filter(f => f.endsWith('.js') && f !== 'src/server.js'), ...tests, ...scripts.filter(f => f.endsWith('.mjs'))]);
run('server-lint', process.execPath, ['tools/special-operation-progress-server-lint.mjs']);
run('browser', process.execPath, ['tools/special-operation-progress-browser.mjs']);
run('queue-browser', process.execPath, ['tools/special-workflow-queue-browser.mjs']);
for (const file of readdirSync('test-artifacts/special-workflow-review/queue-access').filter(f => f.startsWith('browser-coverage-'))) cpSync(`test-artifacts/special-workflow-review/queue-access/${file}`, `${out}/${file.replace('browser-coverage-', 'browser-coverage-queue-')}`);
run('coverage', process.execPath, ['tools/special-operation-progress-coverage.mjs', '--require-complete']);
const report = JSON.parse(readFileSync(`${out}/changed-lines.json`));
const root = mkdtempSync('/tmp/special-operation-mutations-');
for (const directory of ['src', 'public']) cpSync(directory, `${root}/${directory}`, { recursive: true });
cpSync('package.json', `${root}/package.json`); symlinkSync(resolve('node_modules'), `${root}/node_modules`, 'dir'); mkdirSync(`${root}/test/mbt/unit`, { recursive: true });
for (const name of ['special-workflow-closure', 'special-operation-progress']) cpSync(`test/mbt/unit/${name}.test.js`, `${root}/test/mbt/unit/${name}.test.js`);
const mutants = [
  ['src/special-stock-closure-adapter.js', '![1, 2].includes(orders.length)', 'orders.length !== 2', 'special-workflow-closure'],
  ['src/special-stock-closure-adapter.js', 'const open = current.filter(line => !line.closed);', 'const open = current;', 'special-workflow-closure'],
  ['src/special-stock-closure-adapter.js', 'verifiedOrderIds: plan.orders.map(order => order.id)', 'verifiedOrderIds: []', 'special-workflow-closure'],
  ['public/special-stock-busy.js', "detail?.closureReview?.status === 'applying'", "detail?.closureReview?.status === 'attention'", 'special-operation-progress']
];
for (const [index, [file, before, after, name]] of mutants.entries()) {
  const path = `${root}/${file}`, source = readFileSync(path, 'utf8'); assert.equal(source.split(before).length, 2);
  try {
    writeFileSync(path, source.replace(before, after));
    run(`mutant-${index + 1}`, process.execPath, ['--test', '--test-name-pattern=^property:', `test/mbt/unit/${name}.test.js`], true, root);
  } finally { writeFileSync(path, source); }
  assert.equal(readFileSync(file, 'utf8'), source);
}
run('suite-health', process.execPath, ['--test', '--test-concurrency=1', ...tests.toReversed()]);
run('secrets', process.execPath, ['test/support/scan-diff-secrets.mjs', ...runtime, ...tests, ...scripts]);
const files = [...new Set([...runtime, ...tests, ...scripts, 'test/special-operation-progress-spec.md'])];
const hashes = Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
writeFileSync(`${out}/source-manifest.json`, JSON.stringify(hashes, null, 2));
const summary = { completed: true, tests: Number(/^# tests (\d+)$/m.exec(suite)?.[1]), passed: Number(/^# pass (\d+)$/m.exec(suite)?.[1]), coverage: report, propertyMutants: mutants.length,
  sourceHash: createHash('sha256').update(JSON.stringify(hashes)).digest('hex'), tools: { node: process.version, ...Object.fromEntries(['typescript', 'eslint', 'c8', 'fast-check', 'playwright'].map(name => [name, JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version])) } };
writeFileSync(`${out}/summary.json`, JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary));
