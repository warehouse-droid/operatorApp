import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mutations } from '../test/support/operator-suiteql-mutation-loader.mjs';

const root = process.cwd();
const artifact = path.join(root, 'test-artifacts/operator-suiteql');
const out = path.join(artifact, 'checks');
const baseline = path.join(artifact, 'baseline');
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out);
if (!fs.existsSync(path.join(baseline, 'node_modules'))) { fs.symlinkSync(path.join(root, 'node_modules'), path.join(baseline, 'node_modules')); }
const target = 'test/mbt/integration/operator-suiteql-priority.test.js';
const files = [target, 'test/mbt/unit/operator-direct-orderline-pool.test.js',
  'test/mbt/integration/operator-posting-http-timing.test.js',
  'test/mbt/integration/operator-direct-orderline-http.test.js',
  'test/mbt/integration/pickup-existing-if-http.test.js',
  'test/mbt/unit/operator-netsuite-posting-admission.red.test.js',
  'test/mbt/unit/operator-netsuite-posting-service.red.test.js'];

function run(name, args, options = {}) {
  const result = spawnSync(process.execPath, args, { cwd: root, env: process.env,
    encoding: 'utf8', maxBuffer: 32e6, ...options });
  const output = (result.stdout || '') + (result.stderr || '');
  fs.writeFileSync(path.join(out, `${name}.log`), output);
  assert.equal(result.signal, null, name);
  if (!options.acceptFailure) { assert.equal(result.status, 0, `${name}: see saved log`); }
  return { ...result, output };
}

function added(before, after) {
  const remaining = [...before];
  return after.filter(value => {
    const index = remaining.indexOf(value);
    if (index < 0) { return true; }
    remaining.splice(index, 1); return false;
  });
}

const source = fs.readFileSync('src/netsuite.js', 'utf8');
const old = fs.readFileSync(path.join(baseline, 'src/netsuite.js'), 'utf8');
const prefix = 'export async function suiteql(q, params = [], options = {}) {\n  const run = () => runSuiteql(q, params, options);\n';
const branch = '  if (isOperatorNetSuiteRequest()) {return run();}\n';
assert.equal(source, old.replace(prefix, prefix + branch), 'Only the reviewed scheduling branch may change');
const changedLine = source.slice(0, source.indexOf(prefix) + prefix.length).split('\n').length;
run('syntax', ['--check', 'src/netsuite.js']);
const coverage = run('coverage', ['node_modules/c8/bin/c8.js', '--check-coverage=false', '--include=src/netsuite.js',
  '--reporter=json', '--reporter=text', `--reports-dir=${out}/coverage`,
  'node', '--test', '--test-concurrency=1', ...files]);
const cov = JSON.parse(fs.readFileSync(path.join(out, 'coverage/coverage-final.json'), 'utf8'))[path.join(root, 'src/netsuite.js')];
const statements = Object.entries(cov.statementMap).filter(([, span]) => span.start.line <= changedLine && span.end.line >= changedLine);
assert.ok(statements.some(([id]) => cov.s[id] > 0), 'Changed line must execute');
const branches = Object.entries(cov.branchMap).filter(([, span]) => span.line === changedLine);
assert.ok(branches.length, 'Routing branches must be measured');
assert.ok(branches.every(([id]) => cov.b[id].every(count => count > 0)), 'Every changed routing branch must execute');

const typeArgs = ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.mbt.json'];
const typesBefore = run('types-before', [path.join(root, typeArgs[0]), ...typeArgs.slice(1)], { cwd: baseline, acceptFailure: true });
const typesAfter = run('types-after', typeArgs, { acceptFailure: true });
const typeDiagnostics = result => result.output.split('\n').filter(line => line.includes(': error TS')).map(line => line.replace(/\(\d+,\d+\)/gu, ''));
assert.deepEqual(added(typeDiagnostics(typesBefore), typeDiagnostics(typesAfter)), [], 'New type diagnostics');
const lintArgs = [path.join(root, 'node_modules/eslint/bin/eslint.js'), '-c', path.join(root, 'tools/operator-suiteql-eslint.config.mjs'), '--format=json'];
const lintBefore = run('lint-before', [...lintArgs, 'src/netsuite.js'], { cwd: baseline, acceptFailure: true });
const lintAfter = run('lint-after', [...lintArgs, 'src/netsuite.js', target,
  'test/support/operator-suiteql-fixture.mjs', 'test/support/operator-suiteql-mutation-loader.mjs',
  'tools/operator-suiteql-checks.mjs', 'tools/operator-suiteql-eslint.config.mjs'], { acceptFailure: true });
const lintDiagnostics = result => JSON.parse(result.stdout).flatMap(row => row.messages.map(message =>
  `${path.basename(row.filePath)}:${message.ruleId}:${message.message}`));
assert.deepEqual(added(lintDiagnostics(lintBefore), lintDiagnostics(lintAfter)), [], 'New lint diagnostics');

const mutationResults = {};
for (const [suite, pattern] of Object.entries({ examples: '^(?!property:)', property: '^property:' })) {
  mutationResults[suite] = [];
  for (const name of Object.keys(mutations)) {
    const result = run(`mutant-${suite}-${name}`, ['--loader', './test/support/operator-suiteql-mutation-loader.mjs',
      '--test', `--test-name-pattern=${pattern}`, target],
    { acceptFailure: true, env: { ...process.env, OPERATOR_SUITEQL_MUTANT: name } });
    assert.equal(result.status, 1, `Mutation survived: ${suite}/${name}`);
    assert.ok(result.output.includes(`OPERATOR_SUITEQL_MUTATION:${name}`));
    assert.match(result.output, suite === 'property' ? /Counterexample:/u : /not ok/u);
    mutationResults[suite].push(name);
  }
}
const shuffled = [...files];
let seed = 240926;
for (let i = shuffled.length - 1; i > 0; i--) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const j = seed % (i + 1); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
}
// Node sorts multiple test-file arguments; separate processes preserve this order.
for (const [index, file] of shuffled.entries()) { run(`shuffled-${index}`, ['--test', file]); }
fs.writeFileSync(path.join(out, 'shuffled-order.json'), JSON.stringify(shuffled, null, 2) + '\n');

const output = fs.openSync(path.join(out, 'startup.log'), 'w');
const child = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, PORT: '3098' }, stdio: ['ignore', output, output] });
try {
  let health;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { health = await fetch('http://127.0.0.1:3098/health'); if (health.ok) { break; } } catch { /* Wait for startup. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(health?.status, 200, 'Actual server must start');
  const bootstrap = await fetch('http://127.0.0.1:3098/api/auth/bootstrap-needed');
  assert.equal(bootstrap.status, 200, 'Actual database-backed endpoint must respond');
} finally { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); fs.closeSync(output); }

assert.equal(fs.readFileSync('src/netsuite.js', 'utf8'), source, 'Runtime source changed during validation');
assert.doesNotMatch(branch, /PRIVATE KEY|AKIA[0-9A-Z]{16}|ghp_/u);
const versions = Object.fromEntries(['c8', 'eslint', 'fast-check', 'typescript'].map(name =>
  [name, JSON.parse(fs.readFileSync(`node_modules/${name}/package.json`, 'utf8')).version]));
const result = { passed: true, sourceHash: createHash('sha256').update(source).digest('hex'),
  focusedTests: Number(coverage.output.match(/# pass (\d+)/u)[1]),
  changedLineCoverage: { covered: 1, total: 1, line: changedLine, branches: branches.length },
  mutations: mutationResults, generatedCases: 16, propertySeed: 24092026, shuffleSeed: 240926,
  typeDiagnostics: typeDiagnostics(typesAfter).length, lintDiagnostics: lintDiagnostics(lintAfter).length,
  newTypeDiagnostics: 0, newLintDiagnostics: 0, startupHealth: 200, startupDatabaseProbe: 200,
  versions: { node: process.version, ...versions } };
fs.writeFileSync(path.join(artifact, 'checks.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
