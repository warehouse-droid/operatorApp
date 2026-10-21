import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ESLint } from 'eslint';
import pg from 'pg';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
const mode = process.argv[2], out = 'test-artifacts', layers = [];
const file = 'src/dispatch-repository.js';
const source = await readFile(file, 'utf8');
const sourceHash = createHash('sha256').update(source).digest('hex');
const focused = 'test/mbt/integration/scm-cancelled-split-schedule.test.js';
async function run(name, args, options = {}) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 40_000_000, timeout: 600000, ...options });
  const output = (result.stdout || '') + (result.stderr || '');
  await writeFile(`${out}/${name}.log`, output);
  const count = label => Number(output.match(new RegExp('^# ' + label + ' (\\d+)$', 'm'))?.[1] || 0);
  const record = { name, exitCode: result.status, tests: count('tests'), passed: count('pass'), failed: count('fail'),
    failures: [...output.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]) };
  layers.push(record); console.log(JSON.stringify(record));
  assert.equal(result.signal, null, name + ' timed out');
  return { record, output };
}

const feature = await run('focused', ['--test', '--test-concurrency=1', focused]);
assert.equal(feature.record.exitCode, mode.startsWith('red') ? 1 : 0);
if (mode === 'red-recheck') {
  assert.equal(feature.record.failed, 9, 'Only the nine reproduced visibility failures remain after fixture correction');
  await writeFile(`${out}/report.json`, JSON.stringify({ sourceHash, layers }, null, 2));
  process.exit(0);
}
// Cover both schedule consumers and the split lifecycle with the existing suites.
const regressions = [
  'test/mbt/integration/scm-po-split-ref-reuse.test.js',
  'test/mbt/integration/scm-authoritative-schedule-status.red.test.js',
  'test/mbt/integration/scm-schedule-status-refresh-repository.red.test.js',
  'test/mbt/integration/scm-schedule-status-http.test.js',
  'test/mbt/integration/scm-schedule-status-concurrency.test.js',
  'test/dispatch/integration/scm-po-split-schedule-remaining.test.js',
  'test/dispatch/integration/scm-po-split-corrected-receipt-visibility.test.js',
  'test/dispatch/integration/scm-po-split-editing.test.js',
  'test/dispatch/integration/scm-po-split-status-consistency.red.test.js',
  'test/dispatch/integration/scm-schedule-split-parity.test.js',
  'test/dispatch/integration/scm-schedule-loading-performance.red.test.js',
  'test/dispatch/integration/scm-direct-ship-schedule.test.js',
  'test/dispatch/integration/scm-to-untouched-lines.test.js',
  'test/dispatch/integration/scm-search-vendor-completion.test.js',
  'src/scm-order-visibility-integration-harness.js',
  'src/netsuite-closed-order-repository-harness.js'
];
const regression = await run('regressions', ['--test', '--test-concurrency=1', ...regressions]);
const types = await run('types', ['node_modules/typescript/bin/tsc', '--allowJs', '--checkJs', '--noEmit', '--skipLibCheck',
  '--module', 'nodenext', '--target', 'es2023', '--lib', 'es2023,dom,dom.iterable', file]);
const typeDiagnostics = [...types.output.matchAll(/^(.+?)\(\d+,\d+\): (error TS\d+: .+)$/gm)].map(match => match[1] + ': ' + match[2]);
const lint = new ESLint({ overrideConfigFile: 'tools/regular-stock-v2-eslint.config.mjs' });
const lintDiagnostics = (await lint.lintFiles([file])).flatMap(entry => entry.messages.map(({ ruleId, severity, message }) => ({ ruleId, severity, message })));
await writeFile(`${out}/lint.json`, JSON.stringify(lintDiagnostics, null, 2));
const added = (current, previous) => {
  const remaining = previous.map(x => JSON.stringify(x));
  return current.filter(x => { const i = remaining.indexOf(JSON.stringify(x)); if (i < 0) return true; remaining.splice(i, 1); return false; });
};
const mutants = [], uncoveredLines = [];
if (mode !== 'red') {
  const baseline = JSON.parse(await readFile('/red/report.json', 'utf8'));
  assert.deepEqual(added(regression.record.failures, baseline.regressionFailures), [], 'No new regression failures');
  assert.deepEqual(added(typeDiagnostics, baseline.typeDiagnostics), [], 'No new type errors');
  assert.deepEqual(added(lintDiagnostics, baseline.lintDiagnostics), [], 'No new lint errors');
  const covered = await run('coverage', ['node_modules/c8/bin/c8.js', '--all=false', '--include=' + file,
    '--check-coverage=false', '--reporter=json', '--report-dir=test-artifacts/coverage', '--temp-directory=/tmp/cancelled-split-c8',
    'node', '--test', '--test-concurrency=1', focused]);
  assert.equal(covered.record.exitCode, 0);
  const coverage = JSON.parse(await readFile(`${out}/coverage/coverage-final.json`, 'utf8'))['/app/' + file];
  const marker = '        AND NOT EXISTS (\n          SELECT 1\n            FROM dispatch_scm_po_splits cancelled_split\n           WHERE cancelled_split.split_po_id = po.netsuite_id\n             AND cancelled_split.status = \'cancelled\'\n        )';
  assert.equal(source.split(marker).length, 2, 'One scoped visibility predicate');
  const start = source.slice(0, source.indexOf(marker)).split('\n').length;
  for (let line = start; line < start + marker.split('\n').length; line++) {
    if (!Object.entries(coverage.statementMap).some(([key, range]) => coverage.s[key] > 0 && range.start.line <= line && range.end.line >= line)) uncoveredLines.push(line);
  }
  assert.deepEqual(uncoveredLines, []);
  const root = '/tmp/cancelled-split-mutants';
  await mkdir(root, { recursive: true });
  await cp('src', `${root}/src`, { recursive: true });
  await mkdir(`${root}/test/mbt/integration`, { recursive: true });
  await cp(focused, `${root}/${focused}`);
  for (const path of ['public', 'migrations', 'node_modules']) await symlink(`/app/${path}`, `${root}/${path}`);
  await cp('package.json', `${root}/package.json`);
  const changes = [
    ['missing-filter', source.replace(marker, '')],
    ['match-shared-reference', source.replace('cancelled_split.split_po_id = po.netsuite_id', "lower(cancelled_split.split_po_ref) = lower(COALESCE(NULLIF(po.dispatch_ref, ''), po.tranid))")],
    ['hide-active-splits', source.replace("AND cancelled_split.status = 'cancelled'", "AND cancelled_split.status IN ('cancelled', 'active')")],
    ['hide-ordinary-orders', source.replace(marker, marker + '\n        AND active_split.id IS NOT NULL')],
    ['destructive-history-cleanup', source.replace('  if (statusProjectionOnly) {\n    return result.rows',
      "  await query(\"UPDATE purchase_orders SET memo = 'incorrect cleanup' WHERE netsuite_id IN (SELECT split_po_id FROM dispatch_scm_po_splits WHERE status = 'cancelled')\");\n  if (statusProjectionOnly) {\n    return result.rows")]
  ];
  try {
    for (const [name, mutant] of changes) {
      assert.notEqual(mutant, source);
      await writeFile(`${root}/${file}`, mutant);
      const result = await run('mutation-' + name, ['--test', '--test-concurrency=1', focused], { cwd: root });
      const killed = result.record.exitCode === 1 && result.output.includes('AssertionError');
      mutants.push({ name, killed, failures: result.record.failures });
      assert.equal(killed, true, name + ' must fail a behavioral assertion');
    }
  } finally {
    await writeFile(`${root}/${file}`, source);
  }
  // Some older suites retain fixed fixture identities after a completed run.
  // Test another file order against a fresh disposable DB, not those leftovers.
  const databaseUrl = new URL(process.env.DATABASE_URL);
  assert.equal(databaseUrl.hostname, 'db');
  assert.equal(databaseUrl.pathname, '/mbt_test');
  const admin = new pg.Client({ connectionString: databaseUrl.href });
  await admin.connect();
  try {
    await admin.query('CREATE DATABASE mbt_test_reordered');
    databaseUrl.pathname = '/mbt_test_reordered';
    const env = { ...process.env, DATABASE_URL: databaseUrl.href };
    assert.equal((await run('reordered-migrate', ['src/migrate.js'], { env })).record.exitCode, 0);
    // Node sorts CLI test paths. Separate invocations make the seeded order real.
    const shuffled = [...regressions].sort((a, b) => createHash('sha256').update('1400761' + a).digest('hex')
      .localeCompare(createHash('sha256').update('1400761' + b).digest('hex')));
    await writeFile(`${out}/reordered-files.json`, JSON.stringify(shuffled, null, 2));
    for (let index = 0; index < shuffled.length; index++) {
      const result = await run('reordered-' + String(index + 1).padStart(2, '0'), ['--test', shuffled[index]], { env });
      assert.deepEqual(added(result.record.failures, baseline.regressionFailures), [], 'No order-dependent regressions: ' + shuffled[index]);
      assert.equal(result.record.exitCode, 0);
    }
  } finally {
    await admin.query('DROP DATABASE IF EXISTS mbt_test_reordered WITH (FORCE)');
    await admin.end();
  }
}
const report = { passed: mode !== 'red', sourceHash, layers, regressions, regressionFailures: regression.record.failures,
  typeDiagnostics, lintDiagnostics, mutants, uncoveredLines, property: { seed: 1400761, cases: 16 } };
await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
