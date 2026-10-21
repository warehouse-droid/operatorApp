import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, cpSync, symlinkSync, mkdtempSync, rmSync, openSync, closeSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.equal(new URL(process.env.DATABASE_URL).hostname, 'mbbs-special-review-db');
assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED, 'false');
const out = 'test-artifacts/special-stock-check-editing-20261009';
mkdirSync(out, { recursive: true });
const mode = process.argv.at(-1);
const own = ['test/mbt/integration/special-stock-check-editing-http.test.js', 'test/mbt/integration/special-stock-check-editing-browser.test.js'];
const special = ['unit', 'property', 'integration'].flatMap(kind => readdirSync(`test/mbt/${kind}`)
  .filter(name => /^special-.*\.test\.js$/.test(name) && !name.startsWith('special-stock-check-editing-')).sort()
  .map(name => `test/mbt/${kind}/${name}`));
function run(label, args, { red = false, baseline = false, cwd = process.cwd(), env = process.env } = {}) {
  const fd = openSync(resolve(`${out}/${label}.log`), 'w');
  let result;
  try { result = spawnSync(process.execPath, args, { cwd, env, timeout: 600000, stdio: ['ignore', fd, fd] }); }
  finally { closeSync(fd); }
  const log = readFileSync(`${out}/${label}.log`, 'utf8');
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key => [key, Number(log.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] || 0)]));
  const failures = [...log.matchAll(/^not ok \d+ - (.+?)(?: # SKIP.*?)?$/gm)].filter(match => !match[0].includes(' # SKIP')).map(match => match[1]);
  console.log(JSON.stringify({ label, exit: result.status, ...counts }));
  if (red) {
    assert.equal(result.status, 1);
    assert.ok(counts.fail > 0 && !log.includes("failureType: 'hookFailed'"), `${label}: must fail on behavior, not setup`);
  } else if (!baseline) {
    assert.equal(result.status, 0, `${label}: ${log.slice(-3500)}`);
  }
  assert.notEqual(result.status, null, `${label} timed out`);
  return { exit: result.status, ...counts, failures, log };
}
function copyTree(prefix) {
  const root = mkdtempSync('/tmp/' + prefix);
  for (const folder of ['src', 'public', 'test']) { cpSync(folder, `${root}/${folder}`, { recursive: true }); }
  for (const folder of ['node_modules', 'tools', 'migrations']) { symlinkSync(resolve(folder), `${root}/${folder}`); }
  for (const file of ['package.json', 'netsuite-smart-scm-picking-ticket-restlet.js']) { cpSync(file, `${root}/${file}`); }
  return root;
}
async function restoreView() {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try { await client.connect(); await client.query(readFileSync('migrations/276_special_stock_check_revisions.sql', 'utf8')); }
  finally { await client.end(); }
}
function resetDatabase(label) {
  run(label + '-db', ['--input-type=module', '-e', "import pg from 'pg';const url=new URL(process.env.DATABASE_URL);if(url.hostname!=='mbbs-special-review-db'||url.pathname!=='/mbt_verify')throw Error('Not isolated');url.pathname='/mbt_test';const client=new pg.Client({connectionString:url.href});try{await client.connect();await client.query('DROP DATABASE mbt_verify WITH (FORCE)');await client.query('CREATE DATABASE mbt_verify');}finally{await client.end();}"]);
  run(label + '-migrate', ['src/migrate.js']);
}
if (mode === 'red') {
  writeFileSync(`${out}/red.json`, JSON.stringify(run('red', ['--test', '--test-concurrency=1', ...own], { red: true }), null, 2));
} else if (mode === 'baseline') {
  const root = copyTree('stock-check-reproducible-baseline-');
  try {
    for (const file of JSON.parse(readFileSync('tools/special-stock-check-editing-20261009/files.json')).filter(name => !name.startsWith('migrations/'))) {
      cpSync(`tools/special-stock-check-editing-20261009/baseline/${file}`, `${root}/${file}`);
    }
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    try {
      await client.connect();
      const original = readFileSync('migrations/275_request_completion_lookup.sql', 'utf8').split('CREATE OR REPLACE VIEW special_stock_workflow_stages AS')[1].split('-- Share one evidence')[0];
      await client.query('CREATE OR REPLACE VIEW special_stock_workflow_stages AS' + original);
    } finally { await client.end(); }
    writeFileSync(`${out}/baseline.json`, JSON.stringify(run('baseline', ['--test', '--test-concurrency=1', ...special], { baseline: true, cwd: root }), null, 2));
  } finally { rmSync(root, { recursive: true, force: true }); }
} else {
  let regression, baseline, newFailures;
  if (mode === 'final') {
    const { ESLint } = await import('eslint');
    const files = JSON.parse(readFileSync('tools/special-stock-check-editing-20261009/files.json'));
    const js = files.filter(file => file.endsWith('.js'));
    const baselineRoot = copyTree('stock-check-static-baseline-');
    try {
      for (const file of js) { cpSync(`tools/special-stock-check-editing-20261009/baseline/${file}`, `${baselineRoot}/${file}`); }
      const args = ['/app/node_modules/typescript/bin/tsc', '--noEmit', '--allowJs', '--checkJs', '--skipLibCheck', '--types', 'node', '--target', 'ES2022', '--module', 'NodeNext'];
      const before = run('types-before', [...args, ...js], { cwd: baselineRoot, baseline: true });
      const after = run('types-after', [...args, ...js], { baseline: true });
      const messages = log => log.split('\n').filter(line => /error TS\d+/.test(line)).map(line => line.replace(/\(\d+,\d+\)/, ''));
      const old = messages(before.log), added = messages(after.log).filter(line => { const index = old.indexOf(line); if (index < 0) { return true; } old.splice(index, 1); return false; });
      assert.deepEqual(added, []);
      const lint = new ESLint({ overrideConfigFile: resolve('tools/stock-request-layout-eslint.config.mjs') });
      const newLint = [];
      for (const file of js) {
        const previous = (await lint.lintText(readFileSync(`${baselineRoot}/${file}`, 'utf8'), { filePath: file }))[0].messages.map(message => JSON.stringify([message.ruleId, message.severity, message.message]));
        const next = (await lint.lintText(readFileSync(file, 'utf8'), { filePath: file }))[0].messages.map(message => JSON.stringify([message.ruleId, message.severity, message.message]));
        for (const message of next) { const index = previous.indexOf(message); if (index < 0) { newLint.push({ file, message }); } else { previous.splice(index, 1); } }
        run('syntax-' + file.split('/').at(-1), ['--check', file]);
      }
      assert.deepEqual(newLint, []);
      writeFileSync(`${out}/static.json`, JSON.stringify({ newTypes: added, newLint, baselineTypeErrors: messages(before.log).length, currentTypeErrors: messages(after.log).length }));
      run('lint-tests', ['/app/node_modules/eslint/bin/eslint.js', '--config', 'tools/stock-request-layout-eslint.config.mjs', '--max-warnings=0', ...own, 'tools/special-stock-check-editing-20261009/check.mjs', 'tools/special-stock-check-editing-20261009/coverage.mjs']);
    } finally { rmSync(baselineRoot, { recursive: true, force: true }); }
  }
  const focused = run('focused', ['--test', '--test-concurrency=1', ...own]);
  const reversedFiles = [...own].sort().reverse().map(file => run('reverse-' + file.split('/').at(-1), ['--test', file]));
  const reverse = { tests: reversedFiles.reduce((sum, result) => sum + result.tests, 0), pass: reversedFiles.reduce((sum, result) => sum + result.pass, 0), fail: 0, failures: [], skipped: 0, exit: 0 };
  if (mode === 'final') {
    const backorder = run('backorder-invariants', ['--test', '--test-concurrency=1', 'test/mbt/unit/backorder-workflow.test.js',
      'test/mbt/property/backorder-routing.property.test.js', 'test/mbt/integration/backorder-already-ordered.test.js'],
      { env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL.replace('mbbs-special-review-db', 'db') } });
    for (const name of ['coverage', 'c8']) { rmSync(`${out}/${name}`, { recursive: true, force: true }); }
    const measured = run('coverage-tests', ['/app/node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false', '--include=src/special-stock-request-repository.js', '--temp-directory=' + resolve(out + '/c8'), '--report-dir=' + resolve(out + '/coverage'), '--reporter=json', process.execPath, '--test', '--test-concurrency=1', ...own]);
    run('changed-coverage', ['tools/special-stock-check-editing-20261009/coverage.mjs']);
    const mutants = [
      { name: 'count-declines-as-unanswered', file: 'src/special-stock-request-repository.js', before: "(detail.workflowKind === 'backorder' || !['declined', 'closed'].includes(line.salesDecision))", after: '(true)', tests: [own[0]], pattern: '^property:', property: true },
      { name: 'keep-decline-after-revised-reply', file: 'src/special-stock-request-repository.js', before: 'if (reopeningDecline) {', after: 'if (false && reopeningDecline) {', tests: [own[0]], pattern: 'SCM revised decline' },
      { name: 'keep-stale-decline-restore', file: 'src/special-stock-request-repository.js', before: "sales_decision_reason='',sales_customer_note='',decline_restore='{}',\n      decision_revision=decision_revision + CASE WHEN sales_decision='declined' THEN 1 ELSE 0 END,", after: "sales_decision_reason='',sales_customer_note='',\n      decision_revision=decision_revision + CASE WHEN sales_decision='declined' THEN 1 ELSE 0 END,", tests: [own[0]], pattern: 'SCM revised decline' },
      { name: 'save-untouched-declines', file: 'public/scm-special-stock-requests.js', before: "line.salesDecision !== 'declined' || (canEditSpecialCaseLines(state.detail) && state.revisingDeclinedLineIds.has(line.id))", after: 'true', tests: [own[1]], pattern: 'saving another stock check' },
      { name: 'retain-abandoned-revision', file: 'public/scm-special-stock-requests.js', before: '    state.revisingDeclinedLineIds.clear();', after: '', tests: [own[1]], pattern: 'leaving an unsaved decline' },
      { name: 'grant-Sales-SCM-access', file: 'src/server.js', before: 'const granted = new Set(normalizedOperatorRoles(operator));', after: "const granted = new Set(normalizedOperatorRoles(operator));\n  if (granted.has('sales')) granted.add('scm');", tests: [own[0]], pattern: 'Sales and unauthenticated' }
    ];
    const mutations = [];
    for (const mutant of mutants) {
      const root = copyTree('stock-check-mutant-');
      try {
        const source = readFileSync(mutant.file, 'utf8');
        assert.equal(source.split(mutant.before).length, 2, mutant.name + ' must target exactly one expression');
        writeFileSync(`${root}/${mutant.file}`, source.replace(mutant.before, mutant.after));
        const result = run('mutation-' + mutant.name, ['--test', '--test-concurrency=1', '--test-name-pattern=' + mutant.pattern, ...mutant.tests], { cwd: root, red: true });
        mutations.push({ name: mutant.name, killed: result.fail > 0, propertyKilled: mutant.property === true });
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
    // Rehearse the reversible view change and independently kill the SQL stage mutant.
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    try {
      await client.connect();
      const original = readFileSync('migrations/275_request_completion_lookup.sql', 'utf8').split('CREATE OR REPLACE VIEW special_stock_workflow_stages AS')[1].split('-- Share one evidence')[0];
      await client.query('CREATE OR REPLACE VIEW special_stock_workflow_stages AS' + original);
      const result = run('mutation-SQL-count-declines', ['--test', '--test-name-pattern=^property:', own[0]], { red: true });
      mutations.push({ name: 'SQL-count-declines', killed: result.fail > 0, propertyKilled: true });
    } finally { await client.end(); await restoreView(); }
    run('secrets', ['test/support/scan-diff-secrets.mjs', ...JSON.parse(readFileSync('tools/special-stock-check-editing-20261009/files.json')), ...own, 'tools/special-stock-check-editing-20261009/check.mjs', 'tools/special-stock-check-editing-20261009/run.py']);
    resetDatabase('before-regression');
    regression = run('regression', ['--test', '--test-concurrency=1', ...special], { baseline: true });
    baseline = JSON.parse(readFileSync(existsSync(`${out}/baseline.json`) ? `${out}/baseline.json` : 'tools/special-stock-check-editing-20261009/baseline-results.json'));
    newFailures = regression.failures.filter(name => !baseline.failures.includes(name));
    assert.deepEqual(newFailures, []);
    // Failed historical fixtures must not leave flags or old view definitions in the focused fixture.
    resetDatabase('after-regression');
    const restored = run('restored', ['--test', '--test-concurrency=1', ...own]);
    const files = JSON.parse(readFileSync('tools/special-stock-check-editing-20261009/files.json'));
    const hashes = Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
    const withoutLog = result => { const { log: _log, ...summary } = result; return summary; };
    const toolVersions = Object.fromEntries(['typescript', 'eslint', 'c8', 'fast-check', '@playwright/test'].map(name => [name, JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version]));
    writeFileSync(`${out}/summary.json`, JSON.stringify({ focused: withoutLog(focused), reverse: withoutLog(reverse), backorder: withoutLog(backorder), measured: withoutLog(measured), restored: withoutLog(restored), regression: withoutLog(regression), baseline: withoutLog(baseline), newFailures, hashes, mutations, node: process.version, toolVersions }, null, 2));
  }
}
