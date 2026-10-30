import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { scanTextForSecrets } from '/app/test/support/scan-diff-secrets.mjs';

const require = createRequire('/app/package.json');
const { ESLint } = require('eslint');
const output = '/app/test-artifacts/gauntlet';
fs.mkdirSync(output, { recursive: true });
const files = JSON.parse(fs.readFileSync('/diagnostics/changed.json', 'utf8'));
const contractTests = ['test/mbt/unit/ifir-quantity-correction.test.js', 'test/mbt/unit/ifir-quantity-rollout.test.js'];
const regressions = fs.readdirSync('test/mbt/unit').filter(name =>
  /^(operator-netsuite-posting-|operator-kit|operator-posting-(?:pack|rounding)|child-location-|ifir-posting-|ifir-admin-|noninventory-fulfillment|transfer-order-background-posting)/.test(name)
  && name.endsWith('.test.js')).map(name => `test/mbt/unit/${name}`);
regressions.push('test/mbt/property/operator-netsuite-posting.property.test.js',
  'test/mbt/adversarial/operator-netsuite-posting-adversarial.test.js');
const tests = [...contractTests, ...regressions];
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = { source: Object.fromEntries(files.map(file => [file, digest(file)])), tools: { node: process.version },
  commands: {}, mutations: [] };
for (const tool of ['fast-check', 'typescript', 'eslint', 'c8']) {
  report.tools[tool] = JSON.parse(fs.readFileSync(`node_modules/${tool}/package.json`)).version;
}
function run(name, args, { cwd = '/app', allowFailure = false, env = {} } = {}) {
  const result = spawnSync(process.execPath, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8',
    timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
  const text = (result.stdout || '') + (result.stderr || '');
  fs.writeFileSync(`${output}/${name}.log`, text);
  const summary = { exit: result.status, tests: Number(text.match(/# tests (\d+)/)?.[1] || 0),
    passed: Number(text.match(/# pass (\d+)/)?.[1] || 0), failed: Number(text.match(/# fail (\d+)/)?.[1] || 0),
    failures: [...text.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]) };
  report.commands[name] = summary;
  console.log(JSON.stringify({ name, ...summary }));
  assert.equal(result.signal, null, `${name}: ${result.error || 'terminated'}`);
  if (!allowFailure) { assert.equal(result.status, 0, `${name}\n${text.slice(-9000)}`); }
  return { ...summary, text };
}
function runtimeCopy(name, baseline = false) {
  const root = `${output}/${name}`;
  fs.mkdirSync(root);
  for (const directory of ['src', 'test']) { fs.cpSync(directory, `${root}/${directory}`, { recursive: true }); }
  for (const directory of ['node_modules', 'public', 'contracts', 'migrations']) { fs.symlinkSync(`/app/${directory}`, `${root}/${directory}`); }
  for (const file of ['package.json', '.env.example', 'netsuite-ifir-posting-restlet.js']) { fs.copyFileSync(file, `${root}/${file}`); }
  if (baseline) {
    for (const file of files) { fs.copyFileSync(`/app/test-artifacts/deployed-before/${file}`, `${root}/${file}`); }
  }
  return root;
}
const baseline = runtimeCopy('baseline', true);
const prior = run('baseline-regressions', ['--test', '--test-concurrency=1', ...regressions], { cwd: baseline, allowFailure: true });
const current = run('contracts-regressions', ['--test', '--test-concurrency=1', ...tests], { allowFailure: true });
assert.deepEqual(current.failures.filter(name => !prior.failures.includes(name)), []);
assert.equal(current.failed, current.failures.length, 'An unreported test failure occurred');
const reversed = run('reverse-order', ['--test', '--test-concurrency=1', ...tests.toReversed()], { allowFailure: true });
assert.deepEqual(reversed.failures.toSorted(), current.failures.toSorted());
assert.equal(reversed.passed, current.passed);

const typeArgs = ['node_modules/typescript/bin/tsc', '--noEmit', '--allowJs', '--checkJs', '--skipLibCheck',
  '--module', 'nodenext', '--target', 'es2022'];
run('restlet-types', [...typeArgs, 'netsuite-ifir-posting-restlet.js', 'test/support/ifir-suitescript.d.ts']);
function typeIssues(text) {
  return text.split('\n').filter(line => /error TS\d+/.test(line))
    .map(line => line.replace(/\(\d+,\d+\)/g, '').replaceAll(baseline + '/', '').replaceAll('/app/', ''));
}
const appTypes = [...typeArgs, ...files.filter(file => file.startsWith('src/'))];
const oldTypes = typeIssues(run('baseline-types', appTypes, { cwd: baseline, allowFailure: true }).text);
const newTypes = typeIssues(run('app-types', appTypes, { allowFailure: true }).text);
function addedIssues(before, after) {
  const counts = new Map();
  for (const item of before) { counts.set(item, (counts.get(item) || 0) + 1); }
  return after.filter(item => {
    const count = counts.get(item) || 0;
    if (!count) { return true; }
    counts.set(item, count - 1); return false;
  });
}
report.types = { baseline: oldTypes.length, current: newTypes.length, newIssues: addedIssues(oldTypes, newTypes) };
console.log(JSON.stringify({ types: report.types }));
assert.deepEqual(report.types.newIssues, []);

const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: [{ files: ['**/*.{js,mjs}'],
  languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: Object.fromEntries([
    'process','console','URL','Buffer','AbortSignal','setTimeout','clearTimeout','setInterval','clearInterval',
    'fetch','structuredClone','performance','define'].map(key => [key, 'readonly'])) },
  rules: { complexity: ['error', 12], curly: ['error', 'all'], eqeqeq: ['error', 'always'],
    'no-undef': 'error', 'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-unreachable': 'error', 'no-constant-condition': 'error', 'no-var': 'error', 'prefer-const': 'error' }
}] });
const oldLint = [], newLint = [];
for (const file of files) {
  run(`syntax-${path.basename(file)}`, ['--check', file]);
  for (const [source, destination] of [[`${baseline}/${file}`, oldLint], [file, newLint]]) {
    const [result] = await eslint.lintText(fs.readFileSync(source, 'utf8'), { filePath: file });
    destination.push(...result.messages.map(message => `${file}: ${message.ruleId}: ${message.message}`));
  }
  assert.deepEqual(scanTextForSecrets(fs.readFileSync(file, 'utf8'), file), [], file);
}
report.lint = { baseline: oldLint.length, current: newLint.length, newIssues: addedIssues(oldLint, newLint) };
console.log(JSON.stringify({ lint: report.lint }));
assert.deepEqual(report.lint.newIssues, []);

run('coverage', ['node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false',
  ...files.map(file => `--include=${file}`), `--temp-directory=${output}/v8`, `--report-dir=${output}/coverage`,
  '--reporter=json', '--reporter=json-summary', 'node', '--test', '--test-concurrency=1', ...tests],
{ allowFailure: Boolean(prior.failed) });
const coverage = JSON.parse(fs.readFileSync(`${output}/coverage/coverage-final.json`));
report.changedCoverage = {};
for (const file of files) {
  const diff = spawnSync('diff', ['-U0', `${baseline}/${file}`, file], { encoding: 'utf8' });
  assert.ok([0,1].includes(diff.status), 'diff tool unavailable');
  const added = new Set();
  for (const match of diff.stdout.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    for (let line = Number(match[1]); line < Number(match[1]) + Number(match[2] ?? 1); line++) { added.add(line); }
  }
  const entry = coverage[path.resolve(file)], lineHits = new Map();
  if (entry) {
    for (const [id, location] of Object.entries(entry.statementMap)) {
      for (let line = location.start.line; line <= location.end.line; line++) {
        lineHits.set(line, Math.max(lineHits.get(line) || 0, entry.s[id]));
      }
    }
  }
  const executable = [...added].filter(line => lineHits.has(line));
  const missed = executable.filter(line => lineHits.get(line) === 0);
  report.changedCoverage[file] = { executable: executable.length, covered: executable.length - missed.length, missed };
}
console.log(JSON.stringify({ changedCoverage: report.changedCoverage }));
assert.deepEqual(Object.values(report.changedCoverage).flatMap(row => row.missed), []);

const mutation = runtimeCopy('mutants');
const mutants = [
  ['no-correction', files[0], "if (unit === 'SQFT' && Math.abs(requested - remaining) < 0.01 - roundoff)", "if (false)"],
  ['wide-tolerance', files[0], '< 0.01 - roundoff', '< 0.1 - roundoff'],
  ['wrong-unit', files[0], "unit === 'SQFT' && Math.abs", 'Math.abs'],
  ['remaining-not-checked', files[0], 'if (requested > remaining)', 'if (false)'],
  ['release-hold-ignored', 'src/netsuite-ifir-posting-policy.js', 'settings.ifirPostingQuantityPolicyEnabled === true', 'true'],
  ['fallback-not-corrected', 'src/operator-netsuite-posting-fulfillment-lines.js',
    'const quantity = netSuitePostingQuantity(item.quantity, line.remainingQuantity, line.unit);', 'const quantity = item.quantity;']
];
const unitEvidenceTest = 'test/mbt/unit/operator-posting-rounding-unit-evidence.test.js';
if (fs.readFileSync('src/netsuite.js', 'utf8').includes('function salesOrderFulfillmentLineUnit')) {
  mutants.push(
    ['unit-query-projection', 'src/netsuite.js', '           BUILTIN.DF(tl.units) AS unit,\n', ''],
    ['unit-label-fallback', 'src/netsuite.js', 'return queryUnit || restUnit;', 'return restUnit;'],
    ['unit-rest-label-lost', 'src/netsuite.js', 'return queryUnit || restUnit;', 'return queryUnit;'],
    ['unit-missing-evidence-accepted', 'src/operator-netsuite-posting-fulfillment-lines.js',
      "if (snapshot.quantityCheckDeferred === true && (!isSqftPostingUnit(snapshot.salesUom) || !isSqftPostingUnit(line.unit)))", 'if (false)'],
    ['unit-id-conflict', 'src/netsuite.js',
      "assertSalesOrderUnitAgreement(String(row.unit_id ?? '').trim(), salesOrderRestUnitId(item.units));", '// unit ID comparison removed'],
    ['unit-label-conflict', 'src/netsuite.js', 'assertSalesOrderUnitAgreement(queryUnit, restUnit);', '// label comparison removed']
  );
}
for (const [name, file, before, after] of mutants) {
  const source = fs.readFileSync(file, 'utf8');
  assert.equal(source.split(before).length, 2, `Mutation anchor: ${name}`);
  fs.writeFileSync(`${mutation}/${file}`, source.replace(before, after));
  try {
    const selectedTests = name.startsWith('unit-') ? [unitEvidenceTest] : contractTests;
    const result = run(`mutant-${name}`, ['--test', ...selectedTests], { cwd: mutation, allowFailure: true });
    assert.ok(result.exit === 1 && result.failed > 0, `Surviving mutant: ${name}`);
    const property = run(`property-mutant-${name}`, ['--test', '--test-name-pattern=^property:', ...selectedTests],
      { cwd: mutation, allowFailure: true });
    report.mutations.push({ name, killed: true, propertyOnlyKilled: property.failed > 0 });
  } finally { fs.writeFileSync(`${mutation}/${file}`, source); }
}
for (const file of files) { assert.equal(digest(file), report.source[file]); }
report.skipped = ['Live NetSuite posting and activation: outside isolated tests; requires user readiness and separate operational validation.',
  'Whole unrelated application/browser/database suites: affected posting suites run against boundary fixtures.',
  'Dependency audit and license changes: no dependency changes; npm ci uses the repository lockfile.'];
fs.writeFileSync(`${output}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ source: report.source, tools: report.tools,
  tests: current.passed, types: report.types, lint: report.lint,
  changedCoverage: report.changedCoverage, mutations: report.mutations, skipped: report.skipped }, null, 2));
