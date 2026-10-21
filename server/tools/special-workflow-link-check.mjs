import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.ok(process.env.DATABASE_URL?.endsWith('/mbt_verify'));
const output = 'test-artifacts/special-workflow-review/so-po-native';
mkdirSync(output, { recursive: true });
const runtime = JSON.parse(readFileSync(`${output}/runtime-files.json`));
const source = runtime.filter(f => f.startsWith('src/'));
const ownTests = ['test/mbt/unit/special-workflow-description-race.test.js', 'test/mbt/integration/special-workflow-description-race.test.js',
  'test/mbt/unit/special-workflow-reviewed-so.test.js', 'test/mbt/unit/special-workflow-native-po.test.js', 'test/mbt/unit/special-workflow-native-service.test.js'];
const tests = ['unit', 'property', 'integration'].flatMap(kind => readdirSync(`test/mbt/${kind}`)
  .filter(name => /^special-(?:stock-request|workflow).*\.test\.js$/.test(name)).map(name => `test/mbt/${kind}/${name}`));
tests.push('test/mbt/unit/special-stock-rest-units.test.js');
const knownFailure = 'Dispatch save and restore require a route and Via Yard receipt without weakening snapshots';
function run(name, command, args, { baseline = false } = {}) {
  const r = spawnSync(command, args, { encoding: 'utf8', timeout: 180000, maxBuffer: 12 * 1024 * 1024 });
  const log = (r.stdout || '') + (r.stderr || '');
  writeFileSync(`${output}/${name}.txt`, log);
  if (r.status !== 0) {
    const failures = [...log.matchAll(/^not ok \d+ - (.+)$/gm)].map(m => m[1]);
    assert.ok(baseline && r.status === 1 && failures.length === 1 && failures[0] === knownFailure
      && log.includes('function dispatch_direct_to_has_residual(bigint) does not exist'), `${name} failed; see ${output}/${name}.txt`);
  }
  const result = { layer: name, exit: r.status, knownBaselineFailure: r.status !== 0,
    tests: Number(/^# tests (\d+)$/m.exec(log)?.[1] || 0), pass: Number(/^# pass (\d+)$/m.exec(log)?.[1] || 0) };
  console.log(JSON.stringify(result));
  return result;
}
const suite = run('tests', process.execPath, ['--test', '--test-concurrency=1', ...tests], { baseline: true });
run('coverage', 'node_modules/.bin/c8', ['--all=false', '--check-coverage=false', ...source.map(f => `--include=${f}`),
  `--temp-directory=${output}/c8`, `--report-dir=${output}/coverage`, '--reporter=json', '--reporter=json-summary', '--reporter=text',
  process.execPath, '--test', '--test-concurrency=1', ...tests], { baseline: true });
const coverage = JSON.parse(readFileSync(`${output}/coverage/coverage-final.json`, 'utf8'));
const diffText = readFileSync(`${output}/runtime.diff`, 'utf8');
assert.ok(diffText.includes('special-stock-native-po-adapter.js'));
let file;
const checked = [], uncovered = [];
for (const line of diffText.split('\n')) {
  if (line.startsWith('+++ b/server/')) file = line.slice('+++ b/server/'.length);
  const hunk = /^@@ .* \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!hunk || !source.includes(file)) continue;
  const report = coverage[resolve(file)];
  assert.ok(report, `Missing coverage for ${file}`);
  const start = Number(hunk[1]), count = Number(hunk[2] ?? 1);
  for (let n = start; n < start + count; n++) {
    const hits = Object.entries(report.statementMap).filter(([, m]) => m.start.line <= n && m.end.line >= n).map(([key]) => report.s[key]);
    if (hits.length) { checked.push(`${file}:${n}`); if (!hits.some(h => h > 0)) uncovered.push(`${file}:${n}`); }
  }
}
writeFileSync(`${output}/changed-lines.json`, JSON.stringify({ covered: checked.length - uncovered.length, total: checked.length, uncovered }, null, 2));
assert.deepEqual(uncovered, [], 'Uncovered changed lines');
run('types', 'node_modules/.bin/tsc', ['--noEmit', '--allowJs', '--checkJs', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', 'src/special-stock-native-po-adapter.js', 'src/special-stock-netsuite-adapter.js']);
for (const f of runtime) run(`syntax-${f.split('/').pop()}`, process.execPath, ['--check', f]);
run('lint', 'node_modules/.bin/eslint', ['--config', 'tools/special-workflow-link-eslint.config.mjs', '--max-warnings=0', ...runtime, ...ownTests, 'tools/special-workflow-link-check.mjs', 'tools/special-workflow-native-link.mjs', 'tools/special-workflow-description-recover.mjs', 'tools/special-workflow-link-live.mjs']);
const temporary = mkdtempSync('/app/.special-link-mutants-');
const mutants = [
  ['src/special-stock-request-domain.js', 'Boolean(reviewedDescription) && tupleMatches', 'false && tupleMatches', ownTests[0], true],
  ['src/special-stock-netsuite-adapter.js', 'quantity: change.quantity, units:', 'quantity: change.previousQuantity, units:', ownTests[2], true],
  ['src/special-stock-netsuite-adapter.js', 'units: String(id(change.unitId))', 'units: String(id(change.previousUnitId))', ownTests[2], true],
  ['src/special-stock-native-po-adapter.js', "line: id(line.line), createPo: { id: 'SpecOrd' }", "line: id(line.line) + 1, createPo: { id: 'SpecOrd' }", ownTests[3], true],
  ['src/special-stock-native-po-adapter.js', 'poRate: Number(item.rate)', 'poRate: 17', ownTests[3], true],
  ['src/special-stock-native-po-adapter.js', 'if (plan.purchaseOrderId) return result', 'if (false) return result', ownTests[3], true],
  ['src/special-stock-request-repository.js', 'Number(row.revision) < expectedRevision(revision)', 'false', ownTests[1], false],
  ['src/special-stock-request-service.js', 'return await deps.linkPurchaseOrder', 'return deps.linkPurchaseOrder', ownTests[0], false]
];
try {
  writeFileSync(`${temporary}/package.json`, '{"type":"module"}');
  symlinkSync('/app/node_modules', `${temporary}/node_modules`);
  const results = [];
  for (const [index, [target, before, after, testFile, propertyOnly]] of mutants.entries()) {
    for (const f of source) {
      let content = readFileSync(f, 'utf8');
      if (f === target) { assert.equal(content.split(before).length, 2, `Mutant anchor ${index + 1}`); content = content.replace(before, after); }
      content = content.replace(/from (["'])\.\/([^"']+)\1/g, (full, quote, name) => source.includes(`src/${name}`) ? full : `from ${quote}file:///app/src/${name}${quote}`)
        .replace(/from (["'])\.\.\/public\/([^"']+)\1/g, (_full, quote, name) => `from ${quote}file:///app/public/${name}${quote}`);
      // Relative dynamic imports in the facade must also use the isolated adapter.
      content = content.replace(/import\((["'])\.\/([^"']+)\1\)/g, (full, quote, name) => source.includes(`src/${name}`) ? full : `import(${quote}file:///app/src/${name}${quote})`);
      writeFileSync(`${temporary}/${f.split('/').pop()}`, content);
    }
    const content = readFileSync(testFile, 'utf8').replace(/(['"])\.\.\/\.\.\/\.\.\/src\/([^'"]+)\1/g,
      (_full, quote, name) => `${quote}file://${source.includes(`src/${name}`) ? temporary : '/app/src'}/${name}${quote}`);
    writeFileSync(`${temporary}/contract.test.mjs`, content);
    const r = spawnSync(process.execPath, ['--test', ...(propertyOnly ? ['--test-name-pattern=^property:'] : []), `${temporary}/contract.test.mjs`], { encoding: 'utf8', timeout: 60000 });
    const log = (r.stdout || '') + (r.stderr || '');
    writeFileSync(`${output}/mutant-${index + 1}.txt`, log);
    assert.equal(r.status, 1, `Surviving mutant ${index + 1}`);
    assert.match(log, propertyOnly ? /Property failed/ : /not ok \d+ -/);
    assert.doesNotMatch(log, /ERR_MODULE_NOT_FOUND|SyntaxError/);
    results.push({ mutant: index + 1, target, propertyOnly, killed: true });
  }
  writeFileSync(`${output}/mutations.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ mutantsKilled: results.length, propertyOnly: results.filter(r => r.propertyOnly).length }));
} finally { rmSync(temporary, { recursive: true, force: true }); }
let state = 26092034;
const shuffled = [...tests];
for (let i = shuffled.length - 1; i > 0; i--) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; const j = state % (i + 1); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
for (const [index, f] of shuffled.entries()) run(`shuffled-${index + 1}`, process.execPath, ['--test', f], { baseline: true });
const files = [...runtime, ...ownTests, 'test/mbt/integration/special-workflow-review.test.js', 'test/mbt/unit/special-workflow-order-sync.test.js',
  'test/mbt/unit/special-stock-request-service.red.test.js', 'tools/special-workflow-link-check.mjs', 'tools/special-workflow-link-eslint.config.mjs',
  'tools/special-workflow-description-recover.mjs', 'tools/special-workflow-native-link.mjs', 'tools/special-workflow-link-live.mjs',
  'tools/special-workflow-link-deploy.py', 'tools/special-workflow-link-check.sh', 'test/special-workflow-description-race-spec.md'];
run('secrets', process.execPath, ['test/support/scan-diff-secrets.mjs', ...files]);
writeFileSync(`${output}/source-manifest.json`, JSON.stringify(Object.fromEntries(files.map(f => [f, createHash('sha256').update(readFileSync(f)).digest('hex')])), null, 2));
writeFileSync(`${output}/versions.json`, JSON.stringify({ node: process.version, ...Object.fromEntries(['c8', 'typescript', 'eslint', 'fast-check'].map(name => [name, JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version])) }, null, 2));
const summary = { completed: true, tests: suite.tests, passed: suite.pass, changedLineCoverage: `${checked.length}/${checked.length}`, knownBaselineFailures: 1, mutationsKilled: mutants.length };
writeFileSync(`${output}/summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
