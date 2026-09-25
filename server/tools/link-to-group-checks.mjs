import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ESLint } from 'eslint';
import base from '../eslint.mbt.config.js';
import { runNodeTestFilesIsolated } from '../test/support/test-database-isolation.mjs';
import { scanUnifiedDiff } from '../test/support/scan-diff-secrets.mjs';
import { mutants } from '../test/support/link-to-group-mutation-loader.mjs';

const folder = 'test-artifacts/link-to-group';
mkdirSync(folder, { recursive: true });
const read = file => readFileSync(file, 'utf8');
const json = file => JSON.parse(read(file));
const save = (name, value) => writeFileSync(`${folder}/${name}.json`, `${JSON.stringify(value, null, 2)}\n`);
const hash = value => createHash('sha256').update(value).digest('hex');
const regressions = ['test/mbt/unit/link-to-group.test.js', 'test/mbt/integration/link-to-group.test.js', 'test/mbt/integration/link-to-group-http.test.js'];
const neighbors = ['test/mbt/integration/link-to-fix.test.js', 'test/mbt/unit/group-action-ui.test.js',
  'test/mbt/integration/group-action-fix.test.js', 'test/mbt/integration/group-action-http.test.js',
  'test/mbt/property/link-to-fix.property.test.js', 'test/dispatch/frontend/direct-to-same-yard.test.js',
  'test/dispatch/frontend/sales-order-group-hydration.red.test.js',
  'test/dispatch/frontend/dispatch-to-dependency-planning-authority.red.test.js',
  'test/dispatch/integration/order-dependency-quantity-replay.red.test.js',
  'test/dispatch/integration/order-dependency-multi-to-extension.red.test.js',
  'test/dispatch/integration/dispatch-global-order-group-pool.red.test.js',
  'test/dispatch/integration/scm-dependency-preview-blockers.red.test.js',
  'test/dispatch/property/dispatch-global-order-group-pool.property.test.js'];
const tooling = ['test/support/link-to-group-mutation-loader.mjs', 'tools/link-to-group-checks.mjs'];
function run(name, args, extra = {}) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 100e6, ...extra });
  assert.ifError(result.error);
  writeFileSync(`${folder}/${name}.log`, result.stdout + result.stderr);
  return result;
}
function difference(after, before) {
  const remaining = [...before];
  return after.filter(entry => {
    const index = remaining.indexOf(entry);
    if (index < 0) {return true;}
    remaining.splice(index, 1);
    return false;
  });
}
async function packet(shuffle = false) {
  const files = [...regressions, ...neighbors];
  if (shuffle) {files.sort((a, b) => hash(`6635:${a}`).localeCompare(hash(`6635:${b}`)));}
  const environment = { ...process.env };
  if (!shuffle) {environment.NODE_V8_COVERAGE = `${process.cwd()}/${folder}/coverage`;}
  assert.equal(await runNodeTestFilesIsolated(files, { environment, label: shuffle ? 'Link TO shuffled' : 'Link TO focused' }), 0);
}
async function staticChecks() {
  const production = json('test/support/link-to-group-changes.json').map(row => row.file).filter(file => file.endsWith('.js'));
  for (const file of [...production, ...regressions, ...tooling]) {
    assert.equal(run('syntax', ['--check', file]).status, 0, file);
  }
  const checked = ['src/yard-dependency-structure.js', 'src/scm-dependency-preview-service.js', ...regressions, ...tooling];
  const config = [...base, { ...base[0], files: ['src/yard-dependency-structure.js'] }];
  const lint = async (cwd, files) => (await new ESLint({ cwd, overrideConfigFile: true, overrideConfig: config }).lintFiles(files))
    .flatMap(file => file.messages.map(message => `${file.filePath.replace(`${cwd}/`, '')}:${message.ruleId}:${message.message}`));
  const beforeLint = await lint('/baseline', checked.filter(file => existsSync(`/baseline/${file}`)));
  const afterLint = await lint(process.cwd(), checked);
  const diagnostics = result => (result.stdout + result.stderr).split('\n')
    .filter(line => /error TS\d+/u.test(line)).map(line => line.replace(/\(\d+,\d+\)/u, '')).sort();
  const args = ['/app/node_modules/typescript/bin/tsc', '--project', 'tsconfig.mbt.json', '--pretty', 'false', '--noEmit'];
  const beforeTypes = diagnostics(run('baseline-types', args, { cwd: '/baseline' }));
  const afterTypes = diagnostics(run('types', args));
  const findings = [...difference(afterLint, beforeLint), ...difference(afterTypes, beforeTypes)];
  save('static', { beforeLint, afterLint, baselineTypeDiagnostics: beforeTypes.length, typeDiagnostics: afterTypes.length, findings });
  assert.deepEqual(findings, []);
}
function coverage() {
  const entries = readdirSync(`${folder}/coverage`).filter(name => name.endsWith('.json'))
    .flatMap(name => json(`${folder}/coverage/${name}`).result || []);
  const report = json('test/support/link-to-group-changes.json').filter(row => row.file.endsWith('.js')).map(row => {
    const source = read(row.file);
    assert.equal(hash(source), row.sha256, 'Stale source manifest');
    const matching = entries.filter(entry => entry.url.endsWith(`/${row.file}`));
    let offset = 0;
    const offsets = source.split('\n').map(line => {
      const token = line.startsWith('export ') ? line.indexOf('function') : line.search(/\S/u);
      const at = offset + Math.max(0, token); offset += line.length + 1; return at;
    });
    const missing = row.lines.filter(line => !matching.some(entry => {
      const ranges = entry.functions.filter(fn => fn.ranges[0]?.startOffset !== 0).flatMap(fn => fn.ranges)
        .filter(range => range.startOffset <= offsets[line - 1] && offsets[line - 1] < range.endOffset)
        .sort((a, b) => (a.endOffset - a.startOffset) - (b.endOffset - b.startOffset));
      return ranges[0]?.count > 0;
    }));
    return { file: row.file, changed: row.lines.length, covered: row.lines.length - missing.length, missing };
  });
  save('changed-coverage', report);
  console.log(JSON.stringify(report));
  assert.ok(report.every(row => row.missing.length === 0), 'Uncovered changed production lines');
}
async function mutationCase() {
  const files = process.env.LINK_TO_GROUP_MUTANT === 'ignorePoolStructure' ? [regressions[2]] : regressions.slice(0, 2);
  process.exitCode = await runNodeTestFilesIsolated(files, { environment: process.env, label: 'Link TO mutation' });
}
function mutations() {
  const results = Object.keys(mutants).map(name => {
    const env = { ...process.env, LINK_TO_GROUP_MUTANT: name, NODE_OPTIONS: '--experimental-loader=./test/support/link-to-group-mutation-loader.mjs' };
    delete env.NODE_V8_COVERAGE;
    const result = run(`mutation-${name}`, ['tools/link-to-group-checks.mjs', 'mutation-case'], { env });
    const property = run(`mutation-${name}-property`, ['--test', '--test-name-pattern=generated manifest', regressions[0]], { env });
    return { name, killed: result.status === 1 && /not ok|✖/u.test(result.stdout), propertiesKilled: property.status === 1 && /not ok|✖/u.test(property.stdout) };
  });
  save('mutations', results);
  assert.ok(results.every(result => result.killed), JSON.stringify(results));
}
function compare() {
  const failures = log => [...new Set(log.split('\n').filter(line => line.startsWith('✖ ') && line !== '✖ failing tests:')
    .map(line => line.slice(2).replace(/ \([0-9.]+ms\)$/u, '')))].sort();
  const counts = log => [...log.matchAll(/ℹ (tests|pass|fail|skipped) (\d+)/gu)].reduce((totals, match) => {
    totals[match[1]] = (totals[match[1]] || 0) + Number(match[2]); return totals;
  }, {});
  const baseline = read(`${folder}/baseline-current-full.log`), final = read(`${folder}/full-final.log`);
  assert.match(baseline, /Isolated MBT main run (?:passed|failed)/u);
  assert.match(final, /Isolated MBT main run (?:passed|failed)/u);
  const unexpected = difference(failures(final), failures(baseline));
  save('full-comparison', { baseline: counts(baseline), final: counts(final), failures: failures(final), unexpected });
  assert.deepEqual(unexpected, []);
}
function sourceState() {
  const files = [...json('test/support/link-to-group-changes.json').map(row => row.file), ...regressions, ...tooling, 'package.json', 'package-lock.json'];
  save('source', { node: process.version, files: Object.fromEntries(files.map(file => [file, hash(read(file))])) });
  assert.deepEqual(scanUnifiedDiff(read('test/support/link-to-group-changes.patch')), []);
  for (const file of ['package.json', 'package-lock.json']) {assert.equal(hash(read(file)), hash(read(`/baseline/${file}`)));}
}
const commands = { packet, shuffle: () => packet(true), static: staticChecks, coverage, mutations, 'mutation-case': mutationCase, compare, source: sourceState };
assert.ok(commands[process.argv[2]], 'Unknown check');
await commands[process.argv[2]]();
