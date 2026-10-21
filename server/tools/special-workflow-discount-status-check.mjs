import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.ok(process.env.DATABASE_URL?.endsWith('/mbt_verify'));
const out = 'test-artifacts/special-workflow-review/discount-status';
const script = 'netsuite-smart-scm-picking-ticket-restlet.js';
const test = 'test/mbt/unit/special-workflow-adjustment-restlet.test.js';
const source = readFileSync(script, 'utf8');
const tests = ['unit', 'property', 'integration'].flatMap(kind => readdirSync(`test/mbt/${kind}`)
  .filter(name => /^special-.*\.test\.js$/.test(name)).sort().map(name => `test/mbt/${kind}/${name}`));
const relevant = ['special-workflow-adjustments', 'special-workflow-adjustment-adapter', 'special-workflow-adjustment-restlet']
  .map(name => `test/mbt/unit/${name}.test.js`);
function run(name, command, args, { failure = false } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 300000, maxBuffer: 20 * 1024 * 1024 });
  const log = (result.stdout || '') + (result.stderr || '');
  writeFileSync(`${out}/${name}.txt`, log);
  if (failure) assert.ok(result.status !== 0 && /^not ok /m.test(log), `${name} did not kill its mutant`);
  else assert.equal(result.status, 0, `${name} failed; see ${out}/${name}.txt`);
  console.log(JSON.stringify({ check: name, passed: true })); return log;
}
const suite = run('related-tests', 'node_modules/.bin/c8', ['--all=false', '--check-coverage=false', `--include=${script}`,
  `--temp-directory=${out}/c8`, `--report-dir=${out}/coverage`, '--reporter=json', process.execPath, '--test', '--test-concurrency=1', ...tests]);
run('restlet-harness', process.execPath, ['src/netsuite-restlet-harness.js']);
run('syntax-restlet', process.execPath, ['--check', script]);
const tools = ['tools/special-workflow-discount-status-check.mjs', 'tools/special-workflow-discount-convert-000007.mjs'];
for (const file of tools) run(`syntax-${file.split('/').pop()}`, process.execPath, ['--check', file]);
run('lint', 'node_modules/.bin/eslint', ['--config', 'tools/special-workflow-native-eslint.config.mjs', '--max-warnings=0', script, test, ...tools]);
const coverage = Object.values(JSON.parse(readFileSync(`${out}/coverage/coverage-final.json`, 'utf8'))).find(file => file.path.endsWith('/' + script));
assert.ok(coverage);
const changed = source.split('\n').flatMap((line, index) => /const VERSION|const status=String\(order.getValue|if\(!\['A','B'\]/.test(line) ? [index + 1] : []);
assert.equal(changed.length, 3);
const executed = changed.filter(line => Object.entries(coverage.statementMap).some(([id, range]) => range.start.line <= line && range.end.line >= line && coverage.s[id] > 0));
assert.deepEqual(executed, changed);
const mutations = [
  { before: "if(!['A','B'].includes(status))", after: 'if(false)', properties: true },
  { before: "if(!['A','B'].includes(status))", after: "if(!['A','C'].includes(status))", properties: true },
  { before: "const status=String(order.getValue({fieldId:'orderstatus'})", after: "const status=String(order.getText({fieldId:'orderstatus'})", properties: true },
  { before: "adjustmentError('Fulfilled, received, billed or closed lines cannot be adjusted.');", after: 'void 0;', properties: false }
];
try {
  for (const [index, mutant] of mutations.entries()) {
    assert.equal(source.split(mutant.before).length, 2);
    writeFileSync(script, source.replace(mutant.before, mutant.after));
    run(`mutant-${index + 1}-contract`, process.execPath, ['--test', test], { failure: true });
    if (mutant.properties) run(`mutant-${index + 1}-property`, process.execPath, ['--test', '--test-name-pattern=^property:', test], { failure: true });
  }
} finally { writeFileSync(script, source); }
assert.equal(readFileSync(script, 'utf8'), source);
run('suite-health', process.execPath, ['--test', '--test-concurrency=1', ...relevant.toReversed()]);
run('secrets', process.execPath, ['test/support/scan-diff-secrets.mjs', script, test, ...tools]);
const files = [script, test, ...tools, 'src/netsuite-restlet-harness.js', 'test/special-workflow-discount-conversion-000007-spec.md'];
const hashes = Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
writeFileSync(`${out}/source-manifest.json`, JSON.stringify(hashes, null, 2));
const summary = { completed: true, tests: Number(/^# tests (\d+)$/m.exec(suite)?.[1]), passed: Number(/^# pass (\d+)$/m.exec(suite)?.[1]),
  changedLines: changed, changedLinesCovered: executed.length, contractMutantsKilled: 4, propertyMutantsKilled: 3,
  node: process.version, scriptSha256: hashes[script], sourceHash: createHash('sha256').update(JSON.stringify(hashes)).digest('hex'),
  tools: Object.fromEntries(['eslint', 'c8', 'fast-check'].map(name => [name, JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version])) };
writeFileSync(`${out}/summary.json`, JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary));
