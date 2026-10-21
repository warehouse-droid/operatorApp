import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, cpSync, symlinkSync, mkdtempSync, rmSync, openSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.equal(new URL(process.env.DATABASE_URL).hostname, 'mbbs-special-review-db');
assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED, 'false');
const out = 'test-artifacts/special-request-editing-20261006';
mkdirSync(out, { recursive: true });
const unit = 'test/mbt/unit/special-confirmed-note.test.js';
const http = 'test/mbt/integration/special-header-note-http.test.js';
const browser = 'test/mbt/integration/special-header-note-browser.test.js';
const mode = process.argv.at(-1);
const runtime = JSON.parse(readFileSync('tools/special-request-editing-20261006/files.json'));
const feeUnit='test/mbt/unit/special-delivery-fee.test.js';
const recoveryUnit='test/mbt/unit/special-zero-fee-recovery.test.js';
const longBrowser='test/mbt/integration/stock-request-long-scroll-browser.test.js';
const own=[unit,'test/mbt/unit/special-header-note.test.js',feeUnit,recoveryUnit,http,browser,
  'test/mbt/integration/special-delivery-fee-http.test.js','test/mbt/integration/special-delivery-fee-browser.test.js',
  longBrowser,'test/mbt/integration/stock-request-audit-scroll-browser.test.js'];
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
if(mode==='view') {
  const root=copyTree('mbbs-special-editing-view-baseline-');
  mkdirSync('test-artifacts/stocking-replies-20261006',{recursive:true});
  mkdirSync(root+'/test-artifacts/stocking-replies-20261006',{recursive:true});
  try {
    for(const file of runtime)writeFileSync(root+'/'+file,readFileSync('tools/special-request-editing-20261006/baseline/'+file));
    const args=['--test','test/mbt/integration/stock-request-view-browser.test.js'];
    const baseline=run('view-baseline',args,false,root,true);
    const candidate=run('view-candidate',args,false,process.cwd(),true);
    const newFailures=candidate.failures.filter(name=>!baseline.failures.includes(name));
    assert.deepEqual(newFailures,[]);
    writeFileSync(out+'/view-summary.json',JSON.stringify({baseline:baseline.counts,candidate:candidate.counts,
      baselineFailures:baseline.failures,candidateFailures:candidate.failures,newFailures},null,2));
  } finally {rmSync(root,{recursive:true,force:true});}
} else if(mode==='legacy-red') {
  run('legacy-red-recovery',['--test',recoveryUnit],true);
  run('legacy-red-claim',['--test','--test-name-pattern=legacy zero',http],true);
} else if(mode==='focused') {run('focused',['--test','--test-concurrency=1',...own]);
} else {
  const tests = ['unit', 'property', 'integration'].flatMap(kind => readdirSync(`test/mbt/${kind}`)
    .filter(name => /^special-.*\.test\.js$/.test(name)).sort().map(name => `test/mbt/${kind}/${name}`));
  tests.push(longBrowser,'test/mbt/integration/stock-request-audit-scroll-browser.test.js','test/mbt/unit/stock-request-view.test.js');
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
      for (const file of runtime) writeFileSync(`${baselineRoot}/${file}`, readFileSync(`tools/special-request-editing-20261006/baseline/${file}`));
      const oldTests = tests;
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
    const focused = run('coverage-focused', ['/app/node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false',
      ...runtime.filter(file => file.endsWith('.js')).map(file => `--include=${file}`), `--temp-directory=${out}/c8`,
      `--report-dir=${out}/coverage`, '--reporter=json', '--reporter=text', process.execPath,
      '--test', '--test-concurrency=1', ...own]);
    run('types', ['/app/node_modules/typescript/bin/tsc', '--noEmit', '--allowJs', '--checkJs', '--skipLibCheck', '--types', 'node',
      '--target', 'ES2022', '--module', 'NodeNext','public/special-stock-fulfillment.js','public/special-stock-delivery-fee.js']);
    const checkedJs=runtime.filter(file=>file.endsWith('.js'));
    const lintRoot=copyTree('mbbs-special-editing-lint-');
    try {
      for(const file of runtime)writeFileSync(lintRoot+'/'+file,readFileSync('tools/special-request-editing-20261006/baseline/'+file));
      const lintArgs=['/app/node_modules/eslint/bin/eslint.js','--config','tools/stock-request-layout-eslint.config.mjs','--format','json',...checkedJs];
      const oldLint=run('lint-before',lintArgs,false,lintRoot,true),newLint=run('lint-after',lintArgs,false,process.cwd(),true);
      const messages=log=>JSON.parse(log).flatMap(result=>result.messages.map(m=>JSON.stringify([result.filePath.replace(/^.*?\/public\//,'public/').replace(/^.*?\/src\//,'src/'),m.ruleId,m.severity,m.message])));
      const before=messages(oldLint.log),after=messages(newLint.log);
      const added=after.filter(message=>{const i=before.indexOf(message);if(i<0)return true;before.splice(i,1);return false;});
      writeFileSync(out+'/new-lint.json',JSON.stringify(added,null,2));assert.deepEqual(added,[]);
    } finally {rmSync(lintRoot,{recursive:true,force:true});}
    run('lint-tests',['/app/node_modules/eslint/bin/eslint.js','--config','tools/stock-request-layout-eslint.config.mjs','--max-warnings=0',...own,'tools/special-request-editing-20261006/check.mjs']);
    for (const file of runtime.filter(file => file.endsWith('.js'))) run('syntax-' + file.split('/').at(-1), ['--check', file]);
    const coverage = JSON.parse(readFileSync(`${out}/coverage/coverage-final.json`));
    const browserCoverage=['browser','fee-browser','scroll'].flatMap(folder=>readdirSync(`${out}/${folder}`).filter(file=>/^coverage-\d+\.json$/.test(file)).flatMap(file=>JSON.parse(readFileSync(`${out}/${folder}/${file}`))));
    const changed = [];
    for (const file of runtime.filter(file => file.endsWith('.js'))) {
      const diff = spawnSync('diff', ['-U0', `tools/special-request-editing-20261006/baseline/${file}`, file], { encoding: 'utf8' });
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
      {name:'leave-confirmed-note-lock',file:'src/special-stock-request-repository.js',before:'if (!canEditSpecialSalesInternalRemark(detail) || Object.keys(input)',after:'if (true || !canEditSpecialSalesInternalRemark(detail) || Object.keys(input)',tests:[http]},
      {name:'allow-terminal-note',file:'src/special-stock-request-repository.js',before:'!canEditSpecialSalesInternalRemark(detail) || Object.keys(input)',after:'Object.keys(input)',tests:[http]},
      {name:'show-zero-quote',file:'src/special-stock-documents.js',before:'if (deliveryRate > 0)',after:'if (deliveryRate != null)',tests:[feeUnit],property:true},
      {name:'keep-zero-so-draft',file:'src/special-stock-request-domain.js',before:'if (deliveryFeeRate > 0)',after:'if (deliveryFeeRate != null)',tests:[feeUnit],property:true},
      {name:'lock-desktop-page',file:'public/stock-requests.css',before:'body.scm-stock-requests-page { overflow: auto; }',after:'body.scm-stock-requests-page { overflow: hidden; }',tests:[longBrowser],pattern:'sales regular 1440x600'}
    ];
    const mutationResults = [];
    for (const mutant of mutations) {
      const source = readFileSync(mutant.file, 'utf8');
      assert.equal(source.split(mutant.before).length, 2, mutant.name + ' must target one expression');
      try {
        writeFileSync(`${mutationRoot}/${mutant.file}`, source.replace(mutant.before, mutant.after));
        run('mutation-' + mutant.name, ['--test', '--test-concurrency=1', ...(mutant.pattern ? ['--test-name-pattern='+mutant.pattern] : []), ...mutant.tests], true, mutationRoot);
        if (mutant.property) run('property-mutation-' + mutant.name, ['--test', '--test-name-pattern=^property:', feeUnit], true, mutationRoot);
        mutationResults.push({ name: mutant.name, killed: true, propertyKilled: mutant.property || false });
      } finally { writeFileSync(`${mutationRoot}/${mutant.file}`, source); }
    }
    const suiteHealth = run('suite-health', ['--test', '--test-concurrency=1', ...[...own].reverse()]);
    run('secrets', ['test/support/scan-diff-secrets.mjs', ...runtime, ...own,
      'tools/special-request-editing-20261006/check.mjs', 'tools/special-request-editing-20261006/run.py']);
    const manifest = Object.fromEntries([...runtime, ...own].map(file => [file, hash(readFileSync(file))]));
    const summary = { baseline: baseline.counts, baselineFailures: baseline.failures, regressions: regressions.counts, regressionFailures:regressions.failures,
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
