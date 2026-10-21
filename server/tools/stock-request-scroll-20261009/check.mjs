import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, openSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ESLint } from 'eslint';

const out = 'test-artifacts/stock-request-scroll-20261009';
assert.equal(process.env.MBT_TEST_ISOLATED, '1');
function run(label, args, allowedFailure = false, cwd = process.cwd()) {
  const fd = openSync(resolve(`${out}/${label}.log`), 'w');
  let result;
  try { result = spawnSync(process.execPath, args, { cwd, stdio: ['ignore', fd, fd], timeout: 300000 }); }
  finally { closeSync(fd); }
  const log = readFileSync(`${out}/${label}.log`, 'utf8');
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key => [key, Number(log.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] || 0)]));
  console.log(JSON.stringify({ label, exit: result.status, ...counts }));
  if (!allowedFailure) assert.equal(result.status, 0, log.slice(-5000));
  assert.notEqual(result.status, null);
  return { exit: result.status, ...counts, log };
}
const files = JSON.parse(readFileSync('tools/stock-request-scroll-20261009/files.json'));
const js = files.filter(file => file.endsWith('.js'));
const root = mkdtempSync('/tmp/request-scroll-types-');
try {
  cpSync('public', `${root}/public`, { recursive: true });
  cpSync('package.json', `${root}/package.json`);
  symlinkSync(resolve('node_modules'), `${root}/node_modules`);
  symlinkSync(resolve('tools'), `${root}/tools`);
  symlinkSync(resolve('src'), `${root}/src`);
  for (const file of js) cpSync(`${out}/live-public/${file.split('/').at(-1)}`, `${root}/${file}`);
  const typeArgs = ['/app/node_modules/typescript/bin/tsc', '--noEmit', '--allowJs', '--checkJs', '--skipLibCheck', '--types', 'node', '--target', 'ES2022', '--module', 'NodeNext', ...js];
  const before = run('types-before', typeArgs, true, root), after = run('types-after', typeArgs, true);
  const errors = log => log.split('\n').filter(line => /error TS\d+/.test(line)).map(line => line.replace(/\(\d+,\d+\)/, ''));
  const previous = errors(before.log);
  const newTypes = errors(after.log).filter(line => { const index = previous.indexOf(line); if (index < 0) return true; previous.splice(index, 1); return false; });
  assert.deepEqual(newTypes, []);
  const lint = new ESLint({ overrideConfigFile: resolve('tools/stock-request-layout-eslint.config.mjs') });
  const newLint = [];
  for (const file of js) {
    const messages = result => result.messages.map(message => JSON.stringify([message.ruleId, message.severity, message.message]));
    const old = messages((await lint.lintText(readFileSync(`${root}/${file}`, 'utf8'), { filePath: file }))[0]);
    for (const message of messages((await lint.lintText(readFileSync(file, 'utf8'), { filePath: file }))[0])) {
      const index = old.indexOf(message); if (index < 0) newLint.push({ file, message }); else old.splice(index, 1);
    }
    run('syntax-' + file.split('/').at(-1), ['--check', file]);
  }
  assert.deepEqual(newLint, []);
  writeFileSync(`${out}/static.json`, JSON.stringify({ newTypes, newLint, baselineTypeErrors: errors(before.log).length, currentTypeErrors: errors(after.log).length }, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
run('lint-tests', ['/app/node_modules/eslint/bin/eslint.js', '--config', 'tools/stock-request-layout-eslint.config.mjs', '--max-warnings=0',
  'test/mbt/integration/stock-request-scroll-20261009-browser.test.js', 'tools/stock-request-scroll-20261009/browser-fixture.mjs', 'tools/stock-request-scroll-20261009/check.mjs']);
const result = run('regressions', ['--test', '--test-concurrency=1',
  'test/mbt/integration/stock-request-scroll-20261009-browser.test.js',
  'test/mbt/integration/stock-request-long-scroll-browser.test.js',
  'test/mbt/integration/stock-request-audit-scroll-browser.test.js',
  'test/mbt/integration/stock-request-view-browser.test.js',
  'test/mbt/integration/special-stock-check-editing-browser.test.js',
  'test/mbt/unit/stock-request-view.test.js']);
const hashes = Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
const webkit = JSON.parse(readFileSync(`${out}/webkit-probe.json`));
const candidate = webkit.filter(row => !row.baseline);
assert.equal(candidate.length, 8);
assert.ok(candidate.every(row => !row.reversals.length && !row.errors.length && row.boundary.top > 100));
writeFileSync(`${out}/summary.json`, JSON.stringify({ ...result, log: undefined, hashes, node: process.version,
  playwright: JSON.parse(readFileSync('node_modules/@playwright/test/package.json')).version, webkitLayouts: candidate.length }, null, 2) + '\n');
