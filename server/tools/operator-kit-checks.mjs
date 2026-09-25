import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ESLint } from 'eslint';
import base from '../eslint.mbt.config.js';
import { scanTextForSecrets, scanUnifiedDiff } from '../test/support/scan-diff-secrets.mjs';
import { mutants } from '../test/support/operator-kit-mutation-loader.mjs';
import { production, tests } from './operator-kit-files.mjs';
const folder = 'test-artifacts/operator-kit/final';
mkdirSync(folder, { recursive: true });
const read = file => readFileSync(file, 'utf8');
const json = file => JSON.parse(read(file));
const hash = text => createHash('sha256').update(text).digest('hex');
const save = (name, value) => writeFileSync(`${folder}/${name}.json`, JSON.stringify(value, null, 2));
const support = readdirSync('test/support').filter(name => name.startsWith('operator-kit-')).map(name => `test/support/${name}`);
const tooling = readdirSync('tools').filter(name => name.startsWith('operator-kit-')).map(name => `tools/${name}`);
const files = [...new Set([...production, ...tests, ...support, ...tooling, 'test/operator-kit-spec.md'])];
const source = () => Object.fromEntries(files.map(file => [file, hash(read(file))]));
const run = (name, command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 100e6, ...options });
  assert.ifError(result.error);
  writeFileSync(`${folder}/${name}.log`, result.stdout + result.stderr);
  return result;
};
const diagnostics = output => output.split('\n').filter(line => /error TS\d+/u.test(line)).map(line => line.replace(/\(\d+,\d+\)/u, '')).sort();
const lintMessages = entries => entries.flatMap(file => file.messages.map(message =>
  `${file.filePath.replace('/app/', '')}:${message.ruleId}:${message.message}`)).sort();
function difference(current, previous) {
  const remaining = [...previous];
  return current.filter(item => { const at = remaining.indexOf(item); if (at < 0) { return true; } remaining.splice(at, 1); return false; });
}
async function staticChecks() {
  const js = files.filter(file => /\.(?:js|mjs)$/u.test(file));
  for (const file of js) { assert.equal(run('syntax', process.execPath, ['--check', file]).status, 0, file); }
  // The two legacy monoliths have no ESLint configuration; syntax and changed-line coverage cover them.
  const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: base });
  const changed = js.filter(file => !['src/netsuite.js', 'src/delivery-repository.js'].includes(file)
    && (!tests.includes(file) || file.includes('operator-kit')));
  const lint = lintMessages(await eslint.lintFiles(changed));
  const typeRun = run('types', 'node_modules/.bin/tsc', ['--project', 'tsconfig.mbt.json', '--pretty', 'false']);
  assert.ok([0, 1, 2].includes(typeRun.status));
  const types = diagnostics(typeRun.stdout + typeRun.stderr);
  const baseline = json('test/support/operator-kit-static-baseline.json');
  const newDiagnostics = [...difference(types, baseline.types), ...difference(lint, baseline.lint)];
  save('static', { types: types.length, lint: lint.length, newDiagnostics, node: process.version });
  assert.deepEqual(newDiagnostics, []);
}
function coverage() {
  const entries = readdirSync(`${folder}/c8`).filter(name => name.endsWith('.json'))
    .flatMap(name => json(`${folder}/c8/${name}`).result || []);
  const covered = (entry, offset) => {
    const ranges = entry.functions.flatMap(fn => fn.ranges).filter(range => range.startOffset <= offset && offset < range.endOffset)
      .sort((a, b) => (a.endOffset - a.startOffset) - (b.endOffset - b.startOffset));
    return ranges[0]?.count > 0;
  };
  const report = json('test/support/operator-kit-changes.json').map(change => {
    const text = read(change.file);
    assert.equal(hash(text), change.sha256, 'Changed-line manifest is stale');
    const matches = entries.filter(entry => entry.url.endsWith(`/${change.file}`));
    let at = 0;
    const offsets = text.split('\n').map(line => { const position = at + Math.max(0, line.search(/\S/u)); at += line.length + 1; return position; });
    const missing = change.lines.filter(line => !matches.some(entry => covered(entry, offsets[line - 1])));
    return { file: change.file, total: change.lines.length, covered: change.lines.length - missing.length, missing };
  });
  save('changed-coverage', report);
  console.log(JSON.stringify(report));
  assert.ok(report.every(row => row.missing.length === 0));
}
function mutation() {
  const before = source();
  const results = Object.keys(mutants).map(name => {
    const result = run(`mutant-${name}`, process.execPath, ['--experimental-loader', './test/support/operator-kit-mutation-loader.mjs',
      '--test', 'test/mbt/property/operator-kit.property.test.js'], { env: { ...process.env, OPERATOR_KIT_MUTANT: name } });
    const killed = result.status === 1 && result.stdout.includes('not ok') && result.stdout.includes('Counterexample:');
    return { name, killed, propertySuiteOnly: true };
  });
  save('mutations', results);
  assert.deepEqual(source(), before);
  assert.ok(results.every(row => row.killed), JSON.stringify(results));
  console.log(JSON.stringify(results));
}
function compare() {
  const log = read(`${folder}/full.log`);
  assert.match(log, /Isolated MBT main run (?:passed|failed)/u);
  const failedTests = [...new Set(log.split('\n').filter(line => line.startsWith('✖ ') && line !== '✖ failing tests:')
    .map(line => line.slice(2).replace(/ \([0-9.]+ms\)$/u, '')))].sort();
  const baseline = json('test/support/operator-kit-baseline-failures.json');
  const unexpected = difference(failedTests, baseline.failedTests);
  const counts = [...log.matchAll(/ℹ (tests|pass|fail|skipped) (\d+)/gu)].reduce((totals, match) => {
    totals[match[1]] = (totals[match[1]] || 0) + Number(match[2]); return totals;
  }, {});
  save('full-comparison', { counts, baseline: baseline.counts, failedTests, unexpected });
  assert.deepEqual(unexpected, []);
  console.log(JSON.stringify({ ...counts, newFailures: unexpected.length }));
}
function health() {
  const shuffled = [...tests].sort((a, b) => hash(`120656:${a}`).localeCompare(hash(`120656:${b}`)));
  for (const [index, file] of shuffled.entries()) {
    assert.equal(run(`health-${index}`, process.execPath, ['--test', file]).status, 0, file);
  }
  save('health', { files: shuffled, failures: 0, seed: 120656 });
}
function secrets() {
  const findings = scanUnifiedDiff(read('test/support/operator-kit-changes.patch'));
  for (const file of files.filter(name => !production.includes(name) && /\.(?:js|mjs|py|sh)$/u.test(name)
    && (!tests.includes(name) || name.includes('operator-kit')))) {
    findings.push(...scanTextForSecrets(read(file), file));
  }
  const baseline = json('test/support/operator-kit-baseline-hashes.json');
  for (const file of ['package.json', 'package-lock.json']) { assert.equal(hash(read(file)), baseline[file], 'Dependency changes are out of scope'); }
  save('secrets', findings);
  assert.deepEqual(findings, []);
}
const commands = { static: staticChecks, coverage, mutation, compare, health, secrets,
  source: () => save('source', source()), verify: () => assert.deepEqual(source(), json(`${folder}/source.json`)) };
assert.ok(commands[process.argv[2]], 'Unknown kit check');
await commands[process.argv[2]]();
