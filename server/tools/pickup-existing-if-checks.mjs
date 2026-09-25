import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pickupMutants } from '../test/support/pickup-existing-if-mutants.mjs';

const root = process.cwd(), out = path.join(root, 'test-artifacts/pickup-existing-if/final');
const baseline = path.join(root, 'test-artifacts/pickup-existing-if/baseline');
const changes = JSON.parse(fs.readFileSync(path.join(out, 'source.json'), 'utf8'));
const files = ['test/mbt/unit/pickup-existing-if.test.js', 'test/mbt/property/pickup-existing-if.property.test.js',
  'test/mbt/adversarial/pickup-existing-if.test.js', 'test/mbt/integration/pickup-existing-if.test.js',
  'test/mbt/integration/pickup-existing-if-http.test.js'];
const neighbors = ['domain', 'targets', 'service', 'admission', 'runtime'].map(name => `test/mbt/unit/operator-netsuite-posting-${name}.red.test.js`);

function run(name, args, options = {}) {
  const result = spawnSync(process.execPath, args, { cwd: root, env: process.env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
  const output = (result.stdout || '') + (result.stderr || '');
  fs.writeFileSync(path.join(out, `${name}.log`), output);
  assert.equal(result.signal, null, name);
  if (!options.acceptFailure) { assert.equal(result.status, 0, `${name}: see ${out}/${name}.log`); }
  return { ...result, output };
}
function diagnostics(text) {
  return text.split('\n').filter(line => line.includes(': error TS')).map(line => line.replace(/\(\d+,\d+\)/gu, '')).sort();
}
function added(before, after) {
  const counts = new Map();
  for (const value of before) { counts.set(value, (counts.get(value) || 0) + 1); }
  return after.filter(value => {
    const count = counts.get(value) || 0;
    if (count) { counts.set(value, count - 1); return false; }
    return true;
  });
}
function lintDiagnostics(text) {
  return JSON.parse(text).flatMap(row => row.messages.map(message => `${path.basename(row.filePath)}:${message.ruleId}:${message.message}`)).sort();
}

const coverage = run('coverage', ['/app/node_modules/c8/bin/c8.js', '--check-coverage=false',
  ...Object.keys(changes.runtime).map(file => `--include=${file}`), '--reporter=json', '--reporter=text',
  `--reports-dir=${out}/coverage`, 'node', '--test', '--test-concurrency=1', ...files, ...neighbors]);
const cov = JSON.parse(fs.readFileSync(path.join(out, 'coverage/coverage-final.json'), 'utf8'));
let covered = 0, total = 0;
const missing = [];
for (const [file, changedLines] of Object.entries(changes.changedLines)) {
  const data = cov[path.join(root, file)]; assert.ok(data, file);
  const lines = new Map();
  for (const [key, span] of Object.entries(data.statementMap)) {
    for (let line = span.start.line; line <= span.end.line; line++) { lines.set(line, Math.max(lines.get(line) || 0, data.s[key])); }
  }
  for (const line of changedLines) {
    if (!lines.has(line)) { continue; }
    total++;
    if (lines.get(line)) { covered++; } else { missing.push(`${file}:${line}`); }
  }
}
assert.deepEqual(missing, [], 'Uncovered changed lines');
const typesBefore = run('types-baseline', ['/app/node_modules/typescript/bin/tsc', '-p', 'tsconfig.mbt.json'], { cwd: baseline, acceptFailure: true });
const typesAfter = run('types-current', ['/app/node_modules/typescript/bin/tsc', '-p', 'tsconfig.mbt.json'], { acceptFailure: true });
const newTypes = added(diagnostics(typesBefore.output), diagnostics(typesAfter.output));
assert.deepEqual(newTypes, [], 'New type diagnostics');
const existingFiles = Object.keys(changes.runtime).filter(file => fs.existsSync(path.join(baseline, file)));
const lintBefore = run('lint-baseline', ['/app/node_modules/eslint/bin/eslint.js', '-c', 'eslint.mbt.config.js', '--format=json', ...existingFiles], { cwd: baseline, acceptFailure: true });
const lintAfter = run('lint-current', ['/app/node_modules/eslint/bin/eslint.js', '-c', 'tools/pickup-existing-if-eslint.config.mjs', '--format=json',
  ...Object.keys(changes.runtime), ...files, 'test/support/pickup-existing-if-fixture.mjs',
  'test/support/pickup-existing-if-mutants.mjs', 'test/support/pickup-existing-if-mutation-loader.mjs', 'tools/pickup-existing-if-checks.mjs'], { acceptFailure: true });
const newLint = added(lintDiagnostics(lintBefore.stdout), lintDiagnostics(lintAfter.stdout));
assert.deepEqual(newLint, [], 'New lint diagnostics');
const mutation = {};
for (const [suite, file] of Object.entries({ unit: files[0], property: files[1] })) {
  mutation[suite] = [];
  for (const name of Object.keys(pickupMutants)) {
    const result = run(`mutation-${suite}-${name}`, ['--loader', './test/support/pickup-existing-if-mutation-loader.mjs', '--test', file],
      { acceptFailure: true, env: { ...process.env, PICKUP_IF_MUTANT: name } });
    assert.equal(result.status, 1, `Surviving mutation ${suite}:${name}`);
    assert.ok(result.output.includes(`PICKUP_MUTATION_APPLIED:${name}`));
    assert.match(result.output, suite === 'property' ? /Counterexample:/u : /ERR_ASSERTION/u);
    mutation[suite].push(name);
  }
}
// Fixed seed Fisher-Yates shuffle; repeat order-dependent integration setup too.
let seed = 220922;
const shuffled = [...files];
for (let i = shuffled.length - 1; i > 0; i--) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const j = seed % (i + 1); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
}
const shuffle = run('shuffled', ['--test', '--test-concurrency=1', ...shuffled]);
const versions = Object.fromEntries(['c8', 'eslint', 'fast-check', 'typescript'].map(name =>
  [name, JSON.parse(fs.readFileSync(`/app/node_modules/${name}/package.json`, 'utf8')).version]));
const result = { changedLineCoverage: { covered, total, missing }, newTypeErrors: newTypes.length, newLint: newLint.length,
  baselineTypeErrors: diagnostics(typesBefore.output).length, baselineLint: lintDiagnostics(lintBefore.stdout).length,
  mutations: mutation, shuffleSeed: 220922, versions: { node: process.version, ...versions },
  focusedAndNeighbors: Number(coverage.output.match(/# pass (\d+)/u)[1]), focused: Number(shuffle.output.match(/# pass (\d+)/u)[1]),
  sourceHash: changes.sourceHash };
fs.writeFileSync(path.join(out, 'checks.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
