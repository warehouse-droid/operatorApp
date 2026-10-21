import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.ok(process.env.DATABASE_URL?.endsWith('/mbt_verify'));
const output = 'test-artifacts/special-workflow-review/rest-units';
mkdirSync(output, { recursive: true });
const runtime = ['src/special-stock-request-netsuite.js', 'src/special-stock-netsuite-adapter.js', 'src/special-stock-quantity-adapter.js'];
const testFile = 'test/mbt/unit/special-stock-rest-units.test.js';
const tests = ['unit', 'property', 'integration'].flatMap(kind => readdirSync(`test/mbt/${kind}`)
  .filter(name => /^special-(?:stock-request|workflow).*\.test\.js$/.test(name)).map(name => `test/mbt/${kind}/${name}`));
tests.push(testFile);
const knownFailure = 'Dispatch save and restore require a route and Via Yard receipt without weakening snapshots';
function run(name, command, args, { baseline = false } = {}) {
  const r = spawnSync(command, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 12 * 1024 * 1024 });
  const log = (r.stdout || '') + (r.stderr || '');
  writeFileSync(`${output}/${name}.txt`, log);
  if (r.status !== 0) {
    const failures = [...log.matchAll(/^not ok \d+ - (.+)$/gm)].map(m => m[1]);
    assert.ok(baseline && r.status === 1 && failures.length === 1 && failures[0] === knownFailure
      && log.includes('function dispatch_direct_to_has_residual(bigint) does not exist'), `${name} failed; see ${output}/${name}.txt`);
  }
  console.log(JSON.stringify({ layer: name, exit: r.status, knownBaselineFailure: r.status !== 0,
    tests: Number(/^# tests (\d+)$/m.exec(log)?.[1] || 0), pass: Number(/^# pass (\d+)$/m.exec(log)?.[1] || 0) }));
  return log;
}
run('tests', process.execPath, ['--test', '--test-concurrency=1', ...tests], { baseline: true });
const focused = [testFile, ...tests.filter(f => /unit\/(special-stock-request-(netsuite|service)|special-workflow-(adapter|quantity-adapter|deploy-readiness))/.test(f))];
run('coverage', 'node_modules/.bin/c8', ['--all=false', ...runtime.map(f => `--include=${f}`),
  `--temp-directory=${output}/c8`, `--report-dir=${output}/coverage`, '--reporter=json', '--reporter=json-summary', '--reporter=text',
  process.execPath, '--test', ...focused]);
const coverage = JSON.parse(readFileSync(`${output}/coverage/coverage-final.json`, 'utf8'));
const diff = spawnSync('git', ['diff', '--unified=0', '--', ...runtime.map(f => `server/${f}`)], { cwd: '..', encoding: 'utf8' });
// The test runner may not mount Git. Use the recorded pre-change source when
// supplied by the host, rather than inferring which lines changed from coverage.
const diffText = process.env.SPECIAL_UNITS_DIFF ? readFileSync(process.env.SPECIAL_UNITS_DIFF, 'utf8') : diff.stdout;
assert.ok(diffText.includes('special-stock-request-netsuite.js'), 'Provide the scoped runtime diff');
let file;
const checked = [];
for (const line of diffText.split('\n')) {
  if (line.startsWith('+++ b/server/')) file = line.slice('+++ b/server/'.length);
  const hunk = /^@@ .* \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!hunk) continue;
  const report = coverage[resolve(file)];
  const start = Number(hunk[1]), count = Number(hunk[2] ?? 1);
  for (let n = start; n < start + count; n++) {
    const hits = Object.entries(report.statementMap).filter(([, m]) => m.start.line <= n && m.end.line >= n).map(([id]) => report.s[id]);
    if (hits.length) { assert.ok(hits.some(h => h > 0), `Uncovered changed line ${file}:${n}`); checked.push(`${file}:${n}`); }
  }
}
assert.ok(checked.length > 0);
writeFileSync(`${output}/changed-lines.json`, JSON.stringify({ covered: checked.length, total: checked.length, lines: checked }, null, 2));
run('types', 'node_modules/.bin/tsc', ['--noEmit', '--allowJs', '--checkJs', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', ...runtime.slice(1)]);
run('syntax-payload', process.execPath, ['--check', runtime[0]]);
run('lint', 'node_modules/.bin/eslint', ['--config', 'tools/special-workflow-eslint.config.mjs', '--max-warnings=0', ...runtime, testFile, 'tools/special-stock-units-check.mjs', 'tools/special-stock-units-retry.mjs']);
const temporary = mkdtempSync('/app/.special-units-mutants-');
const mutants = [
  [runtime[0], 'payload.units = String(line.unitId)', 'payload.units = reference(line.unitId)'],
  [runtime[1], "typeof units === 'object' ? units?.id : units", "typeof units === 'object' ? units?.id : undefined"],
  [runtime[1], "typeof units === 'object' ? units?.id : units", "typeof units === 'object' ? undefined : units"],
  [runtime[1], "String(specialRestUnitId(current[0].units) || '') !== String(specialRestUnitId(previous.units) || '')", 'false'],
  [runtime[2], 'unitId: unitId ? id(unitId) : null', 'unitId: null'],
  [runtime[2], 'unitId: unitId ? id(unitId) : null', 'unitId: id(unitId)'],
  [runtime[0], 'item: reference(line.itemId),\n    location: reference(netsuiteLocationId),', 'item: reference(line.itemId),']
];
try {
  writeFileSync(`${temporary}/package.json`, '{"type":"module"}');
  symlinkSync('/app/node_modules', `${temporary}/node_modules`);
  const result = [];
  for (const [index, [target, before, after]] of mutants.entries()) {
    for (const f of runtime) {
      let source = readFileSync(f, 'utf8');
      if (f === target) { assert.equal(source.split(before).length, 2); source = source.replace(before, after); }
      source = source.replace(/from (["'])\.\/([^"']+)\1/g, (full, quote, name) => runtime.includes(`src/${name}`) ? full : `from ${quote}file:///app/src/${name}${quote}`);
      writeFileSync(`${temporary}/${f.split('/').pop()}`, source);
    }
    const source = readFileSync(testFile, 'utf8').replaceAll('../../../src/', `file://${temporary}/`);
    writeFileSync(`${temporary}/property.test.mjs`, source);
    const r = spawnSync(process.execPath, ['--test', '--test-name-pattern=^property:', `${temporary}/property.test.mjs`], { encoding: 'utf8' });
    writeFileSync(`${output}/mutant-${index + 1}.txt`, r.stdout + r.stderr);
    assert.equal(r.status, 1, `Surviving mutant ${index + 1}`);
    assert.match(r.stdout, /Property failed/);
    result.push({ mutant: index + 1, target, killedByPropertySuite: true });
  }
  writeFileSync(`${output}/mutations.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ mutationsKilled: result.length, propertyOnly: true }));
} finally { rmSync(temporary, { recursive: true, force: true }); }
let state = 26092026;
const shuffled = [...tests];
for (let i = shuffled.length - 1; i > 0; i--) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; const j = state % (i + 1); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
for (const [index, f] of shuffled.entries()) run(`shuffled-${index + 1}`, process.execPath, ['--test', f], { baseline: true });
run('secrets', process.execPath, ['test/support/scan-diff-secrets.mjs', ...runtime, testFile, 'tools/special-stock-units-check.mjs']);
const files = [...runtime, testFile, 'tools/special-stock-units-check.mjs', 'tools/special-stock-units-retry.mjs', 'test/special-stock-units-spec.md'];
writeFileSync(`${output}/source-manifest.json`, JSON.stringify(Object.fromEntries(files.map(f => [f, createHash('sha256').update(readFileSync(f)).digest('hex')])), null, 2));
writeFileSync(`${output}/versions.json`, JSON.stringify({ node: process.version, ...Object.fromEntries(['c8', 'typescript', 'eslint', 'fast-check'].map(name => [name, JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version])) }, null, 2));
const summary = { completed: true, changedLineCoverage: `${checked.length}/${checked.length}`, knownBaselineFailures: 1 };
writeFileSync(`${output}/summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
