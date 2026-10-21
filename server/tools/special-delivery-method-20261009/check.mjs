import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, openSync, closeSync, cpSync, symlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.equal(new URL(process.env.DATABASE_URL).hostname, 'mbbs-special-review-db');
assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED, 'false');
const out = 'test-artifacts/special-delivery-method-20261009', mode = process.argv.at(-1);
mkdirSync(out, { recursive: true });
const own = ['change', 'http', 'browser'].map(name => `test/mbt/integration/special-delivery-method-${name}.test.js`);
const special = ['unit', 'property', 'integration'].flatMap(kind => readdirSync(`test/mbt/${kind}`).filter(name => /^special-.*\.test\.js$/.test(name) && !name.startsWith('special-delivery-method-')).sort().map(name => `test/mbt/${kind}/${name}`));
function command(label, args, expected = 0, cwd = process.cwd()) {
  const fd = openSync(resolve(`${out}/${label}.log`), 'w');
  let result;
  try { result = spawnSync(process.execPath, args, { cwd, env: process.env, timeout: 900000, stdio: ['ignore', fd, fd] }); }
  finally { closeSync(fd); }
  const log = readFileSync(`${out}/${label}.log`, 'utf8');
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key => [key, Number(log.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] || 0)]));
  const failures = [...log.matchAll(/^not ok \d+ - (.+?)(?: # SKIP.*?)?$/gm)].filter(match => !match[0].includes(' # SKIP')).map(match => match[1]);
  console.log(JSON.stringify({ label, exit: result.status, ...counts }));
  const data = { exit: result.status, ...counts, failures };
  writeFileSync(`${out}/${label}${counts.tests ? '' : '.result'}.json`, JSON.stringify(data, null, 2));
  if (expected !== null) assert.equal(result.status, expected, log.slice(-4500));
  if (expected === 1) assert.ok(counts.fail > 0 && !log.includes("failureType: 'hookFailed'"), 'RED must fail on behavior');
  return { ...data, log };
}
const run = (label, files, expected = 0, cwd = process.cwd()) => command(label, ['--test', '--test-concurrency=1', ...files], expected, cwd);
function snapshot(prefix) {
  const root = mkdtempSync('/tmp/' + prefix);
  for (const folder of ['src', 'public', 'test']) cpSync(folder, `${root}/${folder}`, { recursive: true });
  for (const folder of ['node_modules', 'tools', 'migrations', 'test-artifacts']) symlinkSync(resolve(folder), `${root}/${folder}`);
  for (const file of ['package.json', 'netsuite-smart-scm-picking-ticket-restlet.js']) cpSync(file, `${root}/${file}`);
  return root;
}
function resetDatabase(label) {
  command(label + '-database', ['--input-type=module', '-e', "import pg from 'pg';const url=new URL(process.env.DATABASE_URL);if(url.hostname!=='mbbs-special-review-db'||url.pathname!=='/mbt_verify')throw Error('Not isolated');url.pathname='/mbt_test';const client=new pg.Client({connectionString:url.href});try{await client.connect();await client.query('DROP DATABASE mbt_verify WITH (FORCE)');await client.query('CREATE DATABASE mbt_verify');}finally{await client.end();}"]);
  command(label + '-migrate', ['src/migrate.js']);
}
async function staticChecks() {
  const files = JSON.parse(readFileSync('tools/special-delivery-method-20261009/files.json')), js = files.filter(file => file.endsWith('.js'));
  const root = snapshot('special-method-static-');
  try {
    for (const file of js) cpSync(`tools/special-delivery-method-20261009/baseline/${file}`, `${root}/${file}`);
    const args = ['/app/node_modules/typescript/bin/tsc', '--noEmit', '--allowJs', '--checkJs', '--skipLibCheck', '--types', 'node', '--target', 'ES2022', '--module', 'NodeNext'];
    const before = command('types-before', [...args, ...js], null, root), after = command('types-after', [...args, ...js], null);
    const messages = log => log.split('\n').filter(line => /error TS\d+/.test(line)).map(line => line.replace(/\(\d+,\d+\)/, ''));
    const old = messages(before.log), added = messages(after.log).filter(line => { const index = old.indexOf(line); if (index < 0) return true; old.splice(index, 1); return false; });
    const { ESLint } = await import('eslint'), lint = new ESLint({ overrideConfigFile: resolve('tools/stock-request-layout-eslint.config.mjs') });
    const newLint = [];
    for (const file of js) {
      const previous = (await lint.lintText(readFileSync(`${root}/${file}`, 'utf8'), { filePath: file }))[0].messages.map(message => JSON.stringify([message.ruleId, message.severity, message.message]));
      const next = (await lint.lintText(readFileSync(file, 'utf8'), { filePath: file }))[0].messages.map(message => JSON.stringify([message.ruleId, message.severity, message.message]));
      for (const message of next) { const index = previous.indexOf(message); if (index < 0) newLint.push({ file, message }); else previous.splice(index, 1); }
      command('syntax-' + file.split('/').at(-1), ['--check', file]);
    }
    writeFileSync(`${out}/static.json`, JSON.stringify({ newTypes: added, newLint, baselineTypeErrors: messages(before.log).length, currentTypeErrors: messages(after.log).length }, null, 2));
    assert.deepEqual(added, []); assert.deepEqual(newLint, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
async function gauntlet() {
  await staticChecks();
  for (const folder of ['coverage', 'c8', 'browser']) rmSync(`${out}/${folder}`, { recursive: true, force: true });
  const includes = JSON.parse(readFileSync('tools/special-delivery-method-20261009/files.json')).filter(file => file.endsWith('.js')).map(file => '--include=' + file);
  const measured = command('coverage-tests', ['/app/node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false', ...includes, '--temp-directory=' + resolve(out + '/c8'), '--report-dir=' + resolve(out + '/coverage'), '--reporter=json', process.execPath, '--test', '--test-concurrency=1', ...own]);
  command('changed-coverage', ['tools/special-delivery-method-20261009/coverage.mjs']);
  const mutants = [
    { name: 'lose-team-notice', file: 'src/special-stock-request-repository.js', before: "notifyTeams: special.workflow_kind === 'special' && special.fulfillment_method !== target.fulfillmentMethod,", after: 'notifyTeams: false,', tests: [own[0]] },
    { name: 'notify-for-unchanged-method', file: 'src/special-stock-request-repository.js', before: "notifyTeams: special.workflow_kind === 'special' && special.fulfillment_method !== target.fulfillmentMethod,", after: 'notifyTeams: true,', tests: [own[0]] },
    { name: 'hide-other-team-notice', file: 'src/special-delivery-method-alerts.js', before: ' AND receipt.audience=$2)', after: ' AND $2::text IS NOT NULL)', tests: [own[0]] },
    { name: 'allow-invalid-id', file: 'src/special-delivery-method-alerts.js', before: 'if (!Number.isSafeInteger(id) || id <= 0) {', after: 'if (false) {', tests: [own[0]], pattern: '^property:', property: true },
    { name: 'omit-team-alert-client', file: 'public/app-sidebar.js', before: '    document.head.appendChild(specialDeliveryAlert);', after: '', tests: [own[2]], pattern: 'sees a durable change popup' }
  ];
  const mutations = [];
  for (const mutant of mutants) {
    const root = snapshot('special-method-mutant-');
    try {
      const source = readFileSync(mutant.file, 'utf8'); assert.equal(source.split(mutant.before).length, 2, mutant.name);
      writeFileSync(`${root}/${mutant.file}`, source.replace(mutant.before, mutant.after));
      const args = ['--test', '--test-concurrency=1', ...(mutant.pattern ? ['--test-name-pattern=' + mutant.pattern] : []), ...mutant.tests];
      const result = command('mutation-' + mutant.name, args, 1, root);
      mutations.push({ name: mutant.name, killed: result.fail > 0, propertyKilled: mutant.property === true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  resetDatabase('before-regression');
  const regression = run('regression', special, null), baseline = JSON.parse(readFileSync(`${out}/baseline.json`));
  const previous = [...baseline.failures];
  const added = regression.failures.filter(name => { const index = previous.indexOf(name); if (index < 0) return true; previous.splice(index, 1); return false; });
  assert.deepEqual(added, []);
  resetDatabase('after-regression');
  const reverseFiles = [...own].reverse().map(file => run('reverse-' + file.split('/').at(-1), [file]));
  const reverse = { exit: 0, fail: 0, tests: reverseFiles.reduce((sum, result) => sum + result.tests, 0), pass: reverseFiles.reduce((sum, result) => sum + result.pass, 0), fileOrder: [...own].reverse() };
  const restored = run('restored', own);
  const files = JSON.parse(readFileSync('tools/special-delivery-method-20261009/files.json'));
  command('secrets', ['test/support/scan-diff-secrets.mjs', ...files, ...own, 'tools/special-delivery-method-20261009/check.mjs', 'tools/special-delivery-method-20261009/run.py']);
  const versions = Object.fromEntries(['typescript', 'eslint', 'c8', 'fast-check', '@playwright/test'].map(name => [name, JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version]));
  const withoutLog = value => { const { log: _log, ...rest } = value; return rest; };
  writeFileSync(`${out}/summary.json`, JSON.stringify({ measured: withoutLog(measured), regression: withoutLog(regression), reverse: withoutLog(reverse), restored: withoutLog(restored), mutations, newFailures: added,
    hashes: Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')])), node: process.version, versions }, null, 2));
}
async function finishEvidence() {
  const summary = JSON.parse(readFileSync(`${out}/summary.json`));
  assert.ok(!summary.newFailures.length && summary.mutations.every(value => value.killed));
  assert.ok(Object.entries(summary.hashes).every(([file, hash]) => createHash('sha256').update(readFileSync(file)).digest('hex') === hash));
  for (const folder of ['coverage', 'c8', 'browser']) rmSync(`${out}/${folder}`, { recursive: true, force: true });
  const includes = Object.keys(summary.hashes).filter(file => file.endsWith('.js')).map(file => '--include=' + file);
  const measured = command('coverage-tests-final', ['/app/node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false', ...includes, '--temp-directory=' + resolve(out + '/c8'), '--report-dir=' + resolve(out + '/coverage'), '--reporter=json', process.execPath, '--test', '--test-concurrency=1', ...own]);
  command('changed-line-report-final', ['tools/special-delivery-method-20261009/coverage.mjs']);
  const root = snapshot('special-method-receipt-mutant-');
  try {
    const file = 'src/special-delivery-method-alerts.js', source = readFileSync(file, 'utf8'), before = ' ON CONFLICT(operator_id,audience,event_id) DO NOTHING';
    assert.equal(source.split(before).length, 2);
    writeFileSync(`${root}/${file}`, source.replace(before, ''));
    const result = run('mutation-duplicate-ack-receipt', [own[1]], 1, root);
    summary.mutations.push({ name: 'duplicate-ack-receipt', killed: result.fail > 0 });
  } finally { rmSync(root, { recursive: true, force: true }); }
  const reverseFiles = [...own].reverse().map(file => run('reverse-file-final-' + file.split('/').at(-1), [file]));
  const { log: _log, ...measuredResult } = measured;
  summary.measured = measuredResult;
  summary.reverse = { exit: 0, fail: 0, tests: reverseFiles.reduce((sum, result) => sum + result.tests, 0), pass: reverseFiles.reduce((sum, result) => sum + result.pass, 0), fileOrder: [...own].reverse() };
  command('secrets-final', ['test/support/scan-diff-secrets.mjs', ...Object.keys(summary.hashes), ...own, 'tools/special-delivery-method-20261009/check.mjs', 'tools/special-delivery-method-20261009/run.py', 'tools/special-delivery-method-20261009/deploy.py']);
  writeFileSync(`${out}/summary.json`, JSON.stringify(summary, null, 2));
}
if (mode === 'red') run('red', own, 1);
else if (mode === 'baseline') {
  const root = snapshot('special-method-baseline-');
  try {
    console.log(JSON.stringify({ baselineSnapshot: 'ready' }));
    for (const file of JSON.parse(readFileSync('tools/special-delivery-method-20261009/files.json')).filter(file => file.endsWith('.js'))) cpSync(`tools/special-delivery-method-20261009/baseline/${file}`, `${root}/${file}`);
    run('baseline', special, null, root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
else if (mode === 'finish') await finishEvidence();
else {
  run('focused', own);
  if (mode === 'final') await gauntlet();
}
