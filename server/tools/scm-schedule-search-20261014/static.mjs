import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { ESLint } from 'eslint';
import { scanUnifiedDiff } from '../../test/support/scan-diff-secrets.mjs';

const out = '/app/test-artifacts/scm-schedule-search-20261014';
const runtime = ['src/scm-order-visibility.js', 'src/server.js', 'src/dispatch-repository.js', 'public/scm-schedule.js'];
const added = ['test/dispatch/frontend/scm-schedule-search.test.js',
  'test/mbt/integration/scm-schedule-search.test.js', 'test/mbt/unit/scm-schedule-search-policy.test.js',
  'tools/scm-schedule-search-20261014/check.mjs', 'tools/scm-schedule-search-20261014/static.mjs',
  'tools/scm-schedule-search-20261014/mutations.mjs'];
const browserGlobals = Object.fromEntries(['scmScheduleLoading', 'scmScheduleOperator', 'scmScheduleFilters',
  'scmScheduleFilterPreferenceKey', 'saveLocalScmScheduleFilterPreference', 'renderScmSchedule', 'localStorage'].map((name) => [name, 'readonly']));
const types = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--project', 'tsconfig.mbt.json', '--noEmit'],
  { cwd: '/app', encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180000,
    env: { ...process.env, GOMAXPROCS: '2', GOMEMLIMIT: '512MiB', GOGC: '40' } });
await writeFile(`${out}/all-types.log`, (types.stdout || '') + (types.stderr || ''));
assert.ok(types.signal === null && (types.status === 0
  || ([1, 2].includes(types.status) && /error TS\d+/.test(types.stdout || '')
    && !/Error: Command failed/.test(types.stderr || ''))), 'TypeScript did not complete');
const messages = (log) => log.split('\n').filter((line) => /error TS\d+/.test(line)).map((line) => line.replace(/\(\d+,\d+\)/, ''));
const oldTypes = messages(await readFile(`${out}/baseline-types.log`, 'utf8'));
const newTypes = [];
const currentTypes = messages(types.stdout || '');
for (const message of currentTypes) {
  const index = oldTypes.indexOf(message);
  if (index < 0) newTypes.push(message);
  else oldTypes.splice(index, 1);
}
const lint = new ESLint({ overrideConfigFile: '/app/tools/stock-request-layout-eslint.config.mjs',
  overrideConfig: [{ languageOptions: { globals: browserGlobals } }] });
const newLint = [];
const lintCounts = {};
for (const file of [...runtime, ...added]) {
  const old = runtime.includes(file)
    ? (await lint.lintText(await readFile(`${out}/before/${file}`, 'utf8'), { filePath: file }))[0].messages : [];
  const previous = old.map((row) => JSON.stringify([row.ruleId, row.severity, row.message]));
  const current = (await lint.lintText(await readFile(`/app/${file}`, 'utf8'), { filePath: file }))[0].messages;
  lintCounts[file] = { before: old.length, after: current.length };
  for (const row of current) {
    const key = JSON.stringify([row.ruleId, row.severity, row.message]);
    const index = previous.indexOf(key);
    if (index < 0) newLint.push({ file, ...row });
    else previous.splice(index, 1);
  }
}
for (const file of [...runtime, ...added]) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: '/app', encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
const findings = scanUnifiedDiff(await readFile(`${out}/changes.patch`, 'utf8'));
const result = { syntaxFiles: runtime.length + added.length, lintCounts, newLint,
  typeErrors: currentTypes.length, newTypes, secretFindings: findings };
await writeFile(`${out}/static.json`, JSON.stringify(result, null, 2) + '\n');
assert.deepEqual(newLint, [], JSON.stringify(newLint));
assert.deepEqual(newTypes, [], JSON.stringify(newTypes));
assert.deepEqual(findings, []);
console.log(JSON.stringify(result));
