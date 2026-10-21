import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ESLint } from 'eslint';

const out = resolve('test-artifacts/special-so-link-sqft-20261006');
const files = ['src/special-stock-request-repository.js', 'src/special-stock-pricing-domain.js', 'public/sales-special-stock-requests.js'];
const own = ['test/mbt/integration/special-manual-so-link.test.js', 'test/mbt/unit/special-sqft-draft.test.js',
  'test/mbt/unit/special-manual-so-ui.browser.test.js'];
const sha = value => createHash('sha256').update(value).digest('hex');
function run(label, cmd, args, cwd = process.cwd()) {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 180000, maxBuffer: 30000000 });
  const log = (result.stdout || '') + (result.stderr || '');
  writeFileSync(out + '/' + label + '.log', log);
  assert.ok(result.status !== null, label + ': ' + result.error);
  return { status: result.status, log };
}
for (const file of [...files, ...own]) assert.equal(run('syntax-' + file.split('/').at(-1), process.execPath, ['--check', file]).status, 0);
const typeArgs = ['--noEmit', '--allowJs', '--checkJs', '--skipLibCheck', '--types', 'node', '--target', 'ES2022', '--module', 'NodeNext', ...files];
const typeRoot = '/tmp/special-link-types-baseline';
rmSync(typeRoot, { recursive: true, force: true }); mkdirSync(typeRoot);
for (const folder of ['src', 'public']) cpSync(out + '/runtime/' + folder, typeRoot + '/' + folder, { recursive: true });
cpSync('package.json', typeRoot + '/package.json');
symlinkSync('/app/node_modules', typeRoot + '/node_modules');
const before = run('types-baseline', '/app/node_modules/.bin/tsc', typeArgs, typeRoot);
const after = run('types-current', '/app/node_modules/.bin/tsc', typeArgs);
const messages = log => log.split('\n').filter(line => /error TS\d+/.test(line)).map(line => line.replace(/\(\d+,\d+\)/, ''));
const old = messages(before.log), typeChanges = [];
for (const message of messages(after.log)) {
  const index = old.indexOf(message);
  if (index < 0) typeChanges.push(message); else old.splice(index, 1);
}
writeFileSync(out + '/new-type-errors.json', JSON.stringify(typeChanges, null, 2));
assert.deepEqual(typeChanges, [], 'TypeScript introduced errors');
const lint = new ESLint({ overrideConfigFile: resolve('tools/stock-request-layout-eslint.config.mjs') });
const lintChanges = [];
for (const file of files) {
  const summarize = results => results[0].messages.map(({ ruleId, severity, message }) => JSON.stringify({ ruleId, severity, message }));
  const original = summarize(await lint.lintText(readFileSync(out + '/baseline/' + file, 'utf8'), { filePath: file }));
  for (const message of summarize(await lint.lintText(readFileSync(file, 'utf8'), { filePath: file }))) {
    const index = original.indexOf(message);
    if (index < 0) lintChanges.push({ file, message }); else original.splice(index, 1);
  }
}
writeFileSync(out + '/new-lint-errors.json', JSON.stringify(lintChanges, null, 2));
assert.deepEqual(lintChanges, [], 'ESLint introduced errors');
const report = Object.values(JSON.parse(readFileSync(out + '/coverage/coverage-final.json', 'utf8')));
const browser = JSON.parse(readFileSync(out + '/browser-coverage.json', 'utf8'));
const changedCoverage = {};
for (const file of files) {
  const text = readFileSync(file, 'utf8'), lines = text.split('\n');
  const diff = spawnSync('diff', ['-U0', out + '/baseline/' + file, file], { encoding: 'utf8' });
  assert.equal(diff.status, 1, 'Expected a scoped change in ' + file);
  let line = 0;
  const changed = [];
  for (const entry of diff.stdout.split('\n')) {
    const hunk = entry.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) line = Number(hunk[1]);
    else if (entry.startsWith('+') && !entry.startsWith('+++')) {
      if (lines[line - 1].trim() && !/^(?:\s*\*|\s*\/\*|\s*\/\/|\s*}\s*$)/.test(lines[line - 1])) changed.push(line);
      line++;
    } else if (entry.startsWith(' ')) line++;
  }
  const node = report.find(entry => entry.path.endsWith('/' + file));
  const uncovered = changed.filter(number => {
    if (file.startsWith('public/')) {
      const offset = lines.slice(0, number - 1).reduce((sum, value) => sum + value.length + 1, 0);
      const end = offset + lines[number - 1].length;
      return !browser.some(entry => entry.text === text && entry.ranges.some(range => range.start < end && range.end > offset));
    }
    return !node || !Object.entries(node.statementMap).some(([key, statement]) => statement.start.line <= number
      && statement.end.line >= number && node.s[key] > 0);
  });
  changedCoverage[file] = { changed, uncovered };
}
writeFileSync(out + '/changed-coverage.json', JSON.stringify(changedCoverage, null, 2));
assert.deepEqual(Object.values(changedCoverage).flatMap(value => value.uncovered), [], 'Changed code remains unexecuted');
assert.equal(run('secrets', process.execPath, ['test/support/scan-diff-secrets.mjs', ...files, ...own]).status, 0);
const summary = { types: { baselineErrors: messages(before.log).length, newErrors: 0 }, lintNewErrors: 0,
  changedCoverage, sourceHashes: Object.fromEntries(files.map(file => [file, sha(readFileSync(file))])),
  tools: Object.fromEntries(['typescript', 'eslint', 'c8', 'fast-check', '@playwright/test'].map(name =>
    [name, JSON.parse(readFileSync('/app/node_modules/' + name + '/package.json')).version])) };
writeFileSync(out + '/static.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
