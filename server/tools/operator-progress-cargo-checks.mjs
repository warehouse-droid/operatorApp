import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { describeIsolatedTestDatabase } from '../test/support/test-database-isolation.mjs';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
const root = '/app/test-artifacts/operator-progress-cargo';
await mkdir(root, { recursive: true });
const sourceFile = 'src/operator-order-progress-repository.js';
const unit = 'test/dispatch/unit/operator-progress-cargo.test.js';
const integration = 'test/dispatch/integration/operator-progress-cargo.test.js';
const tests = [unit, integration,
  'test/dispatch/integration/split-dialog-fast.test.js',
  'test/dispatch/integration/operator-attribution-ownership.test.js',
  'test/dispatch/integration/control-order-reopen.test.js',
  'test/dispatch/integration/control-order-reopen-local.test.js',
  'test/dispatch/integration/sales-split-allocation-unsplit.test.js',
  'test/dispatch/integration/resplit-sibling-group-allocations.test.js'];
function failures(output) {
  return [...output.matchAll(/^not ok \d+ - (.+)$/gmu)].map(match => match[1]).sort();
}
function run(label, command, args, extra = {}, expectedFailures = []) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 240000,
    env: { ...process.env, ...extra }, maxBuffer: 16 * 1024 * 1024 });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const actualFailures = failures(output);
  const expectedStatus = expectedFailures.length ? 1 : 0;
  if (result.status !== expectedStatus || JSON.stringify(actualFailures) !== JSON.stringify(expectedFailures)) { console.error(output); }
  assert.equal(result.status, expectedStatus, `${label}: ${result.error || result.signal || result.status}`);
  assert.deepEqual(actualFailures, expectedFailures, `${label}: changed failures`);
  console.log(`${label}: ${expectedFailures.length ? `${expectedFailures.length} confirmed baseline failures, zero new failures` : 'passed'}`);
  return output;
}
async function resetDisposableDatabase() {
  const boundary = describeIsolatedTestDatabase(process.env.DATABASE_URL);
  const client = new pg.Client({ connectionString: boundary.adminUrl });
  try {
    await client.connect();
    await client.query('DROP DATABASE mbt_test WITH (FORCE)');
    await client.query('CREATE DATABASE mbt_test');
  } finally {
    await client.end();
  }
  run('fresh disposable database', 'node', ['src/migrate.js']);
}
run('types', 'node', ['node_modules/typescript/bin/tsc', '--noEmit', '--allowJs', '--skipLibCheck',
  '--module', 'nodenext', '--target', 'es2022', sourceFile]);
run('lint', 'node', ['node_modules/eslint/bin/eslint.js', '--config', 'tools/operator-progress-cargo-eslint.config.mjs',
  '--max-warnings=0', sourceFile, unit, integration, 'test/support/operator-progress-cargo-mutation-loader.mjs',
  'test/support/operator-progress-cargo-baseline-loader.mjs',
  'tools/operator-progress-cargo-checks.mjs', 'tools/operator-progress-cargo-eslint.config.mjs']);
const knownFailures = [
  'legacy loaded quantities with no load audit identify the order without inventing an operator',
  'a loaded source CO identifies its own ref and operator instead of the source SO packer',
  'stale Open header with loaded lines becomes linkable after reopening'
].sort();
run('unchanged captured-live baseline', 'node', ['--loader', './test/support/operator-progress-cargo-baseline-loader.mjs',
  '--test', '--test-concurrency=1', ...tests.slice(2)], {}, knownFailures);
await resetDisposableDatabase();
// The MBT-wide c8 defaults target a different source set. Enforce 100% of this
// change's status-classification region below, including every branch.
const output = run('regression suite with coverage', 'node', ['node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false',
  `--include=${sourceFile}`, `--temp-directory=${root}/v8`, `--report-dir=${root}/coverage`, '--reporter=json',
  'node', '--test', '--test-concurrency=1', ...tests], {}, knownFailures);
const counts = Object.fromEntries([...output.matchAll(/^# (tests|pass|fail|skipped) (\d+)$/gmu)].map(match => [match[1], Number(match[2])]));
assert.ok(counts.tests > 30);
assert.equal(counts.fail, knownFailures.length);
assert.equal(counts.skipped, 0);
const coverage = Object.values(JSON.parse(await readFile(`${root}/coverage/coverage-final.json`, 'utf8')))[0];
const source = await readFile(sourceFile, 'utf8');
const changedRegionEnd = source.split('\n').findIndex(line => line.startsWith('export async function readOperatorProgressActor'));
const statusStatements = Object.entries(coverage.statementMap).filter(([, location]) => location.start.line < changedRegionEnd);
assert.ok(statusStatements.length > 0);
assert.ok(statusStatements.every(([id]) => coverage.s[id] > 0), 'Uncovered progress statement');
const statusBranches = Object.entries(coverage.branchMap).filter(([, location]) => location.loc.start.line < changedRegionEnd);
assert.ok(statusBranches.every(([id]) => coverage.b[id].every(count => count > 0)),
  'Uncovered progress branch: ' + JSON.stringify(statusBranches.filter(([id]) => coverage.b[id].some(count => count === 0))));
const mutants = ['accounting-load', 'accounting-pack', 'lost-cargo-load', 'lost-cargo-pack', 'lost-header-load', 'named-service'];
for (const mutant of mutants) {
  const result = spawnSync('node', ['--loader', './test/support/operator-progress-cargo-mutation-loader.mjs',
    '--test', unit], { encoding: 'utf8', timeout: 30000, env: { ...process.env, CARGO_MUTANT: mutant } });
  const out = `${result.stdout || ''}${result.stderr || ''}`;
  assert.equal(result.status, 1, `Mutant survived: ${mutant}`);
  assert.match(out, /ERR_ASSERTION|AssertionError/u, `Mutant failed without a behavioral assertion: ${mutant}`);
  assert.doesNotMatch(out, /Mutation target missing/u);
  console.log(`mutation ${mutant}: killed`);
}
// Independent file ordering checks fixture isolation; fixed seeds make the properties reproducible.
await resetDisposableDatabase();
for (const file of tests.toReversed()) {
  const expected = file.endsWith('/control-order-reopen-local.test.js') ? knownFailures.filter(name => !name.startsWith('stale Open'))
    : file.endsWith('/control-order-reopen.test.js') ? knownFailures.filter(name => name.startsWith('stale Open')) : [];
  run(`reordered regression: ${file}`, 'node', ['--test', file], {}, expected);
}
const report = { passed: true, newFailures: 0, at: new Date().toISOString(), node: process.version,
  sourceHashes: { [sourceFile]: createHash('sha256').update(source).digest('hex') }, tests: counts, baselineFailures: knownFailures,
  properties: { seed: 20261022, runs: 250 }, types: 'passed', lint: 'passed',
  coverage: { progressStatementsCovered: statusStatements.length, progressStatementsTotal: statusStatements.length,
    progressBranchesCovered: statusBranches.reduce((sum, [id]) => sum + coverage.b[id].length, 0) },
  mutations: { killed: mutants.length, total: mutants.length, names: mutants }, reorderedSuite: 'passed',
  limits: ['Scoped regression suite; repository-wide unrelated suites were not run.',
    'No browser code changed; existing split-preview HTTP checks cover the server boundary.',
    'No dependency, database schema, write path, or capability changes; supply-chain audit and migration rehearsal not applicable.'],
  specApproval: 'not obtained (autonomous run)' };
await writeFile('/app/test-artifacts/operator-progress-cargo-evidence.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
