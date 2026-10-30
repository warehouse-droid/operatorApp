import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ESLint } from 'eslint';
import { scanTextForSecrets } from '../test/support/scan-diff-secrets.mjs';

const output = 'test-artifacts/ifir-integration/final';
const changed = ['src/config.js', 'src/netsuite.js', 'src/netsuite-ifir-posting-client.js',
  'src/operator-netsuite-posting-netsuite-adapter.js', 'src/operator-netsuite-posting-service.js',
  'src/item-fulfillment-parts-service.js', 'src/sales-order-auto-fulfillment-service.js'];
const clientTest = 'test/mbt/unit/ifir-posting-client.test.js';
const regressions = fs.readdirSync('test/mbt/unit').filter(name =>
  /^(operator-netsuite-posting-|operator-kit|operator-posting-(?:pack|rounding)|sales-order-auto-fulfillment|child-location-|noninventory-fulfillment|special-fulfillment-adapter|special-approval-fulfillment|transfer-order-background-posting|ifir-posting-restlet)/.test(name)
  && name.endsWith('.test.js')).map(name => `test/mbt/unit/${name}`);
regressions.push('test/mbt/property/operator-netsuite-posting.property.test.js',
  'test/mbt/adversarial/operator-netsuite-posting-adversarial.test.js');
const tests = [clientTest, ...regressions];
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function diagnostics(baseline) {
  const args = ['node_modules/typescript/bin/tsc', '--noEmit', '--allowJs', '--checkJs', '--skipLibCheck',
    '--module', 'nodenext', '--target', 'es2022',
    ...changed.filter(file => !baseline || fs.existsSync(`ifir-before/${file}`))];
  const result = spawnSync(process.execPath, args, { cwd: baseline ? '/tmp/ifir-integration-baseline' : process.cwd(),
    encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.signal, null);
  const text = `${result.stdout || ''}${result.stderr || ''}`;
  fs.writeFileSync(`${output}/types-${baseline ? 'baseline' : 'current'}.log`, text);
  assert.ok([0, 1, 2].includes(result.status), text);
  return text.split('\n').filter(line => /error TS\d+/.test(line)).map(line =>
    line.replace(/\(\d+,\d+\)/g, '').replaceAll('/tmp/ifir-integration-baseline/', '').replaceAll('/app/', ''));
}
if (process.argv.includes('--types')) {
  const before = diagnostics(true), after = diagnostics(false);
  const keys = new Set(before.map(item => JSON.stringify(item)));
  const newIssues = after.filter(item => !keys.has(JSON.stringify(item)));
  fs.writeFileSync(`${output}/types.json`, JSON.stringify({ baseline: before.length, current: after.length, newIssues }, null, 2));
  console.log(JSON.stringify({ baseline: before.length, current: after.length, newIssues }));
  process.exit(newIssues.length ? 1 : 0);
}

fs.rmSync(output, { recursive: true, force: true }); fs.mkdirSync(output, { recursive: true });
const report = { source: Object.fromEntries(changed.map(file => [file, sha(file)])),
  tools: { node: process.version }, commands: {}, mutation: [], skipped: [] };
for (const tool of ['fast-check', 'typescript', 'eslint', 'c8']) {
  report.tools[tool] = JSON.parse(fs.readFileSync(`node_modules/${tool}/package.json`, 'utf8')).version;
}
function run(name, args, { cwd = process.cwd(), allowFailure = false } = {}) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
  const text = `${result.stdout || ''}${result.stderr || ''}`;
  fs.writeFileSync(`${output}/${name}.log`, text);
  const summary = { command: ['node', ...args], cwd, exit: result.status,
    tests: Number(text.match(/# tests (\d+)/)?.[1] || 0), passed: Number(text.match(/# pass (\d+)/)?.[1] || 0),
    failed: Number(text.match(/# fail (\d+)/)?.[1] || 0),
    failures: [...text.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]) };
  report.commands[name] = summary;
  console.log(JSON.stringify({ name, ...summary, command: undefined, cwd: undefined }));
  assert.equal(result.signal, null, `${name}: ${result.error || 'terminated'}`);
  if (!allowFailure) { assert.equal(result.status, 0, `${name}: ${text.slice(-7000)}`); }
  return summary;
}
function copyRuntime(directory) {
  fs.rmSync(directory, { recursive: true, force: true }); fs.mkdirSync(directory);
  fs.cpSync('src', `${directory}/src`, { recursive: true });
  fs.cpSync('test', `${directory}/test`, { recursive: true });
  for (const name of ['node_modules', 'public', 'migrations', 'contracts']) {
    fs.symlinkSync(path.resolve(name), `${directory}/${name}`);
  }
  for (const name of ['package.json', '.env.example', 'netsuite-ifir-posting-restlet.js']) {
    fs.copyFileSync(name, `${directory}/${name}`);
  }
}
const baselineRoot = '/tmp/ifir-integration-baseline';
copyRuntime(baselineRoot);
for (const file of changed) {
  if (fs.existsSync(`ifir-before/${file}`)) { fs.copyFileSync(`ifir-before/${file}`, `${baselineRoot}/${file}`); }
}
// Newly added response-consumption assertions are RED against the old source;
// exclude only those assertions from the unrelated-regression baseline.
for (const file of regressions) {
  const target = `${baselineRoot}/${file}`;
  fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace(/\ntest\('IFIR[\s\S]*?\n\}\);\n/g, '\n'));
}
const baseline = run('baseline', ['--test', '--test-concurrency=1', '--test-name-pattern=^(?!IFIR)', ...regressions],
  { cwd: baselineRoot, allowFailure: true });
const current = run('contracts-regressions', ['--test', '--test-concurrency=1', ...tests], { allowFailure: true });
const newFailures = current.failures.filter(name => !baseline.failures.includes(name));
assert.deepEqual(newFailures, [], `New regression failures: ${newFailures.join(', ')}`);
assert.equal(current.failed, current.failures.length);
assert.ok(current.passed > baseline.passed);
report.newFailures = newFailures;
const reversed = run('order-check', ['--test', '--test-concurrency=1', ...tests.slice().reverse()], { allowFailure: true });
assert.deepEqual(reversed.failures.sort(), current.failures.slice().sort());
assert.equal(reversed.passed, current.passed);
run('types', ['tools/ifir-integration-gauntlet.mjs', '--types']);
report.types = JSON.parse(fs.readFileSync(`${output}/types.json`));

const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: [{ files: ['**/*.{js,mjs}'],
  languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: Object.fromEntries([
    'process', 'console', 'URL', 'Buffer', 'AbortSignal', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    'fetch', 'structuredClone', 'performance'].map(name => [name, 'readonly'])) },
  rules: { complexity: ['error', 12], curly: ['error', 'all'], eqeqeq: ['error', 'always'],
    'no-undef': 'error', 'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-unreachable': 'error', 'no-constant-condition': 'error', 'no-var': 'error', 'prefer-const': 'error' }
}] });
const lintIssues = [], lintBaseline = [];
for (const file of changed) {
  run(`syntax-${path.basename(file)}`, ['--check', file]);
  for (const [baselineMode, destination] of [[true, lintBaseline], [false, lintIssues]]) {
    const source = baselineMode ? `ifir-before/${file}` : file;
    if (!fs.existsSync(source)) { continue; }
    const [result] = await eslint.lintText(fs.readFileSync(source, 'utf8'), { filePath: file });
    destination.push(...result.messages.map(message => ({ file, rule: message.ruleId, message: message.message })));
  }
  assert.deepEqual(scanTextForSecrets(fs.readFileSync(file, 'utf8'), file), [], file);
}
const priorLint = new Set(lintBaseline.map(row => JSON.stringify(row)));
report.lint = { baseline: lintBaseline.length, current: lintIssues.length,
  newIssues: lintIssues.filter(row => !priorLint.has(JSON.stringify(row))) };
fs.writeFileSync(`${output}/lint.json`, JSON.stringify(report.lint, null, 2));
assert.deepEqual(report.lint.newIssues, []);
report.secrets = { files: changed.length, findings: 0, dependenciesAdded: 0 };

run('coverage', ['node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false',
  ...changed.map(file => `--include=${file}`), '--temp-directory=/tmp/ifir-integration-coverage',
  `--report-dir=${output}/coverage`, '--reporter=json', '--reporter=json-summary', '--reporter=text',
  'node', '--test', '--test-concurrency=1', ...tests], { allowFailure: Boolean(baseline.failed) });
report.coverage = JSON.parse(fs.readFileSync(`${output}/coverage/coverage-summary.json`));

const mutationRoot = '/tmp/ifir-integration-mutants'; copyRuntime(mutationRoot);
const mutants = [
  ['feature-gate-ignored', changed[2], 'configured.enabled !== true || !supported(step)', '!supported(step)'],
  ['identity-not-checked', changed[2], 'positiveId(data.record?.id) !== positiveId(data.id)', 'false'],
  ['saved-quantity-not-verified', changed[2], 'verifyPurchaseReceiptWithCharges(step, data.record, data.source);', 'void step;'],
  ['package-mismatch-ignored', changed[2], "if (step.transactionType !== 'IF') { return; }", 'return;'],
  ['extra-record-request', 'src/operator-netsuite-posting-service.js', 'record = transformed.record ?? await telemetry.context', 'record = await telemetry.context'],
  ['non-error-rejection-native-repost', changed[2], 'throw unverified(String(error));', 'return null;']
];
for (const [name, file, before, after] of mutants) {
  const source = fs.readFileSync(file, 'utf8');
  assert.equal(source.split(before).length, 2, `Mutation anchor ${name}`);
  fs.writeFileSync(`${mutationRoot}/${file}`, source.replace(before, after));
  try {
    const result = run(`mutant-${name}`, ['--test', '--test-name-pattern=IFIR|property: IFIR', clientTest,
      'test/mbt/unit/operator-netsuite-posting-service.red.test.js'], { cwd: mutationRoot, allowFailure: true });
    assert.ok(result.exit === 1 && result.failed > 0, `Surviving mutant: ${name}`);
    const property = run(`property-mutant-${name}`, ['--test', '--test-name-pattern=^property: IFIR', clientTest],
      { cwd: mutationRoot, allowFailure: true });
    report.mutation.push({ name, killed: true, propertyOnlyKilled: property.failed > 0 });
  } finally { fs.writeFileSync(`${mutationRoot}/${file}`, source); }
}
for (const file of changed) { assert.equal(sha(file), report.source[file]); }
run('restored', ['--test', clientTest]);
report.skipped = ['Unrelated whole-application/database/browser suites: bounded change to posting transport and response consumption.',
  'Production transaction creation: history replays use existing external IDs; no new transaction is created for validation.',
  'Dependency audit/license checks: dependency set unchanged.'];
fs.writeFileSync(`${output}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: current.passed, baselineFailures: baseline.failures,
  newFailures, types: report.types, lint: report.lint, mutation: report.mutation, tools: report.tools }, null, 2));
