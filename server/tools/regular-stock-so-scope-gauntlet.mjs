import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cp, mkdir, mkdtemp, readFile, writeFile, symlink, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {ESLint} from 'eslint';
import {regularTests} from './regular-stock-v2-suites.mjs';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
const mode = process.argv[2], out = 'test-artifacts';
const sourceFile = 'src/regular-stock-handoff.js';
const focused = 'test/mbt/integration/regular-stock-so-scope.test.js';
const kit = 'test/mbt/integration/regular-stock-kit.test.js';
const source = await readFile(sourceFile, 'utf8');
const sourceHash = createHash('sha256').update(source).digest('hex');
const layers = [];
async function run(name, args, options = {}) {
  const result = spawnSync(process.execPath, args, {encoding: 'utf8', maxBuffer: 40_000_000, timeout: 600000, ...options});
  const output = (result.stdout || '') + (result.stderr || '');
  await writeFile(`${out}/${name}.log`, output);
  const failures = [...output.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]);
  const count = label => Number(output.match(new RegExp('^# ' + label + ' (\\d+)$', 'm'))?.[1] || 0);
  const record = {name, exitCode: result.status, tests: count('tests'), passed: count('pass'), failed: count('fail'), skipped: count('skipped'), failures};
  layers.push(record);
  console.log(JSON.stringify(record));
  assert.equal(result.signal, null, name + ' timed out or was killed');
  return {record, output};
}
const legacy = JSON.parse(await readFile('package.json', 'utf8')).scripts['test:stock-requests'].split(' ').filter(arg => arg.endsWith('.js'));
const suite = [...new Set([...regularTests, ...legacy])];
const focusedArgs = ['--test', '--test-concurrency=1', focused, kit];
const first = await run('focused', focusedArgs);
if (mode === 'red') {
  assert.equal(first.record.exitCode, 1);
  assert(first.record.failures.includes('unselected SO line added permits only the saved selected transfer'));
  assert(first.output.includes('The SO changed after approval was linked'));
} else {
  assert.equal(first.record.exitCode, 0, 'Focused behavior tests must all pass');
}
const regression = await run('regressions', ['--test', '--test-concurrency=1', ...suite]);
const types = await run('types', ['node_modules/typescript/bin/tsc', '--allowJs', '--checkJs', '--noEmit', '--skipLibCheck', '--module', 'nodenext', '--target', 'es2023', sourceFile]);
const diagnostics = [...types.output.matchAll(/^(.+?)\(\d+,\d+\): (error TS\d+: .+)$/gm)].map(match => match[1] + ': ' + match[2]);
await writeFile(`${out}/types.json`, JSON.stringify(diagnostics, null, 2));
const lint = new ESLint({overrideConfigFile: 'tools/regular-stock-v2-eslint.config.mjs'});
const lintResults = await lint.lintFiles([sourceFile, focused, 'tools/regular-stock-so-scope-gauntlet.mjs']);
const lintDiagnostics = lintResults.flatMap(entry => entry.messages.map(({ruleId, severity, message}) => ({file: entry.filePath.replace(resolve('.') + '/', ''), ruleId, severity, message})));
await writeFile(`${out}/lint.json`, JSON.stringify(lintDiagnostics, null, 2));
assert.deepEqual(lintDiagnostics, [], 'No lint errors in task files');
if (mode === 'red') {
  await writeFile(`${out}/report.json`, JSON.stringify({sourceHash, layers, regressionFailures: regression.record.failures, typeDiagnostics: diagnostics, suite}, null, 2));
  process.exit(0);
}
const baseline = JSON.parse(await readFile('/red/report.json', 'utf8'));
assert.deepEqual(regression.record.failures.filter(name => !baseline.regressionFailures.includes(name)), [], 'No new regression failures');
const remainingTypes = baseline.typeDiagnostics.slice();
const addedTypes = diagnostics.filter(message => {
  const index = remainingTypes.indexOf(message);
  if (index < 0) { return true; }
  remainingTypes.splice(index, 1);
  return false;
});
assert.deepEqual(addedTypes, [], 'No new type diagnostics, including repeated messages');
assert([0, 1].includes(regression.record.exitCode), 'Unexpected regression runner exit');
const coverage = await run('coverage', ['node_modules/c8/bin/c8.js', '--all=false', '--include=' + sourceFile,
  '--check-coverage=false', '--reporter=json', '--report-dir=test-artifacts/coverage', '--temp-directory=/tmp/so-scope-coverage',
  'node', ...focusedArgs, 'test/mbt/integration/regular-stock-handoff.test.js', 'test/mbt/integration/regular-stock-delivery-simple.test.js']);
assert.equal(coverage.record.exitCode, 0);
const measured = JSON.parse(await readFile(`${out}/coverage/coverage-final.json`, 'utf8'))[resolve(sourceFile)];
const changed = source.split('\n').map((text, index) => ({text, line: index + 1})).filter(row => row.text.includes('const checkedLines') || row.text.includes('? original.lines.filter') || row.text.includes('fresh.id!==original.id') || row.text.includes('!handoff.plan.delivery && fresh.lines.length'));
const covered = changed.map(({line}) => ({line, covered: Object.entries(measured.statementMap).some(([key, value]) => value.start.line <= line && value.end.line >= line && measured.s[key] > 0)}));
assert(covered.length >= 4);
assert(covered.every(row => row.covered), 'Changed executable lines must be covered');
const mutations = [
  ['check every line again', 'original.lines.filter((/** @type {{remoteLineId:number}} */ line)=>handoff.plan.materialLineIds.includes(line.remoteLineId))', 'original.lines'],
  ['block unrelated added lines again', '!handoff.plan.delivery && fresh.lines.length!==original.lines.length', 'fresh.lines.length!==original.lines.length'],
  ['check unselected lines instead', 'materialLineIds.includes(line.remoteLineId)) : original.lines', 'materialLineIds.includes(line.remoteLineId) === false) : original.lines'],
  ['allow selected quantity change', 'current.quantity!==line.quantity||', ''],
  ['allow different customer', 'fresh.customerId!==original.customerId||', '']
];
const temporary = await mkdtemp(join(tmpdir(), 'so-scope-mutants-')), mutants = [];
try {
  await cp('src', join(temporary, 'src'), {recursive: true});
  await mkdir(join(temporary, 'test/mbt/integration'), {recursive: true});
  await cp(focused, join(temporary, focused));
  await cp('package.json', join(temporary, 'package.json'));
  await symlink(resolve('node_modules'), join(temporary, 'node_modules'), 'dir');
  await symlink(resolve('public'), join(temporary, 'public'), 'dir');
  for (const [index, [name, needle, replacement]] of mutations.entries()) {
    assert.equal(source.split(needle).length, 2, 'Unique mutation anchor: ' + name);
    await writeFile(join(temporary, sourceFile), source.replace(needle, replacement));
    for (const propertiesOnly of [false, true]) {
      const result = await run(`mutant-${index}-${propertiesOnly}`, ['--test', ...(propertiesOnly ? ['--test-name-pattern=property:'] : []), focused], {cwd: temporary});
      assert.equal(result.record.exitCode, 1, name + ' must be killed');
      assert(result.record.failures.some(failure => !failure.startsWith('/')), 'Must fail an assertion, not collection');
    }
    mutants.push({name, killed: true, killedByProperties: true});
  }
  await writeFile(join(temporary, sourceFile), source);
  assert.equal((await run('mutants-restored', ['--test', focused], {cwd: temporary})).record.exitCode, 0);
} finally {
  await rm(temporary, {recursive: true, force: true});
}
// Vary the meaningful suite order by starting files in independent Node processes.
for (const [index, file] of [kit, 'test/mbt/integration/regular-stock-delivery-simple.test.js', focused, 'test/mbt/integration/regular-stock-handoff.test.js'].entries()) {
  assert.equal((await run('reordered-' + index, ['--test', file])).record.exitCode, 0);
}
const syntax = await run('syntax', ['--check', sourceFile]);
assert.equal(syntax.record.exitCode, 0);
const toolchain = {node: process.version};
for (const name of ['fast-check', 'c8', 'eslint', 'typescript']) {
  toolchain[name] = JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8')).version;
}
const report = {passed: true, sourceHash, layers, suite, coveredChangedLines: covered, mutants, toolchain,
  regressionBaselineFailures: regression.record.failures, newRegressionFailures: [], newTypeDiagnostics: [],
  baselineTypeDiagnosticCount: diagnostics.length, propertySeeds: [1052026, 1052027, 121865],
  dependenciesChanged: false, schemaChanged: false, capabilityChange: 'None',
  skipped: {repositoryWideSuite: 'Unrelated dirty workspace; full regular-stock and legacy stock-request suites compared against captured production', browserVisuals: 'No UI change; existing browser tests included in the regression comparison', supplyChainAudit: 'No dependency changes'}};
await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({passed: true, coveredChangedLines: covered.length, mutants: mutants.length, regressions: regression.record, baselineTypes: diagnostics.length}));
