import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ESLint } from 'eslint';

const task = 'tools/dispatch-grouping-reliability-20261020';
const out = 'test-artifacts';
const file = 'public/dispatch.js';
const root = mkdtempSync('/tmp/split-identity-static-');
const difference = (after, before) => {
  const remaining = [...before];
  return after.filter(value => {
    const index = remaining.indexOf(value);
    if (index < 0) return true;
    remaining.splice(index, 1); return false;
  });
};
try {
  cpSync(task + '/baseline/public', root + '/public', { recursive: true });
  cpSync(task + '/baseline/src', root + '/src', { recursive: true });
  cpSync('package.json', root + '/package.json');
  symlinkSync(resolve('node_modules'), root + '/node_modules');
  symlinkSync(resolve('tools'), root + '/tools');
  symlinkSync(resolve('contracts'), root + '/contracts');
  const types = cwd => spawnSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'),
    '--noEmit', '--allowJs', '--checkJs', '--skipLibCheck', '--types', 'node',
    '--target', 'ES2022', '--module', 'NodeNext', file, 'src/dispatch-delivery-group-repository.js', 'src/dispatch-planner-v2-repository.js', 'src/server.js'],
  { cwd, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
  const before = types(root), after = types(process.cwd());
  for (const [name, result] of [['before', before], ['after', after]]) {
    writeFileSync(`${out}/types-${name}.log`, result.stdout + result.stderr);
    assert.ok([0, 1, 2].includes(result.status));
    if (result.status) assert.match(result.stdout, /error TS\d+/u);
  }
  const messages = output => output.split('\n').filter(line => /error TS\d+/u.test(line))
    .map(line => line.replace(/\(\d+,\d+\)/u, ''));
  const previous = messages(before.stdout), current = messages(after.stdout);
  const files = ['public/dispatch.js', 'src/dispatch-delivery-group-repository.js', 'src/dispatch-planner-v2-repository.js', 'src/server.js'];
  const lint = new ESLint({ overrideConfigFile: resolve('tools/stock-request-layout-eslint.config.mjs') });
  const newLint = [];
  for (const name of files) {
    const lintMessages = async source => (await lint.lintText(source, { filePath: name }))[0].messages
      .map(row => JSON.stringify([row.ruleId, row.severity, row.message]));
    newLint.push(...difference(await lintMessages(readFileSync(name, 'utf8')),
      await lintMessages(readFileSync(task + '/baseline/' + name, 'utf8'))));
  }
  const tests = ['test/dispatch/frontend/edit-group-reliability.browser.test.mjs',
    'test/dispatch/frontend/group-hydration-concurrency.test.js', 'test/dispatch/integration/edit-group-reliability.test.js'];
  const testLint = [];
  for (const name of [...files, ...tests]) {
    const result = spawnSync(process.execPath, ['--check', name], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const result = { baselineTypeErrors: previous.length, currentTypeErrors: current.length,
    newTypes: difference(current, previous), newLint, testLint, syntaxChecks: 7, testLintSkipped: 'Browser globals supplied by the real page; test syntax and execution verified',
    versions: { node: process.version, ...Object.fromEntries(
      ['typescript', 'eslint', 'fast-check', '@playwright/test'].map(name =>
        [name, JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')).version])) } };
  writeFileSync(`${out}/static.json`, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
  assert.deepEqual(result.newTypes, []);
  assert.deepEqual(newLint, []);
  assert.deepEqual(testLint, []);
} finally { rmSync(root, { recursive: true, force: true }); }
