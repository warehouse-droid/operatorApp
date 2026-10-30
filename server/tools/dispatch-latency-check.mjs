import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { ESLint } from 'eslint';
import coverage from 'istanbul-lib-coverage';

const root = resolve('test-artifacts/dispatch-latency');
mkdirSync(root, { recursive: true });
const files = ['src/server.js', 'src/order-dependency-repository.js', 'src/dispatch-completion-repository.js',
  'src/dispatch-history-mode.js', 'src/scm-reconciliation-repository.js'];
const latency = 'test/dispatch/integration/dispatch-latency.test.mjs';
const regressions = [
  'test/dispatch/integration/order-dependency-multi-to-extension.red.test.js',
  'test/dispatch/integration/scm-search-vendor-completion.test.js',
  'test/mbt/integration/dispatch-completion-status.red.test.js',
  'test/dispatch/integration/dispatch-reconciliation-completed-planning.red.test.js',
  'test/dispatch/integration/scm-manual-split-authority.red.test.js',
  'test/dispatch/integration/direct-linked-po-group-lifecycle.test.js',
  'test/dispatch/integration/scm-po-split-editing.test.js',
  'test/dispatch/integration/dispatch-v2-snapshot-performance.red.test.js',
  'test/dispatch/integration/dispatch-driver-completion-split-isolation.red.test.js',
  'test/dispatch/frontend/dispatch-source-refresh.test.js',
  'test/dispatch/frontend/dispatch-save-reliability.test.js',
  'test/dispatch/frontend/dispatch-source-decision.test.js',
  'test/dispatch/property/dispatch-source-refresh.property.test.js',
  'test/dispatch/property/dispatch-save-reliability.test.js',
  'test/dispatch/integration/dispatch-source-decision.test.js',
  'test/dispatch/integration/dispatch-save-reliability.test.js',
  'test/dispatch/frontend/dispatch-notice-stability.browser.test.mjs',
  'test/dispatch/frontend/dispatch-freshness-races.test.js',
  'test/dispatch/frontend/group-hydration-concurrency.test.js'
];
const results = [];
const coverageDirectories = [];
const baselineFailures = [];
async function run(name, tests, { cwd = process.cwd(), covered = false, pattern = '', killed = false, baselineCheck = false } = {}) {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  const url = new URL(process.env.DATABASE_URL);
  const template = url.pathname.slice(1);
  assert.match(template, /^[a-zA-Z0-9_]+$/u);
  const database = `latency_${process.pid}_${name.replaceAll(/[^a-z0-9]/gu, '_')}`;
  const admin = new URL(url); admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.href });
  const report = `${root}/${name}-coverage`;
  try {
    await client.connect();
    await client.query(`CREATE DATABASE "${database}" TEMPLATE "${template}"`);
    url.pathname = '/' + database;
    const testArgs = ['--test', '--test-concurrency=1', ...(pattern ? ['--test-name-pattern=' + pattern] : []), ...tests];
    const args = covered ? ['node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false', '--reporter=json', `--reports-dir=${report}`,
      `--temp-directory=${root}/${name}-v8`, ...files.map(file => '--include=' + file), 'node', ...testArgs] : testArgs;
    const result = spawnSync(process.execPath, args, { cwd, env: { ...process.env, DATABASE_URL: url.href },
      encoding: 'utf8', maxBuffer: 24 * 1024 * 1024, timeout: 180000 });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    writeFileSync(`${root}/${name}.log`, output);
    const summary = { name, status: result.status,
      failures: [...output.matchAll(/^not ok \d+ - (.+)$/gmu)].map(match => match[1]),
      ...Object.fromEntries([...output.matchAll(/^# (tests|pass|fail|skipped) (\d+)$/gmu)].map(match => [match[1], Number(match[2])])) };
    console.log(JSON.stringify(summary));
    for (const line of output.split('\n').filter(textLine => /browserLatency|latencySample/.test(textLine))) { console.log(line); }
    if ((!killed && result.status !== 0) || (killed && result.status !== 1)) { console.log(output.slice(-14000)); }
    if (killed) {
      assert.ok(result.status === 1 && /not ok/u.test(output) && !/hookFailed|SyntaxError|Cannot find module/u.test(output), `invalid or surviving mutant: ${name}`);
    } else {
      if (!baselineCheck) { assert.equal(result.status, 0, `failed suite: ${name}`); }
      if (!name.startsWith('baseline-')) { results.push(summary); }
      if (covered) { coverageDirectories.push(report); }
    }
    return { output, summary };
  } finally {
    await client.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => null);
    await client.end();
  }
}

async function compareSnapshotBaseline(candidate) {
  const stage = `${root}/baseline`;
  try {
    for (const dir of ['src', 'public']) { cpSync(`/baseline-source/${dir}`, `${stage}/${dir}`, { recursive: true }); }
    cpSync('test', `${stage}/test`, { recursive: true });
    cpSync('package.json', `${stage}/package.json`);
    symlinkSync(resolve('node_modules'), `${stage}/node_modules`, 'dir');
    const previous = await run('baseline-snapshot', [regressions[7]], { cwd: stage, baselineCheck: true });
    assert.equal(previous.summary.status, candidate.summary.status);
    assert.deepEqual(candidate.summary.failures, previous.summary.failures, 'no new baseline failures');
    assert.equal(candidate.summary.failures.length, 1);
    for (const result of [candidate, previous]) { assert.match(result.output, /assert\.ok\(replacement\.responseBytes < 250_000\)/u); }
    baselineFailures.push({ file: regressions[7], failures: candidate.summary.failures, reason: 'replacement.responseBytes < 250_000 fails on the deployed baseline too' });
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

async function quality() {
  const checked = [...files, latency, 'tools/dispatch-latency-check.mjs', 'tools/dispatch-latency-read.mjs', 'tools/dispatch-latency-eslint.config.mjs'];
  const linter = new ESLint({ overrideConfigFile: 'tools/dispatch-latency-eslint.config.mjs' });
  let inherited = 0;
  let newFindings = 0;
  for (const file of checked) {
    assert.equal(spawnSync(process.execPath, ['--check', file]).status, 0, file);
    const source = readFileSync(file, 'utf8');
    const messages = async text => (await linter.lintText(text, { filePath: file }))[0].messages.map(row => ({ ...row,
      key: `${row.ruleId}:${row.message.replace(/on line \d+ column \d+/gu, 'on original declaration')}:${text.split('\n')[row.line - 1]?.trim()}` }));
    const before = existsSync(`/baseline-source/${file}`) ? await messages(readFileSync(`/baseline-source/${file}`, 'utf8')) : [];
    const current = await messages(source);
    const added = current.filter(row => !before.some(old => old.key === row.key));
    inherited += current.length - added.length;
    if (added.length) { console.log(JSON.stringify({ file, added: added.map(({ line, ruleId, message }) => ({ line, ruleId, message })) })); }
    newFindings += added.length;
  }
  assert.equal(newFindings, 0, 'new lint findings');
  console.log(JSON.stringify({ syntaxFiles: checked.length, newLint: 0, inheritedLint: inherited }));
}

async function mutations() {
  const stage = `${root}/mutations`;
  const changes = [
    ['assignments', 'src/server.js', 'listDispatchPlanOrderAssignmentsProjection({ includeSnapshots, orderRefs })', 'listDispatchPlanOrderAssignmentsProjection({ includeSnapshots })', 'one local order'],
    ['dependencies', 'src/order-dependency-repository.js', 'loadDependencies({ orderRefs }),', 'loadDependencies(),', 'group members retain'],
    ['group-members', 'src/scm-reconciliation-repository.js', '...groupMembersResult.rows.map((member) => member.order_ref)', '', 'SCM groups retain'],
    ['completion-correction', 'src/dispatch-completion-repository.js', "event.order_kind = 'PO' AND EXISTS", 'false AND EXISTS', 'matches the canonical'],
    ['completion-priority', 'src/dispatch-completion-repository.js', 'dispatch_completion_evidence_priority(event.completion_evidence_type),', 'dispatch_completion_evidence_priority(event.completion_evidence_type) DESC,', 'matches the canonical'],
    ['physical-completion', 'src/dispatch-history-mode.js', "refKey(completion.completionEvidenceType) !== 'reconciliation'", 'false', 'preserves canonical priority']
  ];
  try {
    for (const dir of ['src', 'public', 'test']) { cpSync(dir, `${stage}/${dir}`, { recursive: true }); }
    cpSync('package.json', `${stage}/package.json`);
    symlinkSync(resolve('node_modules'), `${stage}/node_modules`, 'dir');
    for (const [name, file, before, after, pattern] of changes) {
      const source = readFileSync(`${stage}/${file}`, 'utf8');
      assert.equal(source.split(before).length, 2, `unique mutant: ${name}`);
      try {
        writeFileSync(`${stage}/${file}`, source.replace(before, after));
        await run('mutant-' + name, [latency], { cwd: stage, pattern, killed: true });
      } finally { writeFileSync(`${stage}/${file}`, source); }
    }
    console.log(JSON.stringify({ mutantsKilled: changes.length, propertyOnlyMutants: ['completion-correction', 'completion-priority'] }));
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

function changedCoverage() {
  const map = coverage.createCoverageMap({});
  for (const dir of coverageDirectories) { map.merge(JSON.parse(readFileSync(`${dir}/coverage-final.json`))); }
  const changed = JSON.parse(readFileSync('test/dispatch/support/dispatch-latency-changed-lines.json'));
  const report = [];
  for (const file of files) {
    const lines = map.fileCoverageFor(resolve(file)).getLineCoverage();
    const executable = changed[file].filter(line => Object.hasOwn(lines, line));
    const missing = executable.filter(line => !lines[line]);
    report.push({ file, covered: executable.length - missing.length, executable: executable.length, missing });
  }
  console.log(JSON.stringify({ changedLineCoverage: report }));
  for (const row of report) { assert.equal(row.missing.length, 0, `unexecuted changed lines: ${row.file}`); }
}

const phase = process.argv[2] || 'all';
if (phase === 'quality') { await quality(); }
if (phase === 'mutations') { await mutations(); }
if (phase === 'all') {
  await quality();
  await run('latency', [latency], { covered: true });
  for (const [index, file] of regressions.entries()) {
    const result = await run('regression-' + index, [file], { covered: true, baselineCheck: index === 7 });
    if (index === 7 && result.summary.status !== 0) { await compareSnapshotBaseline(result); }
  }
  await run('reverse-order', [...regressions.slice(9, 14)].reverse());
  await mutations();
  changedCoverage();
  console.log(JSON.stringify({ passed: true, tests: results.reduce((sum, row) => sum + row.pass, 0), baselineFailures,
    runtimeHashes: Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')])),
    versions: { node: process.version, ...Object.fromEntries(['eslint', 'c8', '@playwright/test', 'pg'].map(name => [name, JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version])) } }));
}
