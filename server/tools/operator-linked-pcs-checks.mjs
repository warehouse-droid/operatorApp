import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runNodeTestFilesIsolated } from '../test/support/test-database-isolation.mjs';

const sourceFile = 'src/operator-linked-quantity-domain.js';
const unit = 'test/mbt/unit/operator-linked-pcs-sales.test.js';
const property = 'test/mbt/property/operator-linked-pcs-sales.property.test.js';
const integration = 'test/mbt/integration/operator-linked-pcs-sales.test.js';
const focused = [unit, property, 'test/mbt/unit/operator-linked-fulfillment.red.test.js',
  'test/mbt/property/operator-linked-fulfillment.property.test.js', 'test/mbt/unit/operator-delivery-reference.test.js'];
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const regression = [...new Set([
  ...packageJson.scripts['test:operator-linked-fulfillment'].split(' ').filter(value => value.startsWith('test/')),
  unit, property, integration, 'test/mbt/unit/operator-delivery-reference.test.js',
  'test/mbt/integration/operator-delivery-reference.test.js', 'test/mbt/unit/operator-shared-pack-balance.test.js',
  'test/mbt/integration/operator-shared-pack-balance.test.js', 'test/mbt/integration/group-underpack.test.js',
  'test/mbt/unit/group-underpack-ui.test.js', 'test/mbt/unit/pickup-remaining-packs.test.js',
  'test/mbt/integration/pickup-remaining-packs.test.js', 'test/dispatch/unit/sales-pickup-authority.test.js',
  'test/dispatch/unit/co-supply-reference.test.js', 'test/dispatch/integration/co-direct-to.test.js'
])];
const artifact = path.resolve('test-artifacts/operator-linked-pcs-sales');
const hash = value => createHash('sha256').update(value).digest('hex');

function result(executable, args, options = {}) {
  const output = spawnSync(executable, args, { encoding: 'utf8', timeout: 600000,
    maxBuffer: 64 * 1024 * 1024, ...options });
  if (output.error) {throw output.error;}
  return { status: output.status, output: (output.stdout || '') + (output.stderr || '') };
}

function run(label, executable, args) {
  const output = result(executable, args);
  if (output.status !== 0) {
    console.log(output.output.slice(-24000));
    throw new Error(`${label} failed (${output.status})`);
  }
  console.log(`${label}: passed`);
  return output.output;
}

function testCounts(output, expectedFailures = 0) {
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key => [key,
    [...output.matchAll(new RegExp(`^(?:#|ℹ) ${key} (\\d+)`, 'gm'))].reduce((sum, match) => sum + Number(match[1]), 0)]));
  assert(counts.tests > 0, 'A passing run must report executed tests');
  assert.equal(counts.fail, expectedFailures);
  return counts;
}

const baselineFiles = ['test/dispatch/unit/co-supply-reference.test.js', 'test/dispatch/integration/co-direct-to.test.js'];
const knownFailures = [
  'generated reference projection conserves each unit and is immutable and idempotent',
  'mode changes and unlink restore the original independent CO requirement',
  'replenishment changes to direct pickup when the affected CO cargo is packed'
].sort();

function failureEvidence(output) {
  const blocks = [...output.matchAll(/^not ok \d+ - (.+)\n([\s\S]*?)^  \.\.\./gm)];
  return blocks.map(([, name, details]) => ({ name,
    diagnostics: details.split('\n').filter(line => /(?:code:|expected:|actual:|Counterexample:)/.test(line))
  })).sort((a, b) => a.name.localeCompare(b.name));
}

function verifyBaselineFailures() {
  const root = path.join(artifact, 'baseline');
  cpSync('/baseline-source/src', path.join(root, 'src'), { recursive: true });
  symlinkSync('/baseline-source/public', path.join(root, 'public'), 'dir');
  copyFileSync('/baseline-source/package.json', path.join(root, 'package.json'));
  for (const file of [...baselineFiles, 'test/support/co-direct-to-fixture.mjs']) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    copyFileSync(file, path.join(root, file));
  }
  const baseline = result(process.execPath, ['--test', '--test-concurrency=1', ...baselineFiles], { cwd: root });
  const candidate = result(process.execPath, ['--test', '--test-concurrency=1', ...baselineFiles]);
  const before = failureEvidence(baseline.output), after = failureEvidence(candidate.output);
  assert.equal(baseline.status, 1);
  assert.equal(candidate.status, 1);
  assert.deepEqual(before.map(row => row.name).sort(), knownFailures, baseline.output.slice(-18000));
  assert.deepEqual(after, before, 'Existing CO failure diagnostics must remain identical to live source');
  const counts = testCounts(candidate.output, knownFailures.length);
  assert.deepEqual(counts, testCounts(baseline.output, knownFailures.length));
  rmSync(root, { recursive: true });
  console.log('Existing CO failures: identical on live baseline and candidate');
  return { ...counts, failures: after, newFailures: 0 };
}

function changedLines(before, after) {
  const old = before.split('\n'), next = after.split('\n');
  const lengths = Array.from({ length: old.length + 1 }, () => new Uint16Array(next.length + 1));
  for (let i = old.length - 1; i >= 0; i--) {
    for (let j = next.length - 1; j >= 0; j--) {
      lengths[i][j] = old[i] === next[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const changed = [];
  let i = 0, j = 0;
  while (j < next.length) {
    if (i < old.length && old[i] === next[j]) {i++; j++;}
    else if (i < old.length && lengths[i + 1][j] >= lengths[i][j + 1]) {i++;}
    else {changed.push(++j);}
  }
  return changed;
}

function changedCoverage(source) {
  const baseline = readFileSync('/baseline-source/' + sourceFile, 'utf8');
  const coverage = JSON.parse(readFileSync(path.join(artifact, 'coverage/coverage-final.json'), 'utf8'));
  const data = coverage[path.resolve(sourceFile)];
  assert(data, 'Runtime coverage is required');
  const hits = {};
  for (const [key, statement] of Object.entries(data.statementMap)) {
    const line = statement.start.line;
    hits[line] = Math.max(hits[line] || 0, data.s[key]);
  }
  const lines = source.split('\n');
  const changed = changedLines(baseline, source).filter(line => line in hits
    && lines[line - 1].trim() && !/^\s*(\/\/|\/\*|\*)/.test(lines[line - 1]));
  assert(changed.length > 0);
  const missed = changed.filter(line => hits[line] === 0);
  assert.deepEqual(missed, [], 'Every changed executable line must be covered');
  return { covered: changed.length, total: changed.length, lines: changed };
}

function mutations(source) {
  const rows = [
    ['EACH identity omitted', '].includes(unit) ? 1 : 0;', '].includes(unit) ? 0 : 0;'],
    ['PCS conversion factor ignored', 'normalized.pieces * conversion', 'normalized.pieces'],
    ['PCS double counted with sales', 'Math.max(normalized.sales, pieceSales)', '(normalized.sales + pieceSales)'],
    ['PCS annotation used as the cap', '(unit !== "pieces" || conversion === 0)', 'true'],
    ['sales over-allocation ignored', '&& linkedTotal[unit] > original[unit] + EPSILON', '&& unit !== "sales" && linkedTotal[unit] > original[unit] + EPSILON'],
    ['unknown UOM assumed to be EACH', '].includes(unit) ? 1 : 0;', '].includes(unit) ? 1 : 1;']
  ];
  const reports = [];
  for (const [index, [name, from, to]] of rows.entries()) {
    assert.equal(source.split(from).length, 2, `Unique mutation target: ${name}`);
    const root = path.join(artifact, `mutant-${index}`);
    for (const file of [sourceFile, unit, property]) {mkdirSync(path.dirname(path.join(root, file)), { recursive: true });}
    writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
    writeFileSync(path.join(root, sourceFile), source.replace(from, to));
    for (const file of [unit, property]) {copyFileSync(file, path.join(root, file));}
    const full = result(process.execPath, ['--test', '--test-concurrency=1', unit, property], { cwd: root });
    assert.notEqual(full.status, 0, `Mutant survived: ${name}`);
    assert.match(full.output, /ERR_ASSERTION|Property failed/, `Behavioral failure required: ${name}`);
    const properties = result(process.execPath, ['--test', property], { cwd: root });
    if (properties.status !== 0) {assert.match(properties.output, /Property failed/);}
    reports.push({ name, killed: true, propertyKilled: properties.status !== 0 });
    rmSync(root, { recursive: true });
  }
  assert.equal(readFileSync(sourceFile, 'utf8'), source);
  return reports;
}

async function checks() {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  rmSync(artifact, { recursive: true, force: true });
  mkdirSync(artifact, { recursive: true });
  const source = readFileSync(sourceFile, 'utf8');
  const baseline = verifyBaselineFailures();
  const suiteRun = result(process.execPath, [process.argv[1], 'suite']);
  const failedNames = [...new Set([...suiteRun.output.matchAll(/^✖ (.+) \([\d.]+ms\)$/gm)].map(match => match[1]))].sort();
  assert.equal(suiteRun.status, 1);
  assert.deepEqual(failedNames, knownFailures, suiteRun.output.slice(-24000));
  const suite = testCounts(suiteRun.output, knownFailures.length);
  console.log('Affected suites in deterministic shuffled order: zero new failures');
  const coverage = testCounts(run('Quantity coverage', process.execPath, ['node_modules/c8/bin/c8.js', '--all=false',
    `--include=${sourceFile}`, `--temp-directory=${artifact}/c8`, `--report-dir=${artifact}/coverage`,
    '--reporter=json', '--reporter=json-summary', process.execPath, '--test', '--test-concurrency=1', ...focused]));
  const covered = changedCoverage(source);
  run('Types', process.execPath, ['node_modules/typescript/bin/tsc', '--allowJs', '--checkJs', '--noEmit',
    '--target', 'ES2022', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--skipLibCheck', sourceFile]);
  run('Lint', process.execPath, ['node_modules/eslint/bin/eslint.js', '--config', 'eslint.mbt.config.js',
    '--max-warnings=0', sourceFile, unit, property, integration, 'tools/operator-linked-pcs-checks.mjs']);
  run('Secrets', process.execPath, ['test/support/scan-diff-secrets.mjs', sourceFile, unit, property,
    integration, 'tools/operator-linked-pcs-checks.mjs', 'tools/operator-linked-pcs-live.mjs',
    'tools/operator-linked-pcs-release.py', 'test/operator-linked-pcs-sales-spec.md']);
  const mutants = mutations(source);
  const restored = testCounts(run('Post-mutation focused suite', process.execPath, ['--test', '--test-concurrency=1', ...focused]));
  const report = { passed: true, sourceHashes: { [sourceFile]: hash(source) }, suite, baseline, coverage,
    changedLineCoverage: covered, mutations: mutants, restored, shuffleSeed: 'linked-pcs-20261026',
    newProperties: { properties: 3, examples: 1300 },
    toolchain: Object.fromEntries(['typescript', 'eslint', 'c8', 'fast-check'].map(name =>
      [name, JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')).version])), node: process.version,
    specApproval: 'not obtained (autonomous run)',
    limitations: ['Repository-wide unrelated suites and external NetSuite posting were not run.',
      'Properties cover known conversions; unknown-UOM fallback is checked by the unit suite.'] };
  writeFileSync(path.join(artifact, 'result.json'), JSON.stringify(report));
  console.log('PCS_EVIDENCE=' + JSON.stringify(report));
}

if (process.argv[2] === 'suite') {
  const shuffled = [...regression].sort((a, b) => hash('linked-pcs-20261026:' + a).localeCompare(hash('linked-pcs-20261026:' + b)));
  process.exitCode = await runNodeTestFilesIsolated(shuffled, { environment: process.env, label: 'linked-pcs-sales' });
} else {
  await checks();
}
