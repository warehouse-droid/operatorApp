import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { query, closeDb } from '../src/db.js';
import { runtimeFiles, focusedFiles } from './netsuite-priority-queue-files.mjs';
import { mutations } from '../test/support/netsuite-priority-queue-mutation-loader.mjs';

const root = process.cwd(), artifact = path.join(root, 'test-artifacts/netsuite-priority-queue');
const out = path.join(artifact, 'checks'), baseline = path.join(artifact, 'baseline');
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out);
if (!fs.existsSync(path.join(baseline, 'node_modules'))) { fs.symlinkSync(path.join(root, 'node_modules'), path.join(baseline, 'node_modules')); }

function run(name, args, options = {}) {
  const result = spawnSync(process.execPath, args, { cwd: root, env: process.env,
    encoding: 'utf8', maxBuffer: 64e6, timeout: 180000, ...options });
  const output = (result.stdout || '') + (result.stderr || '');
  fs.writeFileSync(path.join(out, `${name}.log`), output);
  assert.equal(result.signal, null, `${name}: process terminated`);
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

for (const file of runtimeFiles) { run(`syntax-${path.basename(file)}`, ['--check', file]); }
const coverage = run('focused-coverage', ['node_modules/c8/bin/c8.js', '--check-coverage=false',
  ...runtimeFiles.map(file => `--include=${file}`), '--reporter=json', '--reporter=text', `--reports-dir=${out}/coverage`,
  'node', '--test', '--test-concurrency=1', ...focusedFiles]);

const typeArgs = ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.mbt.json'];
const typesBefore = run('types-before', [path.join(root, typeArgs[0]), ...typeArgs.slice(1)], { cwd: baseline, acceptFailure: true });
const typesAfter = run('types-after', typeArgs, { acceptFailure: true });
const typeDiagnostics = result => result.output.split('\n').filter(line => line.includes(': error TS')).map(line => line.replace(/\(\d+,\d+\)/gu, ''));
assert.deepEqual(added(typeDiagnostics(typesBefore), typeDiagnostics(typesAfter)), [], 'New type diagnostics');
const lintArgs = [path.join(root, 'node_modules/eslint/bin/eslint.js'), '-c', path.join(root, 'tools/netsuite-priority-queue-eslint.config.mjs'), '--format=json'];
const changedExistingTest = 'test/mbt/unit/smart-scm-created-po-service.test.js';
const lintBefore = run('lint-before', [...lintArgs, ...runtimeFiles.filter(file => fs.existsSync(path.join(baseline, file))), changedExistingTest], { cwd: baseline, acceptFailure: true });
const tooling = fs.readdirSync('tools').filter(file => file.startsWith('netsuite-priority-queue-') && file.endsWith('.mjs')).map(file => `tools/${file}`);
const support = fs.readdirSync('test/support').filter(file => file.startsWith('netsuite-priority-queue-') && file.endsWith('.mjs')).map(file => `test/support/${file}`);
const lintAfter = run('lint-after', [...lintArgs, ...runtimeFiles, changedExistingTest, ...focusedFiles.filter(file => file.includes('netsuite-priority-queue')), ...tooling, ...support], { acceptFailure: true });
const lintDiagnostics = result => JSON.parse(result.stdout).flatMap(row => row.messages.map(message =>
  `${path.basename(row.filePath)}:${message.ruleId}:${message.message.replace(/on line \d+ column \d+/gu, 'on existing declaration')}`));
const newLint = added(lintDiagnostics(lintBefore), lintDiagnostics(lintAfter));
fs.writeFileSync(path.join(out, 'new-lint.json'), JSON.stringify(newLint, null, 2));
assert.deepEqual(newLint, [], 'New lint diagnostics');

const mutationResults = {};
for (const [suite, pattern] of Object.entries({ examples: '^(?!property:)', property: '^property:' })) {
  mutationResults[suite] = [];
  for (const name of Object.keys(mutations)) {
    await query('TRUNCATE netsuite_request_queue');
    const result = run(`mutant-${suite}-${name}`, ['--loader', './test/support/netsuite-priority-queue-mutation-loader.mjs',
      '--test', `--test-name-pattern=${pattern}`, 'test/mbt/integration/netsuite-priority-queue.test.js'],
    { acceptFailure: true, env: { ...process.env, NETSUITE_PRIORITY_MUTANT: name } });
    assert.equal(result.status, 1, `Mutation survived: ${suite}/${name}`);
    assert.ok(result.output.includes(`NETSUITE_PRIORITY_MUTATION:${name}`));
    assert.match(result.output, suite === 'property' ? /Counterexample:/u : /not ok/u);
    mutationResults[suite].push(name);
  }
}
await query('TRUNCATE netsuite_request_queue');
const poMutation = run('mutant-po-version-recheck', ['--import', './test/support/netsuite-priority-queue-po-mutant.mjs',
  '--test', 'test/mbt/unit/smart-scm-created-po-service.test.js'], { acceptFailure: true });
assert.equal(poMutation.status, 1, 'The PO stale-write guard mutant must be rejected');
assert.match(poMutation.output, /NETSUITE_PRIORITY_MUTATION:po_version_recheck/u);
assert.match(poMutation.output, /Missing expected rejection/u);
const shuffled = [...focusedFiles]; let seed = 250926;
for (let i = shuffled.length - 1; i > 0; i--) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const j = seed % (i + 1); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
}
for (const [index, file] of shuffled.entries()) { run(`shuffled-${index}`, ['--test', file]); }
fs.writeFileSync(path.join(out, 'shuffled-order.json'), JSON.stringify(shuffled, null, 2) + '\n');

const output = fs.openSync(path.join(out, 'startup.log'), 'w');
const child = spawn(process.execPath, ['src/server.js'],
  { env: { ...process.env, PORT: '3098' }, stdio: ['ignore', output, output] });
try {
  let health;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { health = await fetch('http://127.0.0.1:3098/health'); if (health.ok) { break; } } catch { /* Startup retry. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(health?.status, 200);
  assert.equal((await fetch('http://127.0.0.1:3098/api/auth/bootstrap-needed')).status, 200);
} finally {
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve)); fs.closeSync(output);
}

const versions = Object.fromEntries(['c8', 'eslint', 'fast-check', 'typescript'].map(name =>
  [name, JSON.parse(fs.readFileSync(`node_modules/${name}/package.json`, 'utf8')).version]));
const result = { passed: true,
  sourceHashes: Object.fromEntries(runtimeFiles.map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')])),
  focusedTests: Number(coverage.output.match(/# pass (\d+)/u)[1]), mutations: mutationResults,
  poVersionRecheckMutationKilled: true,
  propertyCases: 24, propertySeed: 240925, shuffleSeed: 250926,
  typeDiagnostics: typeDiagnostics(typesAfter).length, lintDiagnostics: lintDiagnostics(lintAfter).length,
  newTypeDiagnostics: 0, newLintDiagnostics: 0, startupHealth: 200, startupDatabaseProbe: 200,
  versions: { node: process.version, ...versions } };
fs.writeFileSync(path.join(artifact, 'checks.json'), JSON.stringify(result, null, 2) + '\n');
await closeDb(); console.log(JSON.stringify(result));
