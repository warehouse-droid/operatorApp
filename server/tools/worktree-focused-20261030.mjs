import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';
import {buildIsolatedTestEnvironment} from '../test/support/test-foundation.mjs';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
const out = '/app/test-artifacts';
const pack = 'test/mbt/unit/sales-order-null-packs.test.js';
const pdf = 'test/mbt/unit/delivery-estb-pdf.test.js';
const sources = ['public/special-stock-line-details.js', 'public/special-stock-line-fields.js',
  'src/special-stock-request-domain.js', 'src/special-stock-request-netsuite.js',
  'src/special-stock-adjustment-adapter.js', 'src/special-stock-rest-orders.js',
  'src/netsuite-order-pdf.js', 'src/netsuite.js',
  'netsuite-field-sales-restlet.js', 'netsuite-smart-scm-picking-ticket-restlet.js'];
const suites = [pack, pdf, 'test/mbt/unit/sales-order-pack-transport.test.js',
  'test/mbt/infrastructure/test-foundation.test.js', 'test/mbt/unit/special-discount-summary.test.js',
  'src/scm-schedule-column-filter-harness.js', 'test/dispatch/frontend/scm-schedule-multi-sort.test.js',
  ...['special-workflow-native-documents', 'special-workflow-rest-orders', 'special-workflow-adjustment-restlet',
    'special-native-po-restlet', 'special-case-fields', 'special-case-fields-orders',
    'special-stock-request-domain.red', 'special-stock-request-netsuite.red', 'special-workflow-quantity-adapter']
    .map(name => `test/mbt/unit/${name}.test.js`),
  'test/field-sales/order-restlet.test.js', 'test/field-sales/existing-customer-restlet.test.js',
  'test/workload/unit/netsuite-order-webhook-worker.red.test.js',
  'test/workload/unit/netsuite-order-webhook-queue-policy.red.test.js'];
const report = {passed: false, stages: [], mutations: [], sourceHashes: Object.fromEntries(sources.map(file =>
  [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]))};
const failureNames = text => [...text.matchAll(/^not ok \d+ - (.+)$/gm)].map(m => m[1]).sort();
const counts = text => Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key =>
  [key, Number(text.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] || 0)]));

function run(name, args, {cwd = '/app', allowFailure = false} = {}) {
  const result = spawnSync(process.execPath, args, {cwd, encoding: 'utf8', timeout: 300000, maxBuffer: 24 * 1024 * 1024});
  fs.writeFileSync(`${out}/${name}.log`, (result.stdout || '') + (result.stderr || ''));
  report.stages.push({name, exitCode: result.status});
  if (result.status !== 0 && !allowFailure) {
    process.stdout.write(((result.stdout || '') + (result.stderr || '')).slice(-8000));
    throw new Error(`${name} failed: ${result.status}`);
  }
  return result;
}

try {
  for (const file of [...sources, 'test/support/test-foundation.mjs', 'test/support/run-baseline-harnesses.mjs'])
    run('syntax-' + path.basename(file), ['--check', file]);
  run('packing-lint', ['node_modules/eslint/bin/eslint.js', '--config',
    'tools/sales-order-null-packs-20261016/eslint.config.mjs', '--max-warnings=0', ...sources.filter(f => f !== 'src/netsuite-order-pdf.js')]);
  run('pdf-lint', ['node_modules/eslint/bin/eslint.js', '--config', 'tools/delivery-estb-quote-eslint.config.mjs',
    '--max-warnings=0', 'src/netsuite-order-pdf.js']);
  run('focused-types', ['node_modules/typescript/bin/tsc', '--allowJs', '--checkJs', '--noEmit', '--target', 'ES2022',
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--skipLibCheck', '--types', 'node',
    'public/order-pack-quantities.js', 'public/special-stock-line-details.js', 'public/special-stock-line-fields.js',
    'src/special-stock-adjustment-adapter.js', 'src/netsuite-order-pdf.js']);
  const current = run('focused-coverage', ['node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false',
    ...sources.map(file => '--include=' + file), `--temp-directory=${out}/c8`, `--report-dir=${out}/coverage`,
    '--reporter=json', '--reporter=json-summary', 'node', '--test', '--test-concurrency=1', ...suites], {allowFailure: true});
  report.tests = counts(current.stdout);
  report.failures = failureNames(current.stdout);
  const broad = JSON.parse(fs.readFileSync('test/whole-worktree-deployment-20261030-checks.json', 'utf8'));
  const previousFailures = new Set((broad.baseline?.failedFiles || []).flatMap(row => row.failures));
  assert.ok(report.failures.every(name => previousFailures.has(name)), 'Focused suite has new failures');
  assert.ok(report.tests.tests > 50 && (current.status === 0 || report.failures.length), 'Focused run did not complete');
  const reversed = run('reversed-focused', ['--test', '--test-concurrency=1', ...[...suites].reverse()], {allowFailure: true});
  assert.deepEqual(failureNames(reversed.stdout), report.failures);
  assert.deepEqual(counts(reversed.stdout), report.tests);

  const integration = ['test/workload/integration/netsuite-order-webhook-queue.red.test.js',
    'test/workload/integration/load-followup-webhook.test.js',
    'test/mbt/integration/backorder-po-routing.test.js',
    'test/mbt/integration/sales-order-null-packs.test.js',
    'test/mbt/integration/sales-order-null-packs.browser.test.js'].map(f => '/app/' + f);
  report.integrationExitCode = await runNodeTestFilesIsolated(integration, {
    environment: buildIsolatedTestEnvironment(process.env, {databaseUrl: process.env.DATABASE_URL}),
    label: 'Release packing and webhook integration'});
  assert.equal(report.integrationExitCode, 0);

  const scratch = `${out}/mutants`;
  fs.mkdirSync(scratch);
  try {
    for (const name of ['src', 'public', 'test', 'package.json', 'netsuite-field-sales-restlet.js',
      'netsuite-smart-scm-picking-ticket-restlet.js', 'netsuite-transaction-pdf-suitelet.js'])
      fs.cpSync(name, `${scratch}/${name}`, {recursive: true});
    fs.symlinkSync('/app/node_modules', `${scratch}/node_modules`);
    const retrySource = `${scratch}/public/backorder-po-routing.js`;
    const retryOriginal = fs.readFileSync(retrySource, 'utf8');
    const retryAnchor = 'if(d)void load(d,true);';
    assert.equal(retryOriginal.split(retryAnchor).length, 2);
    try {
      fs.writeFileSync(retrySource, retryOriginal.replace(retryAnchor, 'if(d)void Promise.resolve();'));
      const retrySuite = `${scratch}/test/mbt/integration/backorder-po-routing.test.js`;
      const isolated = "import {runNodeTestFilesIsolated} from './test/support/test-database-isolation.mjs';import {buildIsolatedTestEnvironment} from './test/support/test-foundation.mjs';process.exitCode=await runNodeTestFilesIsolated([process.argv[1]],{environment:buildIsolatedTestEnvironment(process.env,{databaseUrl:process.env.DATABASE_URL}),label:'Retry mutation'});";
      const mutant = run('retry-click-mutant', ['--input-type=module', '-e', isolated, retrySuite], {cwd: scratch, allowFailure: true});
      assert.ok(mutant.status === 1 && mutant.stdout.includes('✖ Backorder routing retries failures and ignores late responses after switching requests'));
      report.mutations.push({name: 'retry handler does not reload', killed: true,
        newFailures: ['Backorder routing retries failures and ignores late responses after switching requests'], propertyKilled: null});
    } finally {fs.writeFileSync(retrySource, retryOriginal);}
    const mutations = [
      ['blank becomes zero', 'public/order-pack-quantities.js',
        "if (value == null || (typeof value === 'string' && value.trim() === '')) return null;",
        "if (value == null || (typeof value === 'string' && value.trim() === '')) return 0;", pack, true],
      ['zero remains zero', 'public/order-pack-quantities.js',
        'return Number(value) === 0 ? null : Number(value);', 'return Number(value);', pack, true],
      ['positive fraction truncated', 'public/order-pack-quantities.js',
        'return Number(value) === 0 ? null : Number(value);', 'return Number(value) === 0 ? null : Math.trunc(Number(value));', pack, true],
      ['request blanks default to zero', 'src/special-stock-request-domain.js',
        '...normalizePackQuantities(line),',
        '...Object.fromEntries(Object.entries(normalizePackQuantities(line)).map(([field,value])=>[field,value ?? 0])),', pack, false],
      ['wrong estimate PDF action', 'src/netsuite-order-pdf.js',
        "estimate: 'estimatePdf'", "estimate: 'salesOrderPdf'", pdf, true],
      ['wrong PDF identity accepted', 'src/netsuite-order-pdf.js',
        ' || Number(payload.entityId) !== id', '', pdf, false]
    ];
    for (const suite of [pack, pdf]) {
      const base = run('mutation-baseline-' + path.basename(suite), ['--test', suite], {cwd: scratch, allowFailure: true});
      const names = failureNames(base.stdout);
      assert.ok(names.every(name => previousFailures.has(name)));
      for (const [index, [name, file, from, to, selected, property]] of mutations.entries()) {
        if (selected !== suite) continue;
        const target = `${scratch}/${file}`, original = fs.readFileSync(target, 'utf8');
        assert.equal(original.split(from).length, 2, 'Mutation anchor: ' + name);
        try {
          fs.writeFileSync(target, original.replace(from, to));
          const mutant = run('mutant-' + index, ['--test', selected], {cwd: scratch, allowFailure: true});
          const newFailures = failureNames(mutant.stdout).filter(item => !names.includes(item));
          assert.ok(mutant.status === 1 && newFailures.length > 0 && /ERR_ASSERTION|Property failed/.test(mutant.stdout), name);
          let propertyKilled = null;
          if (property) {
            const result = run('property-mutant-' + index, ['--test', '--test-name-pattern=^property:', selected], {cwd: scratch, allowFailure: true});
            propertyKilled = result.status === 1 && /Property failed/.test(result.stdout);
            assert.ok(propertyKilled, name);
          }
          report.mutations.push({name, killed: true, newFailures, propertyKilled});
        } finally {fs.writeFileSync(target, original);}
      }
    }
  } finally {fs.rmSync(scratch, {recursive: true, force: true});}
  report.coverage = JSON.parse(fs.readFileSync(`${out}/coverage/coverage-summary.json`, 'utf8'));
  report.versions = {node: process.version, ...Object.fromEntries(['c8', 'typescript', 'eslint', 'fast-check'].map(name =>
    [name, JSON.parse(fs.readFileSync(`/app/node_modules/${name}/package.json`, 'utf8')).version]))};
  report.passed = true;
} finally {
  fs.writeFileSync(`${out}/focused-report.json`, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({passed: report.passed, tests: report.tests, existingFailures: report.failures,
  mutantsKilled: report.mutations.length, propertyMutantsKilled: report.mutations.filter(row => row.propertyKilled).length}));
