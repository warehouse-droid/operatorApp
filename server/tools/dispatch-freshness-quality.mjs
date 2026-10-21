import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import coverageLibrary from 'istanbul-lib-coverage';
import v8ToIstanbul from 'v8-to-istanbul';
import { parse } from 'espree';
import { isolatedRun } from './dispatch-source-decision-checks.mjs';
const { createCoverageMap } = coverageLibrary;

function run(name, args, options = {}) {
  const result = spawnSync('node', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 240000, ...options });
  writeFileSync(`test-artifacts/${name}.log`, result.stdout + result.stderr);
  return result;
}
const mode = process.argv[2] || 'all';
if (mode === 'all') {
  rmSync('test-artifacts/v8', { recursive: true, force: true });
  rmSync('test-artifacts/freshness-browser/verified', { recursive: true, force: true });
  assert.equal((await isolatedRun('tools/dispatch-consistency-mutant.mjs', { prefix: 'freshness-negative-control' })).exit, 0, 'stale observer negative control');
  assert.equal(run('regressions', ['tools/dispatch-freshness-checks.mjs', 'final']).status, 0, 'regressions');
  assert.equal(run('full-day', ['--test', 'test/dispatch/frontend/dispatch-full-day.browser.test.mjs']).status, 0, 'full-day replay');
}
if (mode !== 'preflight') assert.equal(run('mutations', ['tools/dispatch-freshness-mutations.mjs']).status, 0, 'mutations');

const temporary = mkdtempSync('/tmp/dispatch-freshness-types-');
try {
  const before = '/workspace/server/test-artifacts/dispatch-freshness-20261019/before';
  for (const name of ['src', 'public', 'package.json']) cpSync(`${before}/${name}`, `${temporary}/${name}`, { recursive: true });
  symlinkSync('/app/node_modules', `${temporary}/node_modules`);
  const args = ['/app/node_modules/typescript/bin/tsc', '--noEmit', '--allowJs', '--checkJs', '--skipLibCheck',
    '--types', 'node', '--target', 'ES2022', '--module', 'NodeNext', 'src/dispatch-sales-resplit-repository.js', 'src/dispatch-planner-optimization.js', 'src/dispatch-order-catalog-repository.js', 'src/sor-rental-policy.js'];
  const messages = output => output.split('\n').filter(line => /error TS\d+/u.test(line)).map(line => line.replace(/\(\d+,\d+\)/u, ''));
  const old = run('types-before', args, { cwd: temporary });
  const current = run('types-after', args);
  assert.ok([0, 1, 2].includes(old.status) && [0, 1, 2].includes(current.status), 'type checks must finish');
  const remaining = messages(old.stdout);
  const added = messages(current.stdout).filter(message => {
    const index = remaining.indexOf(message);
    if (index < 0) return true;
    remaining.splice(index, 1); return false;
  });
  writeFileSync('test-artifacts/types.json', JSON.stringify({ baseline: messages(old.stdout).length, current: messages(current.stdout).length, added }, null, 2));
  assert.deepEqual(added, [], 'new type errors');
} finally { rmSync(temporary, { recursive: true, force: true }); }
if (mode === 'preflight') process.exit(0);

const sources = JSON.parse(readFileSync('test-artifacts/changed-lines.json', 'utf8'));
const report = run('coverage', ['node_modules/c8/bin/c8.js', 'report', '--all=false', '--check-coverage=false',
  '--temp-directory=test-artifacts/v8', '--reports-dir=test-artifacts/freshness-coverage', '--reporter=json',
  ...sources.map(row => `--include=${row.file}`)]);
assert.equal(report.status, 0, 'coverage conversion');
const coverage = createCoverageMap(JSON.parse(readFileSync('test-artifacts/freshness-coverage/coverage-final.json', 'utf8')));
// Legacy VM tests use synthetic snippets named dispatch.js; their wrapper
// counts cannot establish execution of the real browser program.
coverage.filter(path => !path.endsWith('/public/dispatch.js'));
for (const file of readdirSync('test-artifacts/v8').filter(file => file.endsWith('.json'))) {
  for (const entry of JSON.parse(readFileSync(`test-artifacts/v8/${file}`, 'utf8')).result || []) {
    if (!entry.url.startsWith('dispatch-freshness-vm:')) continue;
    const path = entry.url.slice('dispatch-freshness-vm:'.length);
    const source = readFileSync(path, 'utf8');
    const converter = v8ToIstanbul(`/app/${path}`, 0, { source });
    await converter.load();
    // Only actual extracted function ranges establish coverage. Padded text
    // around each function is never counted as executed implementation.
    converter.applyCoverage([{ functionName: '', isBlockCoverage: true,
      ranges: [{ startOffset: 0, endOffset: source.length, count: 0 }] }, ...entry.functions.slice(1)]);
    coverage.merge(converter.toIstanbul());
  }
}
const browser = 'test-artifacts/freshness-browser/verified';
for (const file of readdirSync(browser).filter(file => file.endsWith('-coverage.json'))) coverage.merge(JSON.parse(readFileSync(`${browser}/${file}`, 'utf8')));
writeFileSync('test-artifacts/freshness-coverage/merged.json', JSON.stringify(coverage.toJSON()));
const changedCoverage = sources.map(row => {
  const file = coverage.files().find(path => path.endsWith(`/${row.file}`));
  const lines = file ? coverage.fileCoverageFor(file).getLineCoverage() : {};
  const tokens = parse(readFileSync(row.file, 'utf8'), { ecmaVersion: 'latest', sourceType: row.file.startsWith('public/') ? 'script' : 'module', tokens: true, loc: true }).tokens;
  const codeLines = new Set(tokens.filter(token => token.type !== 'Punctuator').map(token => token.loc.start.line));
  const executable = row.lines.filter(line => codeLines.has(line) && Object.hasOwn(lines, line));
  const missing = executable.filter(line => lines[line] === 0);
  return { ...row, executable: executable.length, covered: executable.length - missing.length, missing };
});
writeFileSync('test-artifacts/changed-line-coverage.json', JSON.stringify(changedCoverage, null, 2));
const versions = Object.fromEntries(['@playwright/test', 'fast-check', 'typescript', 'eslint', 'c8'].map(name => [name, JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')).version]));
writeFileSync('test-artifacts/toolchain.json', JSON.stringify({ node: process.version, ...versions }, null, 2));
assert.ok(existsSync('test-artifacts/mutations.json'));
console.log(JSON.stringify(changedCoverage.map(({ file, executable, covered, missing }) => ({ file, executable, covered, missing }))));
assert.ok(changedCoverage.every(row => row.executable > 0 && row.missing.length === 0), 'changed executable lines must be covered');
