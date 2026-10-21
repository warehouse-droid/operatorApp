import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, cpSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.equal(new URL(process.env.DATABASE_URL).hostname, 'mbbs-special-review-db');
assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED, 'false');
const mode = process.argv.at(-1);
const task = 'tools/special-planning-unblocked-20261012';
const out = 'test-artifacts/special-planning-unblocked-20261012';
const runtime = ['src/dispatch-plan-repository.js', 'src/dispatch-fulfilled-so-policy.js', 'src/dispatch-fulfilled-so-repository.js'];
const primary = ['test/dispatch/unit/special-po-independent-planning.test.js',
  'test/dispatch/unit/dispatch-fulfilled-so-policy.test.js',
  'test/dispatch/frontend/dispatch-packing-planning.test.js',
  'test/dispatch/integration/special-item-planning-save.test.js'];
const regressions = [
  'test/mbt/integration/special-stock-request-dispatch-guard.red.test.js',
  'test/mbt/integration/special-approval-fulfillment.test.js',
  'test/mbt/integration/special-approval-http.test.js',
  'test/mbt/integration/special-workflow-pricing-http.test.js',
  'test/mbt/integration/special-workflow-closure.test.js',
  'test/dispatch/integration/dispatch-save-recovery.red.test.js',
  'test/dispatch/integration/dispatch-planner-compact-command.red.test.js',
  'test/dispatch/integration/dispatch-fulfilled-so-planning.test.js',
  'test/dispatch/integration/dispatch-packed-group-review.test.js',
  'src/grouped-sales-order-reconciliation-integration-harness.js',
  'test/dispatch/integration/dispatch-fulfilled-so-http.test.js',
  'test/dispatch/concurrency/dispatch-fulfilled-so-planning.test.js',
  'test/dispatch/frontend/dispatch-save-reliability.test.js',
  'test/dispatch/frontend/dispatch-fulfilled-so-ui.test.js'
];
mkdirSync(out, { recursive: true });
function command(label, args, cwd = process.cwd(), env = process.env) {
  const path = resolve(`${out}/${label}.log`), fd = openSync(path, 'w');
  let result;
  try { result = spawnSync(process.execPath, args, { cwd, env, timeout: 600_000, stdio: ['ignore', fd, fd] }); }
  finally { closeSync(fd); }
  const log = readFileSync(path, 'utf8');
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key => [key,
    Number(log.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] || 0)]));
  const data = { label, exit: result.status, ...counts,
    failures: [...log.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]) };
  writeFileSync(`${out}/${label}.json`, JSON.stringify(data, null, 2) + '\n');
  console.log(JSON.stringify(data));
  return { ...data, log };
}
function database(script) {
  const result = command('database-' + createHash('sha256').update(script).digest('hex').slice(0, 8),
    ['--input-type=module', '-e', `import pg from 'pg';const url=new URL(process.env.DATABASE_URL);url.pathname='/mbt_test';const client=new pg.Client({connectionString:url.href});try{await client.connect();${script}}finally{await client.end();}`]);
  assert.equal(result.exit, 0, result.log.slice(-1500));
}
function reset() {
  database("await client.query('DROP DATABASE mbt_verify WITH (FORCE)');await client.query('CREATE DATABASE mbt_verify TEMPLATE mbt_planning_template');");
}
function tests(label, files, options = {}) {
  let env = { ...process.env, ...options.env };
  if (files.some(file => file.endsWith('special-workflow-pricing-http.test.js'))) {
    database("await client.query('DROP DATABASE IF EXISTS mbt_test_file_202610120000_specialplanning WITH (FORCE)');await client.query('CREATE DATABASE mbt_test_file_202610120000_specialplanning TEMPLATE mbt_planning_template');");
    const url = new URL(process.env.DATABASE_URL); url.hostname = 'db'; url.pathname = '/mbt_test_file_202610120000_specialplanning';
    env.DATABASE_URL = url.href;
  }
  const args = ['--test', '--test-concurrency=1', ...(options.pattern ? ['--test-name-pattern=' + options.pattern] : []), ...files];
  return command(label, options.coverage ? ['/app/node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false',
    ...runtime.map(file => '--include=' + file), '--clean=false', '--temp-directory=/tmp/planning-c8',
    '--report-dir=' + out + '/coverage', '--reporter=json', '--reporter=text', process.execPath, ...args] : args,
  options.cwd || process.cwd(), env);
}
function snapshot() {
  const root = mkdtempSync('/tmp/dispatch-planning-');
  cpSync('src', `${root}/src`, { recursive: true });
  for (const folder of ['node_modules', 'public', 'migrations', 'tools', 'test-artifacts']) symlinkSync(resolve(folder), `${root}/${folder}`);
  cpSync('package.json', `${root}/package.json`);
  cpSync('netsuite-smart-scm-picking-ticket-restlet.js', `${root}/netsuite-smart-scm-picking-ticket-restlet.js`);
  for (const folder of ['dispatch/support', 'support', 'field-sales']) cpSync('test/' + folder, `${root}/test/${folder}`, { recursive: true });
  for (const file of [...primary, ...regressions]) {
    mkdirSync(dirname(`${root}/${file}`), { recursive: true }); cpSync(file, `${root}/${file}`);
  }
  return root;
}
async function staticChecks() {
  const root = snapshot();
  try {
    for (const file of runtime) cpSync(`${task}/baseline/${file}`, `${root}/${file}`);
    const args = ['/app/node_modules/typescript/bin/tsc', '--noEmit', '--allowJs', '--checkJs', '--skipLibCheck',
      '--types', 'node', '--target', 'ES2022', '--module', 'NodeNext', ...runtime];
    const before = command('types-before', args, root), after = command('types-after', args);
    const messages = log => log.split('\n').filter(line => /error TS\d+/.test(line)).map(line => line.replace(/\(\d+,\d+\)/, ''));
    const previous = messages(before.log);
    const newTypes = messages(after.log).filter(message => { const i = previous.indexOf(message); if (i < 0) return true; previous.splice(i, 1); return false; });
    const { ESLint } = await import('eslint');
    const lint = new ESLint({ overrideConfigFile: resolve('tools/stock-request-layout-eslint.config.mjs') });
    const newLint = [];
    for (const file of runtime) {
      const beforeMessages = (await lint.lintText(readFileSync(`${root}/${file}`, 'utf8'), { filePath: file }))[0].messages.map(row => JSON.stringify([row.ruleId, row.severity, row.message]));
      const afterMessages = (await lint.lintText(readFileSync(file, 'utf8'), { filePath: file }))[0].messages.map(row => JSON.stringify([row.ruleId, row.severity, row.message]));
      newLint.push(...afterMessages.filter(message => { const i = beforeMessages.indexOf(message); if (i < 0) return true; beforeMessages.splice(i, 1); return false; }));
    }
    const testLint = new ESLint({ overrideConfigFile: resolve('eslint.mbt.config.js') });
    const testMessages = (await testLint.lintFiles(primary)).flatMap(row => row.messages);
    const result = { baselineTypes: messages(before.log).length, currentTypes: messages(after.log).length, newTypes, newLint, testMessages };
    writeFileSync(`${out}/static.json`, JSON.stringify(result, null, 2) + '\n');
    assert.deepEqual(newTypes, []); assert.deepEqual(newLint, []); assert.deepEqual(testMessages, []);
    for (const file of [...runtime, ...primary, `${task}/check.mjs`]) assert.equal(command('syntax-' + file.split('/').at(-1), ['--check', file]).exit, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

database("await client.query('CREATE DATABASE mbt_planning_template TEMPLATE mbt_verify');");
if (mode === 'baseline-http') {
  const result = tests('baseline-http', ['test/dispatch/integration/dispatch-fulfilled-so-http.test.js']);
  assert.equal(result.exit, 0, result.log.slice(-3000));
} else if (mode === 'case-red') {
  const result = tests('case-red', ['test/dispatch/integration/dispatch-packed-group-review.test.js'], { pattern: 'cached packing-only' });
  assert.notEqual(result.exit, 0); assert.ok(result.fail > 0);
} else if (mode === 'red') {
  const result = tests('red', primary);
  assert.notEqual(result.exit, 0); assert.ok(result.fail > 0);
  console.log(JSON.stringify({ observedRed: true, fail: result.fail }));
} else {
  const results = [];
  if (mode === 'final') rmSync('/tmp/planning-c8', { recursive: true, force: true });
  results.push(tests(mode + '-primary', primary, { coverage: mode === 'final' }));
  assert.equal(results.at(-1).exit, 0, results.at(-1).log.slice(-4000));
  if (mode === 'final') {
    await staticChecks();
    for (const file of regressions) {
      reset();
      const result = tests('regression-' + file.split('/').at(-1), [file], { coverage: true });
      results.push(result); assert.equal(result.exit, 0, result.log.slice(-4000));
    }
    reset();
    results.push(tests('shuffled-primary', primary, { env: { SPECIAL_PLANNING_SHUFFLE_SEED: '20261012' } }));
    assert.equal(results.at(-1).exit, 0, results.at(-1).log.slice(-4000));
    const mutations = await import('./mutations.mjs');
    await mutations.runMutations({ snapshot, tests, reset, runtime, out, primary });
  }
  const hashes = Object.fromEntries([...runtime, ...primary, ...regressions].map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
  const summary = { results: results.map(({ log: _log, ...data }) => data), hashes,
    sourceHash: createHash('sha256').update(JSON.stringify(hashes)).digest('hex'), node: process.version,
    tests: results.reduce((sum, row) => sum + row.tests, 0), pass: results.reduce((sum, row) => sum + row.pass, 0),
    fail: results.reduce((sum, row) => sum + row.fail, 0) };
  writeFileSync(`${out}/summary.json`, JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify({ tests: summary.tests, pass: summary.pass, fail: summary.fail, sourceHash: summary.sourceHash }));
}
