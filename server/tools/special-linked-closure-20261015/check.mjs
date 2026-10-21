import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, mkdtempSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.ok(process.env.DATABASE_URL.endsWith('/mbt_test'));
const out = 'test-artifacts/special-linked-closure-20261015';
const runtime = ['src/special-stock-closure-adapter.js', 'src/special-stock-closure-service.js'];
const unit = ['test/mbt/unit/special-linked-closure.test.js', 'test/mbt/unit/special-workflow-closure.test.js',
  'test/mbt/unit/special-workflow-closure-lock.test.js', 'test/mbt/unit/special-local-closure.test.js'];
const tests = [...unit, 'test/mbt/integration/special-workflow-closure.test.js',
  'test/mbt/integration/special-operation-closure.test.js', 'test/mbt/integration/special-local-closure.test.js'];
const own = ['test/mbt/unit/special-linked-closure.test.js', 'test/support/special-linked-closure-fixture.js'];
const tooling = ['tools/special-linked-closure-20261015/check.mjs', 'tools/special-linked-closure-20261015/run.py',
  'tools/special-linked-closure-20261015/deploy.py', 'tools/special-linked-closure-20261015/smoke.mjs'];
mkdirSync(out, { recursive: true });
rmSync(`${out}/coverage`, { recursive: true, force: true });
rmSync(`${out}/c8`, { recursive: true, force: true });
rmSync(`${out}/summary.json`, { force: true });
function run(name, command, args, { failure = false, cwd = process.cwd() } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 240000, maxBuffer: 20 * 1024 * 1024 });
  const log = (result.stdout || '') + (result.stderr || '');
  writeFileSync(`${out}/${name}.log`, log);
  if (failure) assert.ok(result.status !== 0 && /^not ok /m.test(log), `${name} survived`);
  else assert.equal(result.status, 0, `${name} failed: ${log.slice(-5000)}`);
  console.log(JSON.stringify({ check: name, passed: true }));
  return log;
}
const suite = run('suite', 'node_modules/.bin/c8', ['--all=false', '--check-coverage=false',
  ...runtime.map(file => `--include=${file}`), `--temp-directory=${out}/c8`, `--report-dir=${out}/coverage`,
  '--reporter=json', '--reporter=json-summary', process.execPath, '--test', '--test-concurrency=1', ...tests]);
run('types', 'node_modules/.bin/tsc', ['--noEmit', '--allowJs', '--checkJs', '--skipLibCheck', '--types', 'node',
  '--target', 'ES2022', '--module', 'NodeNext', 'src/special-stock-closure-adapter.js']);
run('lint', 'node_modules/.bin/eslint', ['--config', 'tools/special-workflow-native-eslint.config.mjs', '--max-warnings=0',
  ...runtime, ...tests, ...own.slice(1), tooling[0], tooling[3]]);
for (const file of runtime) run('syntax-' + file.split('/').pop(), process.execPath, ['--check', file]);
const mutations = [
  ['request-line-match', 'const lines = await read(order, boundary);',
    "const lines = await read(order, boundary); if (!order.lines || order.lines.length !== lines.length) throw conflict('Request lines differ');"],
  ['omit-current-line', 'kind: order.kind, lines });', 'kind: order.kind, lines: lines.slice(1) });'],
  ['wrong-close-order', "(a.kind === 'purchase_order' ? 0 : 1) - (b.kind === 'purchase_order' ? 0 : 1)",
    "(a.kind === 'sales_order' ? 0 : 1) - (b.kind === 'sales_order' ? 0 : 1)"]
];
const temp = mkdtempSync('/tmp/linked-closure-mutants-');
try {
  for (const folder of ['src', 'public']) cpSync(folder, `${temp}/${folder}`, { recursive: true });
  cpSync('package.json', `${temp}/package.json`);
  symlinkSync(resolve('node_modules'), `${temp}/node_modules`, 'dir');
  for (const file of own) { mkdirSync(resolve(temp, file, '..'), { recursive: true }); cpSync(file, `${temp}/${file}`); }
  for (const [name, before, after] of mutations) {
    const file = `${temp}/${runtime[0]}`, source = readFileSync(file, 'utf8');
    assert.equal(source.split(before).length, 2);
    try {
      writeFileSync(file, source.replace(before, after));
      run(`mutant-${name}`, process.execPath, ['--test', own[0]], { failure: true, cwd: temp });
      run(`property-mutant-${name}`, process.execPath, ['--test', '--test-name-pattern=^property:', own[0]], { failure: true, cwd: temp });
    } finally { writeFileSync(file, source); }
    assert.equal(readFileSync(runtime[0], 'utf8'), source);
  }
} finally { rmSync(temp, { recursive: true, force: true }); }
const shuffled = [...tests].sort((a, b) => createHash('sha256').update(`20261015:${a}`).digest('hex')
  .localeCompare(createHash('sha256').update(`20261015:${b}`).digest('hex')));
writeFileSync(`${out}/suite-health-order.json`, JSON.stringify(shuffled, null, 2));
for (const [index, file] of shuffled.entries()) run(`suite-health-${index + 1}`, process.execPath, ['--test', file]);
run('runtime-health', process.execPath, ['tools/special-linked-closure-20261015/smoke.mjs']);
run('secrets', process.execPath, ['test/support/scan-diff-secrets.mjs', ...runtime, ...tests, ...own.slice(1), ...tooling]);
const coverage = JSON.parse(readFileSync(`${out}/coverage/coverage-final.json`, 'utf8'));
const changed = JSON.parse(readFileSync(`${out}/changed-lines.json`, 'utf8'));
const changedCoverage = {};
for (const [file, lines] of Object.entries(changed)) {
  const entry = coverage[resolve(file)], executable = new Map();
  assert.ok(entry, `No coverage for ${file}`);
  for (const [key, span] of Object.entries(entry.statementMap)) {
    for (let line = span.start.line; line <= span.end.line; line++) executable.set(line, Math.max(executable.get(line) || 0, entry.s[key]));
  }
  const measured = lines.filter(line => executable.has(line));
  const missed = measured.filter(line => executable.get(line) === 0);
  assert.deepEqual(missed, [], `Changed lines not exercised in ${file}`);
  changedCoverage[file] = { covered: measured.length, total: measured.length, missed };
}
const files = [...new Set([...runtime, ...tests, ...own, ...tooling, 'test/special-linked-closure-spec.md'])];
const hashes = Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
writeFileSync(`${out}/source-manifest.json`, JSON.stringify(hashes, null, 2));
const summary = { passed: Number(/^# pass (\d+)$/m.exec(suite)?.[1]), tests: Number(/^# tests (\d+)$/m.exec(suite)?.[1]),
  failures: Number(/^# fail (\d+)$/m.exec(suite)?.[1]), changedCoverage, mutantsKilled: mutations.length,
  propertyMutantsKilled: mutations.length, propertySeed: 20261015, propertyRuns: 50,
  sourceHash: createHash('sha256').update(JSON.stringify(hashes)).digest('hex'),
  tools: { node: process.version, ...Object.fromEntries(['typescript', 'eslint', 'c8', 'fast-check'].map(name => [name, JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version])) } };
assert.equal(summary.tests, summary.passed);
writeFileSync(`${out}/summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
