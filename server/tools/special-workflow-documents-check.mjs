import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import coverage from 'istanbul-lib-coverage';
import v8ToIstanbul from 'v8-to-istanbul';

const output = 'test-artifacts/special-workflow-review/quantity-documents';
assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.ok(process.env.DATABASE_URL?.endsWith('/mbt_verify'));
const runtime = JSON.parse(readFileSync(`${output}/runtime-files.json`));
const source = runtime.filter(file => file.endsWith('.js'));
const tests = ['unit','property','integration'].flatMap(kind => readdirSync(`test/mbt/${kind}`)
  .filter(name => /^special-(?:stock-request|workflow).*\.test\.js$/.test(name)).map(name => `test/mbt/${kind}/${name}`));
tests.push('test/mbt/unit/special-stock-rest-units.test.js','test/field-sales/company-pdf.test.js');
const ownTests = ['test/mbt/unit/special-workflow-quantity-transition.test.js','test/mbt/unit/special-workflow-documents.test.js',
  'test/mbt/integration/special-workflow-description-race.test.js','test/mbt/integration/special-workflow-pricing-http.test.js'];
function run(name, command, args, baseline = false) {
  const r = spawnSync(command, args, { encoding: 'utf8', timeout: 240000, maxBuffer: 20 * 1024 * 1024 });
  const log = (r.stdout || '') + (r.stderr || ''); writeFileSync(`${output}/${name}.txt`, log);
  if (r.status !== 0) {
    const failures = [...log.matchAll(/^not ok \d+ - (.+)$/gm)].map(m => m[1]);
    assert.ok(baseline && r.status === 1 && failures.length === 1
      && failures[0] === 'Dispatch save and restore require a route and Via Yard receipt without weakening snapshots'
      && log.includes('function dispatch_direct_to_has_residual(bigint) does not exist'), `${name} failed`);
  }
  const result = { check: name, exit: r.status, tests: Number(/^# tests (\d+)$/m.exec(log)?.[1] || 0), passed: Number(/^# pass (\d+)$/m.exec(log)?.[1] || 0) };
  console.log(JSON.stringify(result)); return result;
}
const suite = run('regressions', process.execPath, ['--test','--test-concurrency=1',...tests], true);
run('coverage', 'node_modules/.bin/c8', ['--all=false','--check-coverage=false',...source.map(f => `--include=${f}`),
  `--temp-directory=${output}/c8`,`--report-dir=${output}/coverage`,'--reporter=json',process.execPath,'--test','--test-concurrency=1',...tests], true);
const measured = coverage.createCoverageMap(JSON.parse(readFileSync(`${output}/coverage/coverage-final.json`)));
for (const name of readdirSync(output).filter(n => n.startsWith('browser-coverage-') && n.endsWith('.json'))) {
  for (const entry of JSON.parse(readFileSync(`${output}/${name}`))) {
    const file = `public/${new URL(entry.url).pathname.split('/').pop()}`, sourceText = readFileSync(file,'utf8');
    assert.equal(entry.source, sourceText, 'Browser source drift');
    const converter = v8ToIstanbul(resolve(file), 0, { source: sourceText });
    await converter.load(); converter.applyCoverage(entry.functions); measured.merge(converter.toIstanbul());
  }
}
const report = { covered: 0, total: 0, uncovered: [] };
let file;
for (const line of readFileSync(`${output}/runtime.diff`,'utf8').split('\n')) {
  if (line.startsWith('+++ b/server/')) file = line.slice('+++ b/server/'.length);
  const hunk = /^@@ .* \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!hunk || !source.includes(file)) continue;
  const lines = measured.fileCoverageFor(resolve(file)).getLineCoverage();
  const start = Number(hunk[1]), count = Number(hunk[2] ?? 1);
  for (let n = start; n < start + count; n++) {
    if (!Object.hasOwn(lines, n)) continue;
    report.total++; if (lines[n]) report.covered++; else report.uncovered.push(`${file}:${n}`);
  }
}
writeFileSync(`${output}/changed-lines.json`, JSON.stringify(report,null,2));
assert.deepEqual(report.uncovered, [], 'Changed runtime lines require coverage');
console.log(JSON.stringify({ changedLines: `${report.covered}/${report.total}` }));
run('types', 'node_modules/.bin/tsc', ['--noEmit','--allowJs','--checkJs','--skipLibCheck','--target','ES2022','--module','NodeNext','src/special-stock-quantity-reconciliation.js']);
for (const file of source) run(`syntax-${file.split('/').pop()}`, process.execPath, ['--check',file]);
run('lint','node_modules/.bin/eslint',['--config','tools/special-workflow-link-eslint.config.mjs','--max-warnings=0',...source.filter(f=>f!=='src/server.js'),...ownTests,'tools/special-workflow-documents-check.mjs','tools/special-workflow-documents-browser.mjs','tools/special-workflow-quantity-documents-live.mjs']);
const temporary = mkdtempSync('/app/.special-document-mutants-');
const mutants = [
  ['src/special-stock-quantity-reconciliation.js', "!['applying', 'attention'].includes(review.status || '')", 'false', ownTests[0]],
  ['src/special-stock-quantity-reconciliation.js', 'Number(order.id) === Number(orderId)', 'true', ownTests[0]],
  ['src/special-stock-quantity-reconciliation.js', 'change.toQuantity !== target', 'false', ownTests[0]],
  ['src/special-stock-quantity-reconciliation.js', 'review.remoteStarted !== true', 'false', ownTests[0]],
  ['src/special-stock-documents.js','specialLineSubtotal(quantity, unitRate, discount)','specialLineSubtotal(quantity, unitRate, 0)',ownTests[1]],
  ['src/special-stock-documents.js',"!sales && audience !== 'scm'",'false',ownTests[1]],
  ['src/special-stock-documents.js','if (cached) return','if (false) return',ownTests[2],'^document cache'],
  ['src/special-stock-documents.js','quantity: specialQuantity(line.quantity)','quantity: 1',ownTests[1]],
  ['src/special-stock-request-repository.js','...reviewedQuantityTransitions(quantityReview, orderKind, remoteOrderId, expectedLines)','...[]',ownTests[2],'^issued quantity confirmation']
];
const killed = [];
try {
  for (const [i,[target,before,after,testFile,pattern]] of mutants.entries()) {
    const absolute = resolve(target), mutated = `${temporary}/mutated.mjs`;
    const imports = (content, from) => content.replace(/from (['"])(\.[^'"]+)\1/g, (_full, quote, name) => {
      const path = resolve(dirname(from),name); return `from ${quote}file://${path === absolute ? mutated : path}${quote}`;
    });
    const content = readFileSync(target,'utf8'); assert.equal(content.split(before).length,2,'Unique mutant anchor');
    writeFileSync(mutated,imports(content.replace(before,after),absolute));
    writeFileSync(`${temporary}/contract.test.mjs`,imports(readFileSync(testFile,'utf8'),resolve(testFile)));
    // Bare test dependencies resolve through /app/node_modules from this directory.
    const r = spawnSync(process.execPath,['--test',...(pattern ? [`--test-name-pattern=${pattern}`] : []),`${temporary}/contract.test.mjs`],{ encoding:'utf8',timeout:60000,maxBuffer:10*1024*1024 });
    const log = (r.stdout||'')+(r.stderr||''); writeFileSync(`${output}/mutant-${i+1}.txt`,log);
    assert.equal(r.status,1,`Surviving mutant ${i+1}`); assert.match(log,/not ok \d+ -/); assert.doesNotMatch(log,/ERR_MODULE_NOT_FOUND|SyntaxError/);
    killed.push({ target, killed:true });
  }
} finally { rmSync(temporary,{recursive:true,force:true}); }
writeFileSync(`${output}/mutations.json`,JSON.stringify(killed,null,2)); console.log(JSON.stringify({ mutationsKilled:killed.length }));
// Re-run the changed integration boundaries in reverse order to detect leaked state.
run('suite-health',process.execPath,['--test','--test-concurrency=1',...ownTests.toReversed()]);
const files = [...runtime,...ownTests,'test/mbt/unit/special-stock-request-wiring.red.test.js','tools/special-workflow-documents-check.mjs','tools/special-workflow-documents-browser.mjs',
  'tools/special-workflow-quantity-documents-live.mjs','tools/special-workflow-documents-cache-live.mjs','tools/special-workflow-documents-render.py','tools/special-workflow-documents-deploy.py',
  'test/special-workflow-quantity-documents-spec.md'];
run('secrets',process.execPath,['test/support/scan-diff-secrets.mjs',...files]);
writeFileSync(`${output}/source-manifest.json`,JSON.stringify(Object.fromEntries(files.map(f=>[f,createHash('sha256').update(readFileSync(f)).digest('hex')])),null,2));
const summary = { completed:true, tests:suite.tests, passed:suite.passed, knownBaselineFailures:1, changedLineCoverage:`${report.covered}/${report.total}`, mutationsKilled:killed.length,
  browser:JSON.parse(readFileSync(`${output}/browser.json`)), types:'Strict JS check for quantity transition boundary; syntax/lint and executable contracts for document modules' };
writeFileSync(`${output}/summary.json`,JSON.stringify(summary,null,2)); console.log(JSON.stringify(summary));
