import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';
import v8ToIstanbul from 'v8-to-istanbul';
import coverageLibrary from 'istanbul-lib-coverage';
import { scanTextForSecrets } from '../test/support/scan-diff-secrets.mjs';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
const output = path.resolve('test-artifacts/popup-checks');
mkdirSync(output, { recursive: true });
const files = ['public/operator.js', 'public/operator.html', 'public/service-worker.js', 'public/operator-popup-audit.js',
  'src/server.js', 'src/operator-popup-audit.js', 'src/auth-repository.js'];
const ownTests = ['test/mbt/e2e/operator-delivery-popup.test.js', 'test/mbt/integration/operator-popup-audit.test.js',
  'test/mbt/unit/operator-popup-audit.test.js'];
const tests = [...ownTests, 'test/mbt/e2e/operator-delivery-refresh.test.js', 'test/mbt/unit/operator-yard-assets.test.js',
  'test/mbt/unit/operator-performance-regressions.test.js', 'test/mbt/integration/operator-yard-access.test.js'];
const hash = file => crypto.createHash('sha256').update(readFileSync(file)).digest('hex');
const report = { sourceHashes: Object.fromEntries(files.map(file => [file, hash(file)])), tests: {}, mutations: [], static: {} };
const checkFiles = [...tests, 'tools/operator-popup-checks.mjs', 'tools/operator-popup-eslint.config.mjs', 'test/operator-popup-baseline.json'];
report.testHashes = Object.fromEntries(checkFiles.map(file => [file, hash(file)]));
report.tools = { node: process.version, packages: Object.fromEntries(['eslint', 'typescript', 'c8', '@playwright/test', 'fast-check', 'v8-to-istanbul'].map(name =>
  [name, JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')).version])) };
function run(label, command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 30 * 1024 * 1024, ...options });
  const log = (result.stdout || '') + (result.stderr || '');
  writeFileSync(path.join(output, `${label}.log`), log);
  if (!options.allowFailure && result.status !== 0) {
    const failures = [...log.matchAll(/^not ok[^\n]*\n[\s\S]*?^  \.\.\.$/gm)].map(match => match[0]);
    console.error(failures.length ? failures.join('\n').slice(0, 15000) : log.slice(-15000));
    throw new Error(`${label} failed: ${result.status}`);
  }
  return { status: result.status, log };
}
for (const file of files.filter(name => name.endsWith('.js'))) { run('syntax-' + path.basename(file), process.execPath, ['--check', file]); }
run('lint', 'node_modules/.bin/eslint', ['--config', 'tools/operator-popup-eslint.config.mjs', '--max-warnings=0',
  'src/operator-popup-audit.js', 'public/operator-popup-audit.js', ...ownTests, 'tools/operator-popup-checks.mjs']);
report.static.syntax = 'passed'; report.static.lint = 'passed';
for (const file of ['src/operator-popup-audit.js', 'public/operator-popup-audit.js', ...ownTests]) {
  assert.deepEqual(scanTextForSecrets(readFileSync(file, 'utf8'), file), [], file);
}
report.static.secrets = 'passed';
const typeResult = run('types', 'node_modules/.bin/tsc', ['--allowJs', '--checkJs', '--noEmit', '--skipLibCheck',
  '--target', 'es2022', '--module', 'nodenext', 'src/operator-popup-audit.js'], { allowFailure: true });
const changedTypeErrors = typeResult.log.split('\n').filter(line => line.startsWith('src/operator-popup-audit.js('));
assert.deepEqual(changedTypeErrors, []);
report.static.types = { changedModuleErrors: changedTypeErrors.length, unrelatedDiagnostics: typeResult.log.split('\n').filter(line => /error TS\d+/.test(line)).length };

// Deterministic shuffled file order; browser execution and real HTTP share the isolated DB.
const ordered = tests.map(file => ({ file, key: crypto.createHash('sha256').update('1263:' + file).digest('hex') }))
  .sort((a, b) => a.key.localeCompare(b.key)).map(row => row.file);
const checked = run('tests', 'node_modules/.bin/c8', ['--include=src/operator-popup-audit.js', '--include=public/operator-popup-audit.js', '--reporter=json', '--reporter=json-summary',
  '--reporter=text', `--reports-dir=${output}/coverage`, `--temp-directory=${output}/v8`,
  process.execPath, '--test', '--test-concurrency=1', ...ordered], { allowFailure: true, env: { ...process.env, OPERATOR_POPUP_COVERAGE: '1' } });
const baseline = JSON.parse(readFileSync('test/operator-popup-baseline.json', 'utf8'));
for (const [file, digest] of Object.entries(baseline.sourceHashes)) { assert.equal(hash('/baseline-source/' + file), digest); }
const failures = [...checked.log.matchAll(/^not ok[^\n]*\n[\s\S]*?^  \.\.\.$/gm)].map(match => match[0]);
assert.ok(checked.status === 0 || checked.status === 1);
assert.equal(failures.length, checked.status ? 1 : 0, failures.join('\n'));
if (failures.length) {
  assert.ok(failures[0].split('\n')[0].endsWith(' - ' + baseline.test), failures[0]);
  assert.ok(failures[0].includes('saved-orders?locationId=1') && failures[0].includes('500 !== 200'), failures[0]);
}
report.tests.preExistingFailures = failures.map(failure => failure.split('\n')[0].replace(/^not ok \d+ - /, ''));
report.tests.newFailures = 0;
report.tests.summary = checked.log.split('\n').filter(line => /^# (tests|pass|fail|skipped|duration_ms) /.test(line));
report.tests.order = ordered;
report.coverage = JSON.parse(readFileSync(path.join(output, 'coverage/coverage-summary.json'), 'utf8'));
const coverage = coverageLibrary.createCoverageMap(JSON.parse(readFileSync(path.join(output, 'coverage/coverage-final.json'), 'utf8')));
for (const name of readdirSync('test-artifacts/popup-browser')) {
  for (const sample of JSON.parse(readFileSync(`test-artifacts/popup-browser/${name}`, 'utf8'))) {
    const file = 'public' + new URL(sample.url).pathname;
    assert.equal(sample.source, readFileSync(file, 'utf8'));
    const converter = v8ToIstanbul(path.resolve(file), 0, { source: sample.source });
    await converter.load(); converter.applyCoverage(sample.functions);
    coverage.merge(converter.toIstanbul());
  }
}
report.browserCoverage = {};
for (const file of ['public/operator.js', 'public/operator-popup-audit.js']) {
  const covered = coverage.fileCoverageFor(path.resolve(file)), lines = covered.getLineCoverage();
  let changed = Object.keys(lines).map(Number);
  if (file === 'public/operator.js') {
    const diff = spawnSync('diff', ['-U0', '/baseline-source/' + file, file], { encoding: 'utf8' });
    assert.equal(diff.status, 1, diff.stderr);
    changed = [...diff.stdout.matchAll(/^@@ .* \+(\d+)(?:,(\d+))? @@/gm)]
      .flatMap(match => Array.from({ length: Number(match[2] ?? 1) }, (_, index) => Number(match[1]) + index))
      .filter(line => Object.hasOwn(lines, line));
  }
  const missing = changed.filter(line => lines[line] === 0);
  report.browserCoverage[file] = { changedLines: changed.length, executedLines: changed.length - missing.length, missing,
    branches: covered.toSummary().branches };
  assert.deepEqual(missing, [], `Unexecuted changed lines in ${file}`);
}

const runtime = path.join(output, 'mutant');
try {
  mkdirSync(runtime);
  for (const name of ['src', 'public', 'test', 'contracts']) { cpSync(name, path.join(runtime, name), { recursive: true }); }
  cpSync('package.json', path.join(runtime, 'package.json'));
  symlinkSync(path.resolve('node_modules'), path.join(runtime, 'node_modules'));
  const mutants = [
    ['blank-spot', 'public/operator.js', 'if (!base || base.endsWith(":") || !key) return false;', 'if (!base || base.endsWith(":") || !key || key.endsWith(":")) return false;', ownTests[0], 'P1 blank'],
    ['late-event', 'public/operator.js', '      "dispatch.plan.followups.completed",\n', '', ownTests[0], 'P2 delayed'],
    ['display-audit', 'public/operator.js', 'function recordVisibleDeliveryPopup() {', 'function recordVisibleDeliveryPopup() { return;', ownTests[0], 'P1 blank'],
    ['duplicate-audit', 'src/operator-popup-audit.js', 'if (previous.rowCount) {', 'if (false) {', ownTests[1], 'A2 concurrent']
  ];
  for (const [name, file, from, to, suite, pattern] of mutants) {
    const target = path.join(runtime, file), original = readFileSync(target, 'utf8');
    assert.equal(original.split(from).length, 2, name);
    try {
      writeFileSync(target, original.replace(from, to));
      const result = run(name, process.execPath, ['--test', '--test-concurrency=1', `--test-name-pattern=${pattern}`, suite], { cwd: runtime, allowFailure: true });
      assert.notEqual(result.status, 0, `${name} survived`);
      assert.match(result.log, /not ok/);
      report.mutations.push({ name, killed: true });
    } finally { writeFileSync(target, original); }
  }
} finally { rmSync(runtime, { recursive: true, force: true }); }
assert.deepEqual(Object.fromEntries(files.map(file => [file, hash(file)])), report.sourceHashes);
assert.deepEqual(Object.fromEntries(checkFiles.map(file => [file, hash(file)])), report.testHashes);
report.passed = true;
console.log('POPUP_EVIDENCE=' + JSON.stringify(report));
