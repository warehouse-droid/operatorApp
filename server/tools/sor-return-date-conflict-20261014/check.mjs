import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, cpSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.equal(new URL(process.env.DATABASE_URL).hostname, 'db');
assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED, 'false');
const mode = process.argv.at(-1);
const task = 'tools/sor-return-date-conflict-20261014', out = 'test-artifacts/sor-return-date-conflict-20261014';
const { runtime, primary, regressions, support } = JSON.parse(readFileSync(task + '/files.json', 'utf8'));
const js = runtime.filter(file => file.endsWith('.js'));
mkdirSync(out, { recursive: true });

function command(label, args, { cwd = process.cwd(), env = process.env, timeout = 300_000 } = {}) {
  const path = resolve(`${out}/${label}.log`), fd = openSync(path, 'w');
  let result;
  try { result = spawnSync(process.execPath, args, { cwd, env, timeout, stdio: ['ignore', fd, fd] }); }
  finally { closeSync(fd); }
  const log = readFileSync(path, 'utf8');
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key => [key,
    [...log.matchAll(new RegExp(`^(?:#|ℹ) ${key} (\\d+)$`, 'gm'))].reduce((sum, match) => sum + Number(match[1]), 0)]));
  const data = { label, exit: result.status, ...counts,
    failures: [...log.matchAll(/^not ok \d+ - (.+)$|^✖ (.+?) \([0-9.]+ms\)$/gm)].map(match =>
      (match[1] || match[2]).replace(/\/tmp\/(?:dispatch-source-notices|sor-return-date-conflict)-[^/]+\/|\/app\//g, '<source>/')) };
  writeFileSync(`${out}/${label}.json`, JSON.stringify(data, null, 2) + '\n');
  console.log(JSON.stringify(data));
  return { ...data, log };
}
function fullSuites(beforeRoot) {
  const results = [];
  for (const [label, args] of [
    ['dispatch', ['test/support/run-dispatch-performance-tests.mjs', 'unit', 'property', 'adversarial', 'frontend', 'integration', 'concurrency']]
  ]) {
    reset();
    const before = command('full-baseline-' + label, args, { cwd: beforeRoot, timeout: 3_600_000 });
    reset();
    const after = command('full-final-' + label, args, { timeout: 3_600_000 });
    assert.ok([0, 1].includes(before.exit) && [0, 1].includes(after.exit), 'Full suite timed out or did not finish');
    const remaining = before.failures.slice();
    const newFailures = after.failures.filter(name => {
      const index = remaining.indexOf(name);
      if (index < 0) { return true; }
      remaining.splice(index, 1); return false;
    });
    results.push({ label, before: { ...before, log: undefined }, after: { ...after, log: undefined }, newFailures });
    writeFileSync(out + '/full-suite.json', JSON.stringify(results, null, 2) + '\n');
    assert.deepEqual(newFailures, [], 'New failures in ' + label + ': ' + JSON.stringify(newFailures));
    assert.ok(after.fail <= before.fail && after.tests >= before.tests, 'Full suite gained failures or ran fewer reported tests');
  }
}
function database(script) {
  const result = command('database-' + createHash('sha256').update(script).digest('hex').slice(0, 8),
    ['--input-type=module', '-e', `import pg from 'pg';const url=new URL(process.env.DATABASE_URL);url.pathname='/mbt_admin';const client=new pg.Client({connectionString:url.href});try{await client.connect();${script}}finally{await client.end();}`]);
  assert.equal(result.exit, 0, result.log.slice(-1500));
}
function reset() {
  database("await client.query('DROP DATABASE mbt_test WITH (FORCE)');await client.query('CREATE DATABASE mbt_test TEMPLATE mbt_sorreturn_template');");
}
function tests(label, files, options = {}) {
  const env = { ...process.env, ...options.env };
  const args = ['--test', '--test-concurrency=1', ...(options.pattern ? ['--test-name-pattern=' + options.pattern] : []), ...files];
  if (options.coverage) { env.SPLIT_DATE_COVERAGE_DIR = '/tmp/sorreturn-c8'; }
  return command(label, options.coverage ? ['/app/node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false',
    ...js.map(file => '--include=' + file), '--clean=false', '--temp-directory=/tmp/sorreturn-c8',
    '--report-dir=' + out + '/coverage', '--reporter=json', '--reporter=text', process.execPath, ...args] : args,
  { cwd: options.cwd || process.cwd(), env });
}
function snapshot(before = false) {
  const root = mkdtempSync('/tmp/sor-return-date-conflict-');
  cpSync(before ? task + '/baseline/src' : 'src', root + '/src', { recursive: true });
  cpSync(before ? task + '/baseline/public' : 'public', root + '/public', { recursive: true });
  for (const folder of ['node_modules', 'migrations', 'tools', 'test-artifacts']) { symlinkSync(resolve(folder), root + '/' + folder); }
  cpSync('package.json', root + '/package.json');
  cpSync('netsuite-smart-scm-picking-ticket-restlet.js', root + '/netsuite-smart-scm-picking-ticket-restlet.js');
  cpSync('test', root + '/test', { recursive: true });
  return root;
}
async function staticChecks() {
  const root = snapshot(true);
  try {
    const args = ['/app/node_modules/typescript/bin/tsc', '--noEmit', '--allowJs', '--checkJs', '--skipLibCheck',
      '--types', 'node', '--target', 'ES2022', '--module', 'NodeNext'];
    const before = command('types-before', [...args, ...js.filter(file => existsSync(root + '/' + file))], { cwd: root });
    const after = command('types-after', [...args, ...js]);
    const messages = log => log.split('\n').filter(line => /error TS\d+/.test(line)).map(line => line.replace(/\(\d+,\d+\)/, ''));
    const previous = messages(before.log);
    const newTypes = messages(after.log).filter(message => { const i = previous.indexOf(message); if (i < 0) { return true; } previous.splice(i, 1); return false; });
    const { ESLint } = await import('eslint');
    const lint = new ESLint({ overrideConfigFile: resolve('tools/stock-request-layout-eslint.config.mjs') });
    const newLint = [];
    for (const file of js) {
      const old = existsSync(root + '/' + file) ? (await lint.lintText(readFileSync(root + '/' + file, 'utf8'), { filePath: file }))[0].messages : [];
      const previousMessages = old.map(row => JSON.stringify([row.ruleId, row.severity, row.message]));
      const current = (await lint.lintText(readFileSync(file, 'utf8'), { filePath: file }))[0].messages;
      newLint.push(...current.map(row => JSON.stringify([row.ruleId, row.severity, row.message])).filter(message => {
        const i = previousMessages.indexOf(message); if (i < 0) { return true; } previousMessages.splice(i, 1); return false;
      }).map(message => ({ file, message })));
    }
    const testLint = new ESLint({ overrideConfigFile: resolve('eslint.mbt.config.js'), overrideConfig: [{ files: ['test/dispatch/**/*.js'],
      rules: { 'no-unused-vars': 'error', 'no-unreachable': 'error', 'no-dupe-keys': 'error', 'curly': 'error' } }] });
    const testMessages = (await testLint.lintFiles(primary)).flatMap(row => row.messages);
    const result = { baselineTypes: messages(before.log).length, currentTypes: messages(after.log).length, newTypes, newLint, testMessages };
    writeFileSync(out + '/static.json', JSON.stringify(result, null, 2) + '\n');
    assert.deepEqual(newTypes, [], JSON.stringify(newTypes.slice(0, 20)));
    assert.deepEqual(newLint, [], JSON.stringify(newLint)); assert.deepEqual(testMessages, [], JSON.stringify(testMessages));
    for (const file of [...js, ...primary, task + '/check.mjs']) { assert.equal(command('syntax-' + file.replaceAll('/', '_'), ['--check', file]).exit, 0); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const observer = mode === 'final' ? spawn(process.execPath, [task + '/watchdog.mjs'], { stdio: 'ignore' }) : null;
try {
const admin = command('create-admin', ['--input-type=module', '-e', `import pg from 'pg';const c=new pg.Client({connectionString:process.env.DATABASE_URL});try{await c.connect();await c.query('CREATE DATABASE mbt_admin');}finally{await c.end();}`]);
assert.equal(admin.exit, 0);
database("await client.query('CREATE DATABASE mbt_sorreturn_template TEMPLATE mbt_test');");
if (mode === 'red') {
  const result = tests('red-primary', primary);
  assert.notEqual(result.exit, 0); assert.ok(result.fail >= 3, result.log);
} else if (mode === 'baseline') {
  for (const file of regressions) { reset(); tests('baseline-' + file.replaceAll('/', '_'), [file]); }
} else {
  const results = [];
  if (mode === 'final') { rmSync('/tmp/sorreturn-c8', { recursive: true, force: true }); mkdirSync('/tmp/sorreturn-c8'); }
  const first = tests(mode + '-primary', primary, { coverage: mode === 'final' });
  results.push(first); assert.equal(first.exit, 0, first.log.slice(-4000));
  if (mode === 'final') {
    await staticChecks();
    const beforeRoot = snapshot(true), baselineResults = [];
    const newFailures = [];
    try {
      for (const file of regressions) {
        reset();
        const prior = tests('baseline-' + file.replaceAll('/', '_'), [file], { cwd: beforeRoot });
        baselineResults.push(prior);
        reset();
        const current = tests('regression-' + file.replaceAll('/', '_'), [file], { coverage: true });
        results.push(current);
        const failures = current.failures.filter(name => !prior.failures.includes(name));
        newFailures.push(...failures.map(name => ({ file, name })));
        assert.deepEqual(failures, [], current.log.slice(-4000));
        assert.ok(current.exit === 0 || (prior.exit !== 0 && current.fail === prior.fail), current.log.slice(-4000));
      }
      writeFileSync(out + '/regression-baseline.json', JSON.stringify({ results: baselineResults.map(({ log: _log, ...data }) => data), newFailures }, null, 2) + '\n');
      fullSuites(beforeRoot);
    } finally { rmSync(beforeRoot, { recursive: true, force: true }); }
    reset();
    for (const file of [...primary.slice().reverse()]) {
      const repeated = tests('shuffled-' + file.replaceAll('/', '_'), [file]);
      results.push(repeated); assert.equal(repeated.exit, 0, repeated.log.slice(-4000));
    }
    const mutations = await import('./mutations.mjs');
    await mutations.runMutations({ snapshot, tests, reset, out, primary });
  }
  const hashes = Object.fromEntries([...runtime, ...primary, ...regressions, ...support].map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
  const summary = { results: results.map(({ log: _log, ...data }) => data), hashes,
    sourceHash: createHash('sha256').update(JSON.stringify(hashes)).digest('hex'), node: process.version,
    tests: results.reduce((sum, row) => sum + row.tests, 0), pass: results.reduce((sum, row) => sum + row.pass, 0),
    fail: results.reduce((sum, row) => sum + row.fail, 0), newFailures: [] };
  writeFileSync(out + '/summary.json', JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify({ tests: summary.tests, pass: summary.pass, fail: summary.fail, sourceHash: summary.sourceHash }));
}
} finally { observer?.kill('SIGTERM'); }
