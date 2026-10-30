import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parse } from 'espree';
import coverageLibrary from 'istanbul-lib-coverage';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
const root = process.cwd();
const output = path.resolve('test-artifacts/pallet-return-search');
fs.mkdirSync(output, { recursive: true });
const files = ['src/return-repository.js', 'public/operator.css', 'public/operator.html'];
const acceptance = 'test/mbt/integration/return-pallet-saved-search.test.js';
const browser = 'test/mbt/e2e/pallet-one-page.test.js';
const options = ['--test', '--test-force-exit', '--test-timeout=90000', '--test-concurrency=1'];
const hash = value => createHash('sha256').update(value).digest('hex');

function run(name, args, { cwd = root, allowFailure = false } = {}) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 300000, maxBuffer: 25e6 });
  const log = (result.stdout || '') + (result.stderr || '');
  fs.writeFileSync(path.join(output, name + '.log'), log);
  assert.ifError(result.error);
  const failures = [...log.matchAll(/^not ok \d+ - (.*)$/gm)].map(match => match[1]);
  if (!allowFailure) { assert.equal(result.status, 0, failures.join('\n') || log.slice(-7000)); }
  const passed = Number(log.match(/# pass (\d+)/)?.[1] || 0);
  console.log(`${name}: exit ${result.status}, ${passed} passed${failures.length ? ', failures: ' + failures.join('; ') : ''}`);
  return { status: result.status, log, failures, passed };
}

function snapshot(destination) {
  for (const folder of ['src', 'public', 'test']) { fs.cpSync(folder, path.join(destination, folder), { recursive: true }); }
  fs.copyFileSync('package.json', path.join(destination, 'package.json'));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(destination, 'node_modules'), 'dir');
}

const baseline = path.join(output, 'baseline');
snapshot(baseline);
for (const file of files) { fs.copyFileSync('/baseline-source/' + file, path.join(baseline, file)); }
const regressions = ['unit', 'integration'].flatMap(group => fs.readdirSync(`test/mbt/${group}`)
  .filter(file => /^return-.*\.test\.js$/.test(file)).map(file => `test/mbt/${group}/${file}`));
regressions.push('test/mbt/integration/stock-return-draft-insert.test.js');
regressions.sort((a, b) => hash(a).localeCompare(hash(b)));
const coverageArgs = ['node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false', '--include=src/return-netsuite.js',
  '--include=src/return-repository.js', `--temp-directory=${output}/v8`, `--report-dir=${output}/coverage`,
  '--reporter=json', process.execPath];

for (const file of files.filter(name => name.endsWith('.js'))) { run('syntax-' + path.basename(file), ['--check', file]); }
const eslint = ['node_modules/eslint/bin/eslint.js', '--config', 'tools/pallet-return-search-eslint.config.mjs', '--format=json'];
function findings(log) {
  return JSON.parse(log).flatMap(file => file.messages.map(message => JSON.stringify([path.basename(file.filePath),
    message.ruleId, message.message.replace(/on line \d+ column \d+/g, 'on line <position>'),
    fs.readFileSync(file.filePath, 'utf8').split('\n')[message.line - 1]?.trim()]))).sort();
}
const sourceFiles = files.filter(file => file.endsWith('.js'));
const oldLint = findings(run('baseline-lint', [...eslint, ...sourceFiles.map(file => path.join(baseline, file))], { allowFailure: true }).log);
const newLint = findings(run('final-lint', [...eslint, ...sourceFiles], { allowFailure: true }).log);
assert.deepEqual(newLint.filter(finding => !oldLint.includes(finding)), [], 'No new lint findings');
run('test-lint', [...eslint, '--max-warnings=0', acceptance, browser, 'tools/pallet-return-search-checks.mjs']);

const names = ['customerPalletAuthorizationIds', 'customerPalletRemoteReads', 'customerPalletBalance', 'logReturnOrderLookup'];
function typeSource(file) {
  const source = fs.readFileSync(file, 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', range: true, comment: true });
  const declarations = ast.body.map(node => node.type === 'ExportNamedDeclaration' ? node.declaration : node)
    .filter(node => node?.type === 'FunctionDeclaration' && names.includes(node.id.name));
  const boundaries = ['query', 'customerHasLocalPalletReturns', 'resolvePalletItemFromNetSuite',
    'fetchPalletBalanceFromNetSuite', 'fetchPalletReturnCreditsFromNetSuite', 'reconcileMissingPalletCreditMemos',
    'localPalletReserved', 'returnBalance', 'palletBalanceSource'];
  return boundaries.map(name => `/** @type {any} */ let ${name};`).join('\n') + '\n'
    + declarations.map(node => {
      const comment = ast.comments.findLast(item => item.range[1] <= node.range[0]);
      const start = comment && !source.slice(comment.range[1], node.range[0]).trim() ? comment.range[0] : node.range[0];
      return source.slice(start, node.range[1]);
    }).join('\n');
}
for (const [name, file] of [['baseline', path.join(baseline, 'src/return-repository.js')], ['final', 'src/return-repository.js']]) {
  const target = path.join(output, name + '-types.mjs');
  fs.writeFileSync(target, typeSource(file));
  run(name + '-types', ['node_modules/typescript/bin/tsc', '--allowJs', '--checkJs', '--noEmit', '--strict',
    '--noImplicitAny', 'false', '--skipLibCheck', '--target', 'es2023', '--module', 'nodenext', target]);
}

if (process.argv.includes('--static-only')) { process.exit(0); }
const before = run('baseline-returns', [...options, ...regressions], { cwd: baseline, allowFailure: true });
const expectedRed = ['P1 linked credits start while the fresh report is pending, preserving the final reservation',
  'O2 successful SO searches record reference, mode and elapsed time only'];
assert.deepEqual([...before.failures].sort(), [...expectedRed].sort(), 'Only the intended new regressions fail on the baseline');
const final = run('final-returns', [...coverageArgs, ...options, ...regressions, browser]);

const coverage = coverageLibrary.createCoverageMap(JSON.parse(fs.readFileSync(path.join(output, 'coverage/coverage-final.json'))));
const changedCoverage = {};
for (const file of sourceFiles) {
  const diff = spawnSync('diff', ['-U0', '/baseline-source/' + file, file], { encoding: 'utf8' });
  assert.ok([0, 1].includes(diff.status));
  const lines = [];
  for (const match of diff.stdout.matchAll(/^@@ -[\d,]+ \+(\d+)(?:,(\d+))? @@/gm)) {
    for (let i = 0; i < Number(match[2] ?? 1); i++) { lines.push(Number(match[1]) + i); }
  }
  const counts = coverage.fileCoverageFor(path.join(root, file)).getLineCoverage();
  changedCoverage[file] = { measured: lines.filter(line => counts[line] !== undefined).length,
    uncovered: lines.filter(line => counts[line] === 0) };
  assert.deepEqual(changedCoverage[file].uncovered, [], 'Uncovered changed lines in ' + file);
}

const mutations = [
  ['sequential-credits', 'src/return-repository.js', '    remoteBalance || fetchPalletBalanceFromNetSuite(customerId, { force, includeCreditIdentity }),', '    remoteBalance || await fetchPalletBalanceFromNetSuite(customerId, { force, includeCreditIdentity }),', acceptance, 'P1 linked'],
  ['drop-linked-credits', 'src/return-repository.js', '    fetchPalletReturnCreditsFromNetSuite(authorizationIds, pallet?.id || pallet?.itemId)', '    Promise.resolve([])', acceptance, 'P3 generated'],
  ['stale-balance', 'src/return-repository.js', '{ force, includeCreditIdentity }),', '{ force: false, includeCreditIdentity }),', acceptance, 'P3 generated'],
  ['hide-link-errors', 'src/return-repository.js', '    fetchPalletReturnCreditsFromNetSuite(authorizationIds, pallet?.id || pallet?.itemId)', '    fetchPalletReturnCreditsFromNetSuite(authorizationIds, pallet?.id || pallet?.itemId).catch(() => [])', acceptance, 'P4 linked'],
  ['stretched-result', 'public/operator.css', '  align-content: start;\n  grid-auto-rows: max-content;\n  gap: 7px;', '  gap: 7px;', browser, 'customer matches.*1024']
];
const mutant = path.join(output, 'mutant');
snapshot(mutant);
try {
  for (const [name, file, original, replacement, suite, pattern] of mutations) {
    const target = path.join(mutant, file), source = fs.readFileSync(target, 'utf8');
    assert.equal(source.split(original).length, 2, name);
    try {
      fs.writeFileSync(target, source.replace(original, replacement));
      const result = run('mutant-' + name, [...options, '--test-name-pattern=' + pattern, suite], { cwd: mutant, allowFailure: true });
      assert.notEqual(result.status, 0, name + ' survived');
      assert.ok(result.failures.length, name + ' must fail a behavioral assertion');
    } finally { fs.writeFileSync(target, source); }
  }
} finally { fs.rmSync(mutant, { recursive: true, force: true }); }
run('secrets', ['test/support/scan-diff-secrets.mjs', ...files, acceptance, browser,
  'tools/pallet-return-search-checks.mjs', 'tools/pallet-return-search-release.py']);
const report = { passed: true, specApproval: 'not obtained (autonomous run)',
  baselineTestsPassed: before.passed, finalTestsPassed: final.passed, redTests: before.failures, baselineFailures: [],
  newFailures: [], mutantsKilled: mutations.length, changedCoverage, lint: { baseline: oldLint.length, final: newLint.length, new: 0 },
  versions: { node: process.version },
  sourceHashes: Object.fromEntries(files.map(file => [file, hash(fs.readFileSync(file))])) };
fs.writeFileSync('test-artifacts/pallet-return-search-validation.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
