import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ESLint } from 'eslint';

const task = 'tools/split-draft-identity-20261020';
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
  cpSync('package.json', root + '/package.json');
  symlinkSync(resolve('node_modules'), root + '/node_modules');
  const types = cwd => spawnSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'),
    '--noEmit', '--allowJs', '--checkJs', '--skipLibCheck', '--types', 'node',
    '--target', 'ES2022', '--module', 'NodeNext', file],
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
  const lint = new ESLint({ overrideConfigFile: resolve('tools/stock-request-layout-eslint.config.mjs'),
    overrideConfig: [{ files: ['test/dispatch/frontend/split-draft-identity.browser.test.mjs'],
      languageOptions: { globals: Object.fromEntries([
        'orders', 'normalizeOrder', 'orderCatalog', 'structuredClone', 'trucks', 'fleet', 'splitParts',
        'currentPlanDate', 'todayLocalDate', 'currentPlan', 'dispatchConfig', 'dispatchSetupLoaded',
        'dispatchPlannerSnapshotState', 'planEditMode', 'planEditLeaseToken', 'planEditLease',
        'dispatchSessionId', 'selectedOrderId', 'selectedOrderIds', 'render',
        'mergeDispatchOrderSearchFeed', 'renderDispatchModalInPlace', 'splitQuantityValidationMessage', 'orderById'
      ].map(name => [name, 'writable'])) } }] });
  const lintMessages = async source => (await lint.lintText(source, { filePath: file }))[0].messages
    .map(row => JSON.stringify([row.ruleId, row.severity, row.message]));
  const newLint = difference(await lintMessages(readFileSync(file, 'utf8')),
    await lintMessages(readFileSync(root + '/' + file, 'utf8')));
  const tests = ['test/dispatch/frontend/split-draft-identity.test.js',
    'test/dispatch/frontend/split-draft-identity.browser.test.mjs'];
  const testLint = (await lint.lintFiles(tests)).flatMap(row => row.messages);
  for (const name of [file, ...tests]) {
    const result = spawnSync(process.execPath, ['--check', name], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const result = { baselineTypeErrors: previous.length, currentTypeErrors: current.length,
    newTypes: difference(current, previous), newLint, testLint, syntaxChecks: 3,
    versions: { node: process.version, ...Object.fromEntries(
      ['typescript', 'eslint', 'fast-check', '@playwright/test'].map(name =>
        [name, JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')).version])) } };
  writeFileSync(`${out}/static.json`, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
  assert.deepEqual(result.newTypes, []);
  assert.deepEqual(newLint, []);
  assert.deepEqual(testLint, []);
} finally { rmSync(root, { recursive: true, force: true }); }
