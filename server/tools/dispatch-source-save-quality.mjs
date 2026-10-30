import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const files = ['src/dispatch-source-refresh.js', 'src/dispatch-executed-order-review-repository.js', 'src/server.js', 'public/dispatch.js',
  'test/dispatch/frontend/dispatch-source-refresh.test.js', 'test/dispatch/property/dispatch-source-refresh.property.test.js',
  'tools/dispatch-source-save-check.mjs', 'tools/dispatch-source-save-mutations.mjs', 'tools/dispatch-source-save-quality.mjs'];
mkdirSync('test-artifacts/source-save', { recursive: true });
let inherited = 0;
function lint(file, source) {
  const result = spawnSync('node_modules/.bin/eslint', ['--config', 'tools/dispatch-source-save-eslint.config.mjs', '--stdin', '--stdin-filename', file, '--format=json'],
    { input: source, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.ok([0, 1].includes(result.status), result.stderr);
  return JSON.parse(result.stdout)[0].messages.map(message => ({ ...message,
    key: `${message.ruleId}:${message.message.replace(/on line \d+ column \d+/gu, 'on original declaration')}:${source.split('\n')[message.line - 1]?.trim()}` }));
}
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const syntax = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  const before = existsSync(`/baseline-source/${file}`) ? lint(file, readFileSync(`/baseline-source/${file}`, 'utf8')) : [];
  const after = lint(file, source);
  inherited += after.filter(message => before.some(old => old.key === message.key)).length;
  const added = after.filter(message => !before.some(old => old.key === message.key));
  if (added.length) {console.log(file, JSON.stringify(added.map(({ line, ruleId, message }) => ({ line, ruleId, message }))));}
  assert.equal(added.length, 0, `new lint findings: ${file}`);
}
console.log(JSON.stringify({ syntaxFiles: files.length, newLintFindings: 0, inheritedLintFindings: inherited,
  node: process.version, eslint: JSON.parse(readFileSync('node_modules/eslint/package.json')).version,
  sourceHashes: Object.fromEntries(files.slice(0, 4).map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')])) }));
writeFileSync('test-artifacts/source-save/static-passed.txt', 'Syntax and differential lint passed.\n');
