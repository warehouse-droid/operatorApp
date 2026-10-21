import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, openSync, closeSync, cpSync, symlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.equal(new URL(process.env.DATABASE_URL).hostname, 'mbbs-special-review-db');
const out = 'test-artifacts/special-shared-orders-20261009', task = 'tools/special-shared-orders-20261009';
mkdirSync(out, { recursive: true });
const mode = process.argv.at(-1);
const own = ['test/mbt/integration/special-shared-orders.test.js'];
const js = ['src/special-stock-request-repository.js', 'src/server.js'];
const regressionFiles = ['unit', 'property', 'integration'].flatMap(kind => readdirSync(`test/mbt/${kind}`)
  .filter(name => /^special-.*\.test\.js$/.test(name) && name !== 'special-shared-orders.test.js').sort()
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
  assert.notEqual(result.status, null, `${label} timed out`);
  if (red) { assert.equal(result.status, 1); assert.ok(counts.fail > 0 && !log.includes("failureType: 'hookFailed'"), 'RED must fail on behavior'); }
  else if (!baseline) { assert.equal(result.status, 0, `${label}: ${log.slice(-3500)}`); }
  return { exit: result.status, ...counts, failures };
}
function copyTree(prefix) {
  const root = mkdtempSync('/tmp/' + prefix);
  for (const folder of ['src', 'public', 'test']) { cpSync(folder, `${root}/${folder}`, { recursive: true }); }
  for (const folder of ['node_modules', 'tools', 'migrations']) { symlinkSync(resolve(folder), `${root}/${folder}`); }
  for (const file of ['package.json', 'netsuite-smart-scm-picking-ticket-restlet.js']) { cpSync(file, `${root}/${file}`); }
  return root;
}
function resetDatabase(label) {
  run(label + '-db', ['--input-type=module', '-e', "import pg from 'pg';const url=new URL(process.env.DATABASE_URL);if(url.hostname!=='mbbs-special-review-db'||url.pathname!=='/mbt_verify')throw Error('Not isolated');url.pathname='/mbt_test';const client=new pg.Client({connectionString:url.href});try{await client.connect();await client.query('DROP DATABASE mbt_verify WITH (FORCE)');await client.query('CREATE DATABASE mbt_verify');}finally{await client.end();}"]);
  run(label + '-migrate', ['src/migrate.js']);
}
if (mode === 'red') {
  writeFileSync(`${out}/red.json`, JSON.stringify(run('red', ['--test', '--test-concurrency=1', ...own], { red: true }), null, 2));
} else if (mode === 'baseline') {
  const root = copyTree('shared-orders-baseline-');
  try {
    for (const file of [...js, 'test/mbt/integration/special-manual-so-link.test.js']) { cpSync(`${task}/baseline/${file}`, `${root}/${file}`); }
    writeFileSync(`${out}/baseline-snapshot.json`, JSON.stringify({ root, captured: new Date().toISOString() }));
    writeFileSync(`${out}/baseline.json`, JSON.stringify(run('baseline', ['--test', '--test-concurrency=1', ...regressionFiles], { baseline: true, cwd: root }), null, 2));
  } finally { rmSync(root, { recursive: true, force: true }); }
} else if (mode === 'green') {
  run('green', ['--test', '--test-concurrency=1', ...own, 'test/mbt/integration/special-manual-so-link.test.js']);
} else if (mode === 'final') {
  const focused = run('focused', ['--test', '--test-concurrency=1', ...own, 'test/mbt/integration/special-manual-so-link.test.js']);
  run('migration-rehearsal', [`${task}/migration.mjs`]);
  const staticRoot = copyTree('shared-orders-static-');
  let staticResults;
  try {
    for (const file of js) { cpSync(`${task}/baseline/${file}`, `${staticRoot}/${file}`); }
    const args = ['/app/node_modules/typescript/bin/tsc', '--noEmit', '--allowJs', '--checkJs', '--skipLibCheck', '--types', 'node', '--target', 'ES2022', '--module', 'NodeNext'];
    const before = run('types-before', [...args, ...js], { cwd: staticRoot, baseline: true });
    const after = run('types-after', [...args, ...js], { baseline: true });
    const messages = text => text.split('\n').filter(line => /error TS\d+/.test(line)).map(line => line.replace(/\(\d+,\d+\)/, ''));
    const old = messages(readFileSync(`${out}/types-before.log`, 'utf8'));
    const added = messages(readFileSync(`${out}/types-after.log`, 'utf8')).filter(line => { const index = old.indexOf(line); if (index < 0) { return true; } old.splice(index, 1); return false; });
    assert.deepEqual(added, []);
    const { ESLint } = await import('eslint');
    const lint = new ESLint({ overrideConfigFile: resolve('tools/special-workflow-eslint.config.mjs') });
    const newLint = [];
    for (const file of js) {
      const previous = (await lint.lintText(readFileSync(`${staticRoot}/${file}`, 'utf8'), { filePath: file }))[0].messages.map(message => JSON.stringify([message.ruleId, message.severity, message.message]));
      const next = (await lint.lintText(readFileSync(file, 'utf8'), { filePath: file }))[0].messages.map(message => JSON.stringify([message.ruleId, message.severity, message.message]));
      for (const message of next) { const index = previous.indexOf(message); if (index < 0) { newLint.push({ file, message }); } else { previous.splice(index, 1); } }
      run('syntax-' + file.split('/').at(-1), ['--check', file]);
    }
    assert.deepEqual(newLint, []);
    staticResults = { typesBefore: before.exit, typesAfter: after.exit, newTypes: added, newLint };
    writeFileSync(`${out}/static.json`, JSON.stringify(staticResults, null, 2));
    run('lint-tests', ['/app/node_modules/eslint/bin/eslint.js', '--config', 'tools/special-workflow-eslint.config.mjs', '--max-warnings=0', ...own, `${task}/check.mjs`, `${task}/migration.mjs`]);
  } finally { rmSync(staticRoot, { recursive: true, force: true }); }
  resetDatabase('coverage');
  const measured = run('coverage-tests', ['/app/node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false', ...js.map(file => '--include=' + file),
    '--temp-directory=' + resolve(out + '/c8'), '--report-dir=' + resolve(out + '/coverage'), '--reporter=json', process.execPath, '--test', '--test-concurrency=1', ...own]);
  const measuredJson = JSON.parse(readFileSync(`${out}/coverage/coverage-final.json`));
  const changedLines = [], uncovered = [];
  for (const file of js) {
    const diff = spawnSync('diff', ['-U0', `${task}/baseline/${file}`, file], { encoding: 'utf8' });
    assert.ok([0, 1].includes(diff.status));
    const entry = Object.values(measuredJson).find(value => value.path.endsWith('/' + file));
    assert.ok(entry, file + ' coverage missing');
    let line = 0;
    for (const text of diff.stdout.split('\n')) {
      const hunk = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) { line = Number(hunk[1]); }
      else if (text.startsWith('+') && !text.startsWith('+++')) {
        const statements = Object.entries(entry.statementMap).filter(([, statement]) => statement.start.line <= line && statement.end.line >= line);
        if (statements.length) { changedLines.push(`${file}:${line}`); if (!statements.some(([key]) => entry.s[key] > 0)) { uncovered.push(`${file}:${line}`); } }
        line++;
      }
    }
  }
  writeFileSync(`${out}/changed-coverage.json`, JSON.stringify({ changedLines, uncovered }, null, 2));
  assert.deepEqual(uncovered, []);
  const mutants = [
    { name: 'only-first-shared-case', file: js[0], before: 'for (const row of match.rows)', after: 'for (const row of match.rows.slice(0, 1))', pattern: '^property:' },
    { name: 'repeat-shared-case', file: js[0], before: 'for (const row of match.rows)', after: 'for (const row of [...match.rows, match.rows[0]])', pattern: '^property:' },
    { name: 'hide-reconciliation-attention', file: js[0], before: 'attention: cases.some(result => result.attention)', after: 'attention: cases.every(result => result.attention)', pattern: 'reconciliation mismatch' },
    { name: 'allow-case-so-replacement', file: js[0], before: "if (special.sales_order_netsuite_id && Number(special.sales_order_netsuite_id) !== remoteId) throw", after: 'if (false) throw', pattern: 'replacement guards' },
    { name: 'po-sharing-regression', database: "DROP INDEX idx_sales_special_stock_po_owner; CREATE UNIQUE INDEX idx_sales_special_stock_po_owner ON sales_special_stock_cases(purchase_order_netsuite_id) WHERE purchase_order_netsuite_id IS NOT NULL AND workflow_kind='special';", pattern: 'share an existing PO' },
    { name: 'remove-yard-scope', file: js[0], before: 'assertScope(mapCase(special), authorizedStoreLocationIds);\n    assertSpecialStockRemoteOrderAllowed(mapCase(special), {manualReference:manual});', after: 'assertSpecialStockRemoteOrderAllowed(mapCase(special), {manualReference:manual});', pattern: 'role authorization' },
    { name: 'break-single-case-result', file: js[0], before: 'return { matched: true, requestId, attention:', after: 'return { matched: true, requestId: requestId + 1, attention:', pattern: 'single-case webhook' }
  ];
  const mutations = [];
  for (const mutant of mutants) {
    resetDatabase('mutant-' + mutant.name);
    const root = copyTree('shared-orders-mutant-');
    try {
      if (mutant.file) {
        const source = readFileSync(mutant.file, 'utf8'); assert.equal(source.split(mutant.before).length, 2, mutant.name);
        writeFileSync(`${root}/${mutant.file}`, source.replace(mutant.before, mutant.after));
      } else { run('mutant-index', ['--input-type=module', '-e', "import pg from 'pg';const c=new pg.Client({connectionString:process.env.DATABASE_URL});try{await c.connect();await c.query(" + JSON.stringify(mutant.database) + ");}finally{await c.end();}"]); }
      const killed = run('mutant-' + mutant.name, ['--test', '--test-name-pattern=' + mutant.pattern, ...own], { red: true, cwd: root });
      mutations.push({ name: mutant.name, killed: killed.fail > 0, propertyOnly: mutant.pattern === '^property:' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  resetDatabase('regression');
  const backorder = run('backorder-invariants', ['--test', '--test-concurrency=1', 'test/mbt/unit/backorder-workflow.test.js',
    'test/mbt/property/backorder-link-sequence.property.test.js', 'test/mbt/integration/backorder-requests.test.js'],
  { env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL.replace('mbbs-special-review-db', 'db') } });
  resetDatabase('after-backorder');
  const regression = run('regression', ['--test', '--test-concurrency=1', ...regressionFiles], { baseline: true });
  const baseline = JSON.parse(readFileSync(`${out}/baseline.json`));
  const newFailures = regression.failures.filter(name => !baseline.failures.includes(name));
  assert.deepEqual(newFailures, []);
  resetDatabase('restored');
  const restored = run('restored', ['--test', '--test-concurrency=1', ...own]);
  const suiteHealth = run('suite-health-manual', ['--test', 'test/mbt/integration/special-manual-so-link.test.js']);
  const files = [...js, 'migrations/278_special_shared_orders.sql', ...own, 'test/mbt/integration/special-manual-so-link.test.js', 'test/mbt/integration/backorder-requests.test.js',
    'test/mbt/integration/special-custom-po-http.test.js',
    ...['SPEC.json', 'run.py', 'check.mjs', 'migration.mjs', 'render.py', 'image-check.mjs', 'image-tests.py', 'release.py'].map(file => `${task}/${file}`)];
  run('secrets', ['test/support/scan-diff-secrets.mjs', ...files]);
  const hashes = Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
  const toolVersions = Object.fromEntries(['typescript', 'eslint', 'c8', 'fast-check'].map(name => [name, JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version]));
  writeFileSync(`${out}/summary.json`, JSON.stringify({ focused, measured, restored, suiteHealth, backorder, regression, baseline, newFailures, mutations, changedLines: changedLines.length,
    staticResults, hashes, node: process.version, toolVersions, specApproval: 'not obtained (autonomous run)',
    skipped: { wholeApplicationSuite: 'Complete Special feature suite used; unrelated application suites omitted.', supplyChainAudit: 'No dependency changes.', complexity: 'Existing per-case logic is retained; new orchestration functions are small.' } }, null, 2));
}
