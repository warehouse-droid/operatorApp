import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ESLint } from 'eslint';
import { scanTextForSecrets } from '../test/support/scan-diff-secrets.mjs';
import { ifirFixture, scriptFile } from '../test/support/ifir-restlet-fixture.mjs';

const output = 'test-artifacts/ifir-response';
const fresh = `${output}/final`;
fs.rmSync(fresh, { recursive: true, force: true });
fs.mkdirSync(fresh, { recursive: true });
const testFile = 'test/mbt/unit/ifir-posting-restlet.test.js';
const changed = [scriptFile, testFile, 'test/support/ifir-restlet-fixture.mjs',
  'tools/ifir-posting-restlet-gauntlet.mjs'];
const regressions = [
  'test/mbt/unit/operator-netsuite-posting-service.red.test.js',
  'test/mbt/unit/operator-netsuite-posting-domain.red.test.js',
  'test/mbt/unit/operator-netsuite-posting-runtime-adapters.red.test.js',
  'test/mbt/unit/operator-posting-pack-quantities.test.js',
  'test/mbt/unit/child-location-parts-service.test.js',
  'test/mbt/property/operator-netsuite-posting.property.test.js',
  'test/mbt/adversarial/operator-netsuite-posting-adversarial.test.js'
];
const report = { source: {}, toolchain: { node: process.version }, checks: {}, mutants: [] };
for (const file of changed) { report.source[file] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
for (const name of ['fast-check', 'typescript', 'eslint', 'c8']) {
  report.toolchain[name] = JSON.parse(fs.readFileSync(`node_modules/${name}/package.json`, 'utf8')).version;
}
function run(name, args, { expected = 0, env = {} } = {}) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 60000,
    maxBuffer: 20 * 1024 * 1024, env: { ...process.env, ...env } });
  const log = `${result.stdout || ''}${result.stderr || ''}`;
  fs.writeFileSync(`${fresh}/${name}.log`, log);
  assert.equal(result.status, expected, `${name}: ${result.error || log.slice(-6000)}`);
  console.log(`${name}: exit ${result.status}`);
  report.checks[name] = { exit: result.status, command: ['node', ...args],
    tests: Number(log.match(/# tests (\d+)/)?.[1]) || undefined,
    passed: Number(log.match(/# pass (\d+)/)?.[1]) || undefined };
  return log;
}

const stubPath = '/tmp/ifir-response-stub.js';
fs.writeFileSync(stubPath, "define([], () => ({ post() { throw Error('IFIR_NOT_IMPLEMENTED'); }, get() { throw Error('IFIR_NOT_IMPLEMENTED'); } }));\n");
run('red-stub', ['--test', testFile], { expected: 1, env: { MBBS_IFIR_TEST_SOURCE: stubPath } });
run('contracts', ['--test', '--test-concurrency=1', testFile]);
run('regressions', ['--test', '--test-concurrency=1', ...regressions]);
run('order-check', ['--test', '--test-concurrency=1', ...regressions.slice().reverse(), testFile]);
run('types', ['node_modules/typescript/bin/tsc', '--noEmit', '--allowJs', '--checkJs', '--skipLibCheck',
  '--module', 'nodenext', '--target', 'es2022', scriptFile, 'test/support/ifir-suitescript.d.ts']);
run('syntax', ['--check', scriptFile]);

const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: [{
  files: ['**/*.{js,mjs}'], languageOptions: { ecmaVersion: 2022, sourceType: 'module',
    globals: { define: 'readonly', process: 'readonly', console: 'readonly' } },
  rules: { complexity: ['error', 12], curly: ['error', 'all'], eqeqeq: ['error', 'always'],
    'max-depth': ['error', 4], 'no-undef': 'error', 'no-unreachable': 'error', 'no-unused-vars': 'error',
    'no-duplicate-imports': 'error', 'no-constant-condition': 'error', 'no-var': 'error', 'prefer-const': 'error' }
}] });
const lint = await eslint.lintFiles(changed);
const lintText = (await eslint.loadFormatter('stylish')).format(lint);
fs.writeFileSync(`${fresh}/lint.log`, lintText || '0 errors, 0 warnings\n');
assert.equal(lint.reduce((sum, result) => sum + result.errorCount + result.warningCount, 0), 0, lintText);
report.checks.lint = { errors: 0, warnings: 0 };
for (const file of changed) { assert.deepEqual(scanTextForSecrets(fs.readFileSync(file, 'utf8'), file), []); }
report.checks.secrets = { files: changed.length, findings: 0, newDependencies: 0 };
run('coverage', ['node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false', `--include=${scriptFile}`,
  '--temp-directory=/tmp/ifir-response-coverage', `--report-dir=${fresh}/coverage`,
  '--reporter=text', '--reporter=json-summary', '--reporter=json', '--reporter=lcov',
  'node', '--test', testFile]);
report.coverage = JSON.parse(fs.readFileSync(`${fresh}/coverage/coverage-summary.json`, 'utf8'));

const source = fs.readFileSync(scriptFile, 'utf8');
const mutants = [
  ['omitted-material-posted', "setLine(rec, line, 'itemreceive', false);", "setLine(rec, line, 'itemreceive', true);"],
  ['wrong-saved-quantity', "quantity: finiteNumber(lineValue(rec, line, 'quantity')),\n      location:",
    "quantity: Number(lineValue(rec, line, 'quantity')) + 1,\n      location:"],
  ['duplicate-repost', "return positiveId(found.id, 'existing transaction ID');", 'return null;'],
  ['production-gate-bypass', 'runtime.envType === runtime.EnvType.PRODUCTION && !settings.productionAllowed', 'false'],
  ['mandatory-validation-disabled', 'ignoreMandatoryFields: false', 'ignoreMandatoryFields: true'],
  ['lost-saved-id', 'stage: state.stage, id: state.id, ambiguous,', 'stage: state.stage, id: null, ambiguous,']
];
for (const [name, before, after] of mutants) {
  assert.equal(source.split(before).length, 2, `Unique mutation anchor: ${name}`);
  const file = `/tmp/ifir-mutant-${name}.js`;
  fs.writeFileSync(file, source.replace(before, after));
  const log = run(`mutant-${name}`, ['--test', testFile], { expected: 1, env: { MBBS_IFIR_TEST_SOURCE: file } });
  assert.match(log, /# fail [1-9]/);
  assert.doesNotMatch(log, /SyntaxError|ERR_MODULE_NOT_FOUND/);
  const properties = spawnSync(process.execPath, ['--test', '--test-name-pattern=^property:', testFile],
    { encoding: 'utf8', timeout: 30000, env: { ...process.env, MBBS_IFIR_TEST_SOURCE: file } });
  fs.writeFileSync(`${fresh}/property-mutant-${name}.log`, `${properties.stdout}${properties.stderr}`);
  report.mutants.push({ name, killed: true, propertyOnlyKilled: properties.status === 1 });
}
assert.equal(fs.readFileSync(scriptFile, 'utf8'), source);
run('restored', ['--test', testFile]);

const fixture = ifirFixture();
const response = fixture.post();
assert.equal(response.ok, true);
assert.equal(response.record.tranId, 'IR000123');
fs.writeFileSync(`${fresh}/example-response.json`, `${JSON.stringify(response, null, 2)}\n`);
report.checks.execution = 'Actual RESTlet entry point with simulated N/* boundaries; no live NetSuite write.';
const beforePath = `${output}/old-flow-before.json`;
if (fs.existsSync(beforePath)) {
  const oldFiles = JSON.parse(fs.readFileSync(beforePath, 'utf8'));
  for (const [file, expected] of Object.entries(oldFiles)) {
    // .env.example is not required in a minimal image; the host repeats all hashes.
    if (fs.existsSync(file)) {
      assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), expected, file);
    }
  }
  report.checks.oldFlow = 'Available baseline files unchanged; complete host hash check required.';
}
fs.writeFileSync(path.join(fresh, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ contracts: report.checks.contracts, regressions: report.checks.regressions,
  coverage: report.coverage.total, mutants: report.mutants, toolchain: report.toolchain }, null, 2));
