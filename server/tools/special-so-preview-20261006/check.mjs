import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, cpSync, symlinkSync, mkdtempSync, rmSync, openSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.equal(new URL(process.env.DATABASE_URL).hostname, 'mbbs-special-review-db');
assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED, 'false');
const out = 'test-artifacts/special-so-preview-20261006';
mkdirSync(out, { recursive: true });
const unit = 'test/mbt/unit/special-so-unitless-verification.test.js';
const http = 'test/mbt/integration/special-header-note-http.test.js';
const browser = 'test/mbt/integration/special-header-note-browser.test.js';
const mode = process.argv.at(-1);
const runtime = ['src/special-stock-rest-orders.js', 'src/special-stock-request-repository.js',
  'public/special-stock-fulfillment.js', 'public/sales-special-stock-requests.js', 'public/sales-stock-requests.html'];
const hash = value => createHash('sha256').update(value).digest('hex');
const countsFor = log => Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key => [key, Number(log.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] || 0)]));
const failuresFor = log => [...log.matchAll(/^not ok \d+ - (.+?)(?: # SKIP.*?)?$/gm)]
  .filter(match => !match[0].includes(' # SKIP')).map(match => match[1].replace(/^.*?(?=\/test\/mbt\/)/, ''));
function run(label, args, red = false, cwd = process.cwd(), allowBaseline = false) {
  const logPath = resolve(`${out}/${label}.log`), fd = openSync(logPath, 'w');
  let result;
  try { result = spawnSync(process.execPath, args, { cwd, timeout: 600000, stdio: ['ignore', fd, fd] }); }
  finally { closeSync(fd); }
  const log = readFileSync(logPath, 'utf8'), counts = countsFor(log);
  console.log(JSON.stringify({ label, exit: result.status, ...counts }));
  if (red) {
    assert.ok(result.status === 1 && counts.fail > 0, `${label}: regression must fail on behavior`);
    assert.ok(!log.includes("failureType: 'hookFailed'"), `${label}: setup failures are not regression evidence`);
  }
  else if (!allowBaseline) assert.equal(result.status, 0, `${label}: ${log.slice(-2200)}`);
  assert.notEqual(result.status, null, `${label} timed out`);
  const failures = failuresFor(log);
  return { counts, failures, status: result.status, log };
}
function copyTree(prefix) {
  const root = mkdtempSync('/tmp/' + prefix);
  for (const folder of ['src', 'public', 'test']) cpSync(folder, `${root}/${folder}`, { recursive: true });
  for (const folder of ['node_modules', 'tools', 'migrations', 'contracts']) symlinkSync(resolve(folder), `${root}/${folder}`);
  for (const file of readdirSync('.').filter(name => name.endsWith('.js') || name === 'package.json')) cpSync(file, `${root}/${file}`);
  return root;
}
if (mode === 'red') {
  run('red-unit', ['--test', unit], true);
  run('red-http', ['--test', '--test-name-pattern=pickup-to-delivery header persists|invalid fee and stale|legacy blank header fees', http], true);
  run('red-browser', ['--test', '--test-name-pattern=pickup-to-delivery header shows|header fee survives', browser], true);
} else if (mode === 'focused') {
  run('focused', ['--test', '--test-concurrency=1', unit, http, browser]);
} else {
  const tests = ['unit', 'property', 'integration'].flatMap(kind => readdirSync(`test/mbt/${kind}`)
    .filter(name => /^special-.*\.test\.js$/.test(name)).sort().map(name => `test/mbt/${kind}/${name}`));
  let baselineRoot;
  const mutationRoot = copyTree('mbbs-special-preview-mutation-');
  let candidateRoot;
  try {
    let baseline;
    if (['finish', 'audit'].includes(mode)) {
      const log = readFileSync(`${out}/baseline-special.log`, 'utf8');
      baseline = { counts: countsFor(log), failures: failuresFor(log) };
    } else {
      baselineRoot = copyTree('mbbs-special-preview-baseline-');
      for (const file of runtime) writeFileSync(`${baselineRoot}/${file}`, readFileSync(`tools/special-so-preview-20261006/baseline/${file}`));
      const oldTests = tests.filter(file => file !== unit);
      baseline = run('baseline-special', ['--test', '--test-concurrency=1', ...oldTests], false, baselineRoot, true);
      rmSync(baselineRoot, { recursive: true, force: true }); baselineRoot = undefined;
      // Failed legacy fixtures do not share a database with the candidate.
      run('reset-test-db', ['--input-type=module', '-e', `import pg from 'pg';
        const url=new URL(process.env.DATABASE_URL);if(url.hostname!=='mbbs-special-review-db'||url.pathname!=='/mbt_verify')throw Error('Not isolated');
        url.pathname='/mbt_test';const client=new pg.Client({connectionString:url.href});
        try{await client.connect();await client.query('DROP DATABASE mbt_verify WITH (FORCE)');await client.query('CREATE DATABASE mbt_verify');}finally{await client.end();}`]);
      run('candidate-migrate', ['src/migrate.js']);
    }
    let regressions;
    if (mode === 'audit') {
      const log = readFileSync(`${out}/special-regressions-final.log`, 'utf8');
      regressions = { counts: countsFor(log), failures: failuresFor(log) };
    } else {
      candidateRoot = copyTree('mbbs-special-preview-candidate-');
      regressions = run('special-regressions-final', ['--test', '--test-concurrency=1', ...tests], false, candidateRoot, true);
    }
    const newFailures = regressions.failures.filter(name => !baseline.failures.includes(name));
    writeFileSync(`${out}/new-failures.json`, JSON.stringify(newFailures, null, 2));
    assert.deepEqual(newFailures, [], 'New Special workflow failures');
    if (candidateRoot) rmSync(candidateRoot, { recursive: true, force: true }); candidateRoot = undefined;
    run('coverage-focused', ['/app/node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false',
      ...runtime.filter(file => file.endsWith('.js')).map(file => `--include=${file}`), `--temp-directory=${out}/c8`,
      `--report-dir=${out}/coverage`, '--reporter=json', '--reporter=text', process.execPath,
      '--test', '--test-concurrency=1', unit, http, browser, 'test/mbt/unit/special-header-note.test.js']);
    const focused = run('focused-final', ['--test', '--test-concurrency=1', unit, http, browser]);
    run('types', ['/app/node_modules/typescript/bin/tsc', '--noEmit', '--allowJs', '--checkJs', '--skipLibCheck', '--types', 'node',
      '--target', 'ES2022', '--module', 'NodeNext', runtime[0], runtime[2]]);
    run('lint', ['/app/node_modules/eslint/bin/eslint.js', '--config', 'tools/special-so-preview-20261006/eslint.config.mjs', '--max-warnings=0',
      ...runtime.filter(file => file.endsWith('.js')), unit, http, browser, 'tools/special-so-preview-20261006/check.mjs']);
    for (const file of runtime.filter(file => file.endsWith('.js'))) run('syntax-' + file.split('/').at(-1), ['--check', file]);
    const coverage = JSON.parse(readFileSync(`${out}/coverage/coverage-final.json`));
    const browserCoverage = readdirSync(`${out}/browser`).filter(file => /^coverage-\d+\.json$/.test(file))
      .flatMap(file => JSON.parse(readFileSync(`${out}/browser/${file}`)));
    const changed = [];
    for (const file of runtime.filter(file => file.endsWith('.js'))) {
      const diff = spawnSync('diff', ['-U0', `tools/special-so-preview-20261006/baseline/${file}`, file], { encoding: 'utf8' });
      const entry = Object.values(coverage).find(value => value.path.endsWith('/' + file));
      const source = readFileSync(file, 'utf8');
      const clientEntries = browserCoverage.filter(value => new URL(value.url).pathname === '/' + file.replace(/^public\//, '') && value.source === source);
      assert.ok(entry || clientEntries.length, 'Missing coverage ' + file);
      let line = 0;
      for (const value of diff.stdout.split('\n')) {
        const hunk = value.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunk) line = Number(hunk[1]);
        else if (value.startsWith('+') && !value.startsWith('+++')) {
          const statements = entry ? Object.entries(entry.statementMap).filter(([, statement]) => statement.start.line <= line && statement.end.line >= line) : [];
          const offset = source.split('\n').slice(0, line - 1).reduce((sum, text) => sum + text.length + 1, 0);
          const clientHit = clientEntries.some(value => value.functions.some(fn => {
            const ranges = fn.ranges.filter(range => range.startOffset <= offset && range.endOffset > offset).sort((a, b) => (a.endOffset - a.startOffset) - (b.endOffset - b.startOffset));
            return ranges[0]?.count > 0;
          }));
          if (statements.length) {
            assert.ok(statements.some(([key]) => entry.s[key] > 0) || clientHit, `Uncovered changed line ${file}:${line}`);
            changed.push(`${file}:${line}`);
          } else if (file.startsWith('public/') && value.trim() && !/^\+\s*(?:\/\/|\*|[};]+\s*$)/.test(value)) {
            assert.ok(clientHit, `Uncovered browser change ${file}:${line}`); changed.push(`${file}:${line}`);
          }
          line++;
        }
      }
    }
    const mutations = [
      { name: 'unitless-comparison', file: runtime[0], before: 'actual.unitId !== (unit == null ? null : Number(unit))', after: 'actual.unitId !== Number(unit)', tests: [unit], property: true },
      { name: 'ignore-material-uom', file: runtime[0], before: 'actual.unitId !== (unit == null ? null : Number(unit))', after: 'false', tests: [unit], property: true },
      { name: 'ignore-price', file: runtime[0], before: 'actual.rate !== String(line.rate)', after: 'false', tests: [unit], property: true },
      { name: 'omit-draft-fee', file: runtime[1], before: 'await updateEditedCaseDeliveryFee(id, target.deliveryFeeRate, savedOrderLines, false);', after: 'await Promise.resolve();', tests: [http] },
      { name: 'omit-fee-field', file: runtime[2], before: '${header ? `<label><span>Delivery fee rate', after: '${false && header ? `<label><span>Delivery fee rate', tests: [browser] }
    ];
    const mutationResults = [];
    for (const mutant of mutations) {
      const source = readFileSync(mutant.file, 'utf8');
      assert.equal(source.split(mutant.before).length, 2, mutant.name + ' must target one expression');
      try {
        writeFileSync(`${mutationRoot}/${mutant.file}`, source.replace(mutant.before, mutant.after));
        run('mutation-' + mutant.name, ['--test', '--test-concurrency=1', ...mutant.tests], true, mutationRoot);
        if (mutant.property) run('property-mutation-' + mutant.name, ['--test', '--test-name-pattern=^property:', unit], true, mutationRoot);
        mutationResults.push({ name: mutant.name, killed: true, propertyKilled: mutant.property || false });
      } finally { writeFileSync(`${mutationRoot}/${mutant.file}`, source); }
    }
    const suiteHealth = run('suite-health', ['--test', '--test-concurrency=1', browser, http, unit]);
    run('secrets', ['test/support/scan-diff-secrets.mjs', ...runtime, unit, http, browser,
      'tools/special-so-preview-20261006/check.mjs', 'tools/special-so-preview-20261006/run.py']);
    const manifest = Object.fromEntries([...runtime, unit, http, browser].map(file => [file, hash(readFileSync(file))]));
    const summary = { baseline: baseline.counts, baselineFailures: baseline.failures, regressions: regressions.counts,
      newFailures, focused: focused.counts, types: 'pass', lint: 'pass', mutations: mutationResults,
      changedLines: { total: changed.length, covered: changed.length, lines: changed }, suiteHealth: suiteHealth.counts, manifest,
      toolVersions: { node: process.version, ...Object.fromEntries(['typescript', 'eslint', 'c8', 'fast-check', '@playwright/test']
        .map(name => [name, JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version])) } };
    writeFileSync(`${out}/summary.json`, JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary));
  } finally {
    for (const root of [baselineRoot, candidateRoot, mutationRoot].filter(Boolean)) rmSync(root, { recursive: true, force: true });
  }
}
