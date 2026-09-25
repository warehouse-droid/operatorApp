import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mutants } from '../test/support/dispatch-save-mutations.mjs';
import { withCoTestDatabase } from '../test/support/co-direct-to-isolation.mjs';

const directory = 'test-artifacts/dispatch-save-reliability';
await mkdir(directory, { recursive: true });
const runtimeFiles = [
  'src/dispatch-plan-fence.js', 'src/dispatch-plan-write.js', 'src/dispatch-plan-lease-repository.js',
  'src/dispatch-plan-repository.js', 'src/dispatch-planner-performance.js', 'src/dispatch-planner-v2-repository.js',
  'src/scm-dependency-preview-service.js', 'src/scm-dependency-command-service.js', 'src/scm-dependency-plan-reconciler.js', 'src/dispatch-delivery-group-repository.js', 'src/server.js',
  'public/dispatch.js', 'public/dispatch-save-journal.js', 'public/dispatch-snapshot.js', 'public/dispatch.css'
];
const hash = data => createHash('sha256').update(data).digest('hex');
const sources = Object.fromEntries(await Promise.all(runtimeFiles.map(async file => [file, hash(await readFile(file))])));
const frontend = ['test/dispatch/frontend/dispatch-save-reliability.test.js', 'test/dispatch/frontend/dispatch-save-snapshot.test.js'];
const properties = ['test/dispatch/property/dispatch-save-reliability.test.js', 'test/dispatch/property/dispatch-save-digest-compatibility.test.js', 'test/dispatch/property/dispatch-save-projection-identity.test.js'];
const focused = [...frontend, ...properties, 'test/dispatch/unit/dispatch-save-compaction.test.js', 'test/dispatch/integration/dispatch-save-reliability.test.js'];
async function run(name, args, { env = {}, fail = false } = {}) {
  const execute = databaseUrl => spawnSync(process.execPath, args, { env: { ...process.env, ...env, DATABASE_URL: databaseUrl },
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 600000 });
  const result = await withCoTestDatabase(`save-${name}`, execute);
  assert.equal(result.error, undefined, `${name}: did not execute`);
  const output = result.stdout + result.stderr;
  await writeFile(`${directory}/${name}.log`, output);
  if (fail) {
    assert.notEqual(result.status, 0, `${name}: mutant survived`);
    assert.match(output, /Property failed after|ERR_ASSERTION/);
    assert.doesNotMatch(output, /Invalid mutation anchor|ERR_MODULE_NOT_FOUND|SyntaxError/);
  } else assert.equal(result.status, 0, `${name}: ${output.slice(-4000)}`);
  console.log(JSON.stringify({ check: name, exitCode: result.status }));
}
await run('focused-coverage', ['node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false',
  ...runtimeFiles.filter(f => f.endsWith('.js')).map(f => `--include=${f}`),
  `--report-dir=${directory}/coverage`, `--temp-directory=${directory}/v8`, '--reporter=text', '--reporter=json',
  'node', '--test', '--test-concurrency=1', ...focused]);
const kills = [];
for (const name of Object.keys(mutants)) {
  const args = ['--experimental-loader', './test/support/dispatch-save-mutations.mjs', '--test', '--test-concurrency=1'];
  const options = { env: { DISPATCH_SAVE_MUTANT: name }, fail: true };
  await run(`mutant-${name}`, [...args, ...focused], options);
  await run(`property-mutant-${name}`, [...args, ...properties], options);
  kills.push(name);
}
await run('focused-reversed', ['--test', '--test-concurrency=1', ...focused.toReversed()]);
for (const file of runtimeFiles.filter(f => f.endsWith('.js'))) await run(`syntax-${file.replaceAll('/', '-')}`, ['--check', file]);
for (const file of runtimeFiles) assert.equal(hash(await readFile(file)), sources[file], `${file}: source changed during checks`);
const coverage = JSON.parse(await readFile(`${directory}/coverage/coverage-final.json`, 'utf8'));
const changedCoverage = {};
for (const file of runtimeFiles.filter(f => f.endsWith('.js'))) {
  const baseline = `${directory}/baseline/${file}`;
  const before = await readFile(baseline).then(() => baseline).catch(() => '/dev/null');
  const diff = spawnSync('diff', ['-U0', before, file], { encoding: 'utf8' }).stdout;
  const changed = [];
  for (const match of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    for (let n = 0; n < Number(match[2] ?? 1); n++) changed.push(Number(match[1]) + n);
  }
  const entry = Object.values(coverage).find(e => e.path.endsWith(`/${file}`));
  const uncovered = changed.filter(line => !entry || !Object.entries(entry.statementMap).some(([id, span]) => span.start.line <= line && span.end.line >= line && entry.s[id] > 0));
  changedCoverage[file] = { changed: changed.length, uncovered };
}
await writeFile(`${directory}/checks.json`, JSON.stringify({ sources, kills, propertyKills: kills, changedCoverage,
  completedAt: new Date().toISOString(), node: process.version }, null, 2));
console.log(JSON.stringify({ kills, changedCoverage }));
