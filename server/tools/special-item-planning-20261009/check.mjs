import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, cpSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.equal(new URL(process.env.DATABASE_URL).hostname, 'mbbs-special-review-db');
assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED, 'false');
const mode = process.argv.at(-1);
const task = 'tools/special-item-planning-20261009';
const out = 'test-artifacts/special-item-planning-20261009';
const runtime = 'src/dispatch-plan-repository.js';
const unit = 'test/dispatch/unit/special-po-independent-planning.test.js';
const http = 'test/dispatch/integration/special-item-planning-save.test.js';
const oldGuard = 'test/mbt/integration/special-stock-request-dispatch-guard.red.test.js';
const regressions = [
  oldGuard,
  'test/mbt/integration/special-approval-fulfillment.test.js',
  'test/mbt/integration/special-approval-http.test.js',
  'test/mbt/integration/special-workflow-closure.test.js',
  'test/mbt/integration/special-workflow-pricing-http.test.js',
  'test/mbt/integration/special-stock-updates.test.js',
  'test/dispatch/integration/dispatch-save-recovery.red.test.js',
  'test/dispatch/integration/dispatch-planner-compact-command.red.test.js',
  'test/dispatch/frontend/dispatch-save-reliability.test.js'
];
mkdirSync(out, { recursive: true });

function command(label, args, cwd = process.cwd(), environment = process.env) {
  const logPath = resolve(`${out}/${label}.log`);
  const fd = openSync(logPath, 'w');
  let result;
  try { result = spawnSync(process.execPath, args, { cwd, env: environment, timeout: 900_000, stdio: ['ignore', fd, fd] }); }
  finally { closeSync(fd); }
  const log = readFileSync(logPath, 'utf8');
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key => [key, Number(log.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] || 0)]));
  const failures = [...log.matchAll(/^not ok \d+ - (.+?)(?: # SKIP.*?)?$/gm)].filter(match => !match[0].includes(' # SKIP')).map(match => match[1]);
  const data = { label, exit: result.status, ...counts, failures };
  writeFileSync(`${out}/${label}.json`, JSON.stringify(data, null, 2) + '\n');
  console.log(JSON.stringify(data));
  return { ...data, log };
}

function run(label, files, cwd = process.cwd(), pattern) {
  let environment = label === 'shuffled-http' ? { ...process.env, SPECIAL_PLANNING_SHUFFLE_SEED: '20261009' } : process.env;
  if (files.some(file => file.endsWith('/special-workflow-pricing-http.test.js'))) {
    const name = 'mbt_test_file_202610090000_specialplanning';
    const created = command(label + '-database-contract', ['--input-type=module', '-e',
      "import pg from 'pg';const url=new URL(process.env.DATABASE_URL);if(url.hostname!=='mbbs-special-review-db'||url.pathname!=='/mbt_verify')throw Error('Not isolated');url.pathname='/mbt_test';const client=new pg.Client({connectionString:url.href});try{await client.connect();await client.query('DROP DATABASE IF EXISTS mbt_test_file_202610090000_specialplanning WITH (FORCE)');await client.query('CREATE DATABASE mbt_test_file_202610090000_specialplanning TEMPLATE mbt_verify');}finally{await client.end();}"]);
    assert.equal(created.exit, 0, created.log.slice(-2000));
    const url = new URL(process.env.DATABASE_URL);
    url.hostname = 'db'; url.pathname = '/' + name;
    environment = { ...process.env, DATABASE_URL: url.href };
  }
  return command(label, ['--test', '--test-concurrency=1', ...(pattern ? ['--test-name-pattern=' + pattern] : []), ...files], cwd, environment);
}

function snapshot() {
  const root = mkdtempSync('/tmp/special-planning-');
  cpSync('src', `${root}/src`, { recursive: true });
  for (const folder of ['node_modules', 'public', 'migrations', 'tools', 'test-artifacts']) {
    symlinkSync(resolve(folder), `${root}/${folder}`);
  }
  cpSync('package.json', `${root}/package.json`);
  cpSync('netsuite-smart-scm-picking-ticket-restlet.js', `${root}/netsuite-smart-scm-picking-ticket-restlet.js`);
  cpSync('test/dispatch/support', `${root}/test/dispatch/support`, { recursive: true });
  mkdirSync(`${root}/test/field-sales`, { recursive: true });
  cpSync('test/field-sales/pdf-text.js', `${root}/test/field-sales/pdf-text.js`);
  for (const file of [unit, http, ...regressions]) {
    mkdirSync(dirname(`${root}/${file}`), { recursive: true });
    cpSync(file, `${root}/${file}`);
  }
  return root;
}

function resetDatabase(label) {
  const reset = command(label + '-reset', ['--input-type=module', '-e',
    "import pg from 'pg';const url=new URL(process.env.DATABASE_URL);if(url.hostname!=='mbbs-special-review-db'||url.pathname!=='/mbt_verify')throw Error('Not isolated');url.pathname='/mbt_test';const client=new pg.Client({connectionString:url.href});try{await client.connect();await client.query('DROP DATABASE mbt_verify WITH (FORCE)');await client.query('CREATE DATABASE mbt_verify');}finally{await client.end();}"]);
  assert.equal(reset.exit, 0, reset.log.slice(-2000));
  const migration = command(label + '-migrate', ['src/migrate.js']);
  assert.equal(migration.exit, 0, migration.log.slice(-2000));
}

function baseline() {
  const root = snapshot();
  const results = [];
  try {
    for (const file of [runtime, unit, oldGuard]) { cpSync(`${task}/baseline/${file}`, `${root}/${file}`); }
    results.push(run('baseline-unit', [unit], root));
    resetDatabase('baseline-guard');
    results.push(run('baseline-guard', [oldGuard], root));
    for (const file of regressions.slice(1)) {
      const label = 'baseline-' + file.split('/').at(-1).replace('.test.js', '');
      resetDatabase(label);
      results.push(run(label, [file], root));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
  writeFileSync(`${out}/baseline-results.json`, JSON.stringify(results.map(({ log: _log, ...row }) => row), null, 2) + '\n');
}

async function staticChecks() {
  const root = snapshot();
  try {
    cpSync(`${task}/baseline/${runtime}`, `${root}/${runtime}`);
    const args = ['/app/node_modules/typescript/bin/tsc', '--noEmit', '--allowJs', '--checkJs', '--skipLibCheck', '--types', 'node', '--target', 'ES2022', '--module', 'NodeNext', runtime];
    const before = command('types-before', args, root), after = command('types-after', args);
    const messages = log => log.split('\n').filter(line => /error TS\d+/.test(line)).map(line => line.replace(/\(\d+,\d+\)/, ''));
    const previous = messages(before.log);
    const added = messages(after.log).filter(line => { const index = previous.indexOf(line); if (index < 0) { return true; } previous.splice(index, 1); return false; });
    const { ESLint } = await import('eslint');
    const lint = new ESLint({ overrideConfigFile: resolve('tools/stock-request-layout-eslint.config.mjs') });
    const oldMessages = (await lint.lintText(readFileSync(`${root}/${runtime}`, 'utf8'), { filePath: runtime }))[0].messages.map(message => JSON.stringify([message.ruleId, message.severity, message.message]));
    const currentMessages = (await lint.lintText(readFileSync(runtime, 'utf8'), { filePath: runtime }))[0].messages.map(message => JSON.stringify([message.ruleId, message.severity, message.message]));
    const newLint = currentMessages.filter(message => { const index = oldMessages.indexOf(message); if (index < 0) { return true; } oldMessages.splice(index, 1); return false; });
    const testLint = new ESLint({ overrideConfigFile: resolve('eslint.mbt.config.js') });
    const testMessages = (await testLint.lintFiles([unit, http])).flatMap(result => result.messages);
    for (const file of [runtime, unit, http, oldGuard, `${task}/check.mjs`, `${task}/live.mjs`]) {
      const result = command('syntax-' + file.split('/').at(-1), ['--check', file]);
      assert.equal(result.exit, 0);
    }
    const staticResult = { baselineTypeErrors: messages(before.log).length, currentTypeErrors: messages(after.log).length,
      newTypeErrors: added, newRuntimeLint: newLint, testLint: testMessages };
    writeFileSync(`${out}/static.json`, JSON.stringify(staticResult, null, 2) + '\n');
    assert.deepEqual(added, []); assert.deepEqual(newLint, []); assert.deepEqual(testMessages, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function mutations() {
  const source = readFileSync(runtime, 'utf8');
  const mutants = [
    { name: 'vendor-pickup-block', field: 'special.fulfillment_method', condition: "row.fulfillment_method === 'vendor_pickup'", pattern: '^Save Now applies vendor_pickup with in_stock' },
    { name: 'readiness-block', field: "EXISTS(SELECT 1 FROM sales_special_stock_lines line WHERE line.request_id=special.request_id AND line.sales_decision='accepted' AND line.supply_status IS DISTINCT FROM 'in_stock') AS waiting_for_production", condition: 'row.waiting_for_production', pattern: '^autosave applies mbt_delivery with production' },
    { name: 'skip-protected-checks', bypass: true }
  ];
  const results = [];
  for (const mutant of mutants) {
    const root = snapshot();
    try {
      let changed;
      if (mutant.bypass) {
        changed = source.replace('  for (const row of result.rows) {\n    if (!row.purchase_approved)', '  return;\n  for (const row of result.rows) {\n    if (!row.purchase_approved)');
      } else {
        changed = source.replace('special.post_po_change_pending, special.attention, special.quantity_review', `${mutant.field}, special.post_po_change_pending, special.attention, special.quantity_review`)
          .replace('  for (const row of result.rows) {\n    if (!row.purchase_approved)', `  for (const row of result.rows) {\n    if (${mutant.condition}) throw Object.assign(new Error('Mutated Special Item block'), {status:409,code:'SPECIAL_STOCK_NOT_READY'});\n    if (!row.purchase_approved)`);
      }
      assert.notEqual(changed, source, mutant.name);
      writeFileSync(`${root}/${runtime}`, changed);
      const syntax = command('mutant-syntax-' + mutant.name, ['--check', runtime], root);
      assert.equal(syntax.exit, 0);
      const result = run('mutant-' + mutant.name, [unit], root);
      assert.equal(result.exit, 1); assert.ok(result.fail > 0 && !result.log.includes("failureType: 'hookFailed'"));
      let properties = null, endpoint = null;
      if (!mutant.bypass) {
        properties = run('mutant-property-' + mutant.name, [unit], root, '^property:');
        assert.equal(properties.exit, 1); assert.ok(properties.fail > 0);
        resetDatabase('mutant-http-' + mutant.name);
        endpoint = run('mutant-http-' + mutant.name, [http], root, mutant.pattern);
        assert.equal(endpoint.exit, 1); assert.ok(endpoint.fail > 0 && !endpoint.log.includes("failureType: 'hookFailed'"));
      }
      results.push({ name: mutant.name, killed: true, propertyKilled: properties?.fail > 0, endpointKilled: endpoint?.fail > 0 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  writeFileSync(`${out}/mutations.json`, JSON.stringify(results, null, 2) + '\n');
}

async function final() {
  for (const name of ['summary.json', 'static.json', 'mutations.json', 'coverage', 'c8']) { rmSync(`${out}/${name}`, { recursive: true, force: true }); }
  await staticChecks();
  const results = [run('final-unit', [unit])];
  assert.equal(results[0].exit, 0, results[0].log.slice(-2500));
  resetDatabase('final-http');
  const measured = command('final-http', ['/app/node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false', '--include=' + runtime,
    '--temp-directory=' + resolve(out + '/c8'), '--report-dir=' + resolve(out + '/coverage'), '--reporter=json',
    process.execPath, '--test', '--test-concurrency=1', http]);
  assert.equal(measured.exit, 0, measured.log.slice(-3500)); results.push(measured);
  const baselineResults = JSON.parse(readFileSync(`${out}/baseline-results.json`, 'utf8'));
  for (const file of regressions) {
    const label = 'final-' + file.split('/').at(-1).replace('.test.js', '');
    resetDatabase(label);
    const result = run(label, [file]);
    results.push(result);
    const previous = baselineResults.find(row => row.label === (file === oldGuard ? 'baseline-guard' : label.replace(/^final-/, 'baseline-')));
    assert.ok(previous, label);
    assert.deepEqual(result.failures.filter(name => !previous.failures.includes(name)), [], result.log.slice(-3500));
    assert.equal(result.exit, previous.exit, result.log.slice(-3500));
  }
  mutations();
  resetDatabase('shuffled-http');
  const shuffled = run('shuffled-http', [http, unit]);
  assert.equal(shuffled.exit, 0, shuffled.log.slice(-2500));
  const files = [runtime, unit, http, oldGuard, 'test/special-item-planning-spec.md', `${task}/run.py`, `${task}/check.mjs`,
    `${task}/coverage.py`, `${task}/deploy.py`, `${task}/live.mjs`];
  const hashes = Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
  const sourceHash = createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
  const summary = { mode, versions: { node: process.version, c8: JSON.parse(readFileSync('node_modules/c8/package.json')).version,
    typescript: JSON.parse(readFileSync('node_modules/typescript/package.json')).version },
    sourceHash, hashes, results: results.map(({ log: _log, ...row }) => row),
    totals: { tests: results.reduce((total, row) => total + row.tests, 0), pass: results.reduce((total, row) => total + row.pass, 0), fail: results.reduce((total, row) => total + row.fail, 0) },
    shuffled: { tests: shuffled.tests, pass: shuffled.pass, fail: shuffled.fail } };
  writeFileSync(`${out}/summary.json`, JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify({ final: summary.totals, sourceHash }));
}

if (mode === 'baseline') {
  baseline();
} else if (mode === 'red') {
  const root = snapshot();
  try {
    cpSync(`${task}/baseline/${runtime}`, `${root}/${runtime}`);
    const unitResult = run('red-unit', [unit], root);
    const httpResult = run('red-http', [http], root);
    assert.equal(unitResult.exit, 1); assert.ok(unitResult.fail >= 2);
    assert.equal(httpResult.exit, 1); assert.ok(httpResult.fail > 0 && !httpResult.log.includes("failureType: 'hookFailed'"));
    assert.ok(httpResult.log.includes('SPECIAL_STOCK_NOT_READY'));
  } finally { rmSync(root, { recursive: true, force: true }); }
} else if (mode === 'green') {
  const unitResult = run('green-unit', [unit]);
  const httpResult = run('green-http', [http]);
  assert.equal(unitResult.exit, 0, unitResult.log.slice(-3000));
  assert.equal(httpResult.exit, 0, httpResult.log.slice(-4000));
} else {
  assert.equal(mode, 'final');
  await final();
}
