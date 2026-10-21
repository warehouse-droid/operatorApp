import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { cp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { Linter } from 'eslint';
import { scanTextForSecrets, scanUnifiedDiff } from '../test/support/scan-diff-secrets.mjs';

const baseline = '/workspace/server/test-artifacts/dispatch-editor-control-20261015/before-local';
const runtime = JSON.parse(readFileSync('/workspace/server/test-artifacts/dispatch-editor-control-20261015/runtime-files.json', 'utf8'));
const report = { syntax: [], lint: [], secrets: [] };
const browserGlobals = Object.fromEntries(['window', 'document', 'localStorage', 'sessionStorage', 'fetch',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'console', 'URL', 'URLSearchParams', 'Intl',
  'location', 'navigator', 'EventSource', 'FormData', 'Option', 'structuredClone', 'Blob', 'Image', 'requestAnimationFrame',
  'cancelAnimationFrame', 'CSS', 'performance', 'AbortController', 'MutationObserver', 'ResizeObserver', 'crypto',
  'indexedDB', 'FileReader', 'alert', 'confirm', 'prompt', 'getComputedStyle', 'Response', 'Headers', 'File', 'Element',
  'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'CustomEvent', 'URLPattern',
  'requireDispatchLogin', 'readDispatchAuthToken', 'clearDispatchAuthToken'].map(name => [name, 'readonly']));
const rules = Object.fromEntries(['no-undef', 'no-unreachable', 'no-dupe-args', 'no-dupe-keys', 'no-duplicate-case',
  'valid-typeof', 'no-import-assign', 'no-unsafe-finally'].map(name => [name, 'error']));
const linter = new Linter();
for (const file of runtime.filter(name => name.endsWith('.js'))) {
  const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  report.syntax.push({ file, exit: checked.status });
  assert.equal(checked.status, 0, checked.stderr);
  const source = readFileSync(file, 'utf8');
  const sourceType = file.startsWith('public/') ? 'script' : 'module';
  const globals = file.startsWith('public/') ? browserGlobals : Object.fromEntries(['process', 'console', 'Buffer',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'fetch', 'URL', 'AbortController',
    'structuredClone', 'performance', 'FormData', 'Headers', 'Response', 'Blob'].map(name => [name, 'readonly']));
  const verify = text => linter.verify(text, { languageOptions: { ecmaVersion: 'latest', sourceType, globals }, rules });
  const current = verify(source);
  let before = [];
  try {before = verify(readFileSync(`${baseline}/${file}`, 'utf8'));} catch {}
  const existing = new Set(before.map(d => `${d.ruleId}:${d.message}`));
  const added = current.filter(d => !existing.has(`${d.ruleId}:${d.message}`));
  report.lint.push({ file, baseline: before.length, current: current.length, added });
  if (file.endsWith('dispatch-edit-activity.js') || file.endsWith('admin-dispatch-editors.js')) {
    report.secrets.push(...scanTextForSecrets(source, file));
  } else {
    const diff = spawnSync('diff', ['-U3', '--label', 'a/' + file, '--label', 'b/' + file, `${baseline}/${file}`, file], { encoding: 'utf8' });
    report.secrets.push(...scanUnifiedDiff(diff.stdout));
  }
}
const typeRoot = '/tmp/editor-control-types';
const diagnostics = [];
try {
  for (const version of ['before', 'current']) {
    const root = `${typeRoot}/${version}`;
    await mkdir(root, { recursive: true });
    await cp('src', root + '/src', { recursive: true });
    await symlink('/app/node_modules', root + '/node_modules');
    await symlink('/app/package.json', root + '/package.json');
    if (version === 'before') {await cp(`${baseline}/src/dispatch-plan-lease-repository.js`, root + '/src/dispatch-plan-lease-repository.js');}
    await writeFile(root + '/tsconfig.json', JSON.stringify({ compilerOptions: { allowJs: true, checkJs: true,
      noEmit: true, strict: false, skipLibCheck: true, target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', types: ['node'] },
      files: ['src/dispatch-plan-lease-repository.js'] }));
    const checked = spawnSync('/app/node_modules/.bin/tsc', ['-p', root + '/tsconfig.json'], { encoding: 'utf8' });
    writeFileSync(`test-artifacts/types-${version}.log`, checked.stdout + checked.stderr);
    diagnostics.push([...checked.stdout.matchAll(/^(.*?)\(\d+,\d+\): error (TS\d+): (.*)$/gm)]
      .map(match => `${match[1].replace('/' + version + '/', '/<version>/')}:${match[2]}:${match[3]}`));
    assert.ok(checked.status === 0 || diagnostics.at(-1).length, checked.stdout + checked.stderr);
  }
} finally {await rm(typeRoot, { recursive: true, force: true });}
const counts = values => values.reduce((map, value) => map.set(value, (map.get(value) || 0) + 1), new Map());
const oldCounts = counts(diagnostics[0]);
report.types = { baseline: diagnostics[0].length, current: diagnostics[1].length,
  added: [...counts(diagnostics[1])].filter(([key, total]) => total > (oldCounts.get(key) || 0)) };
report.versions = Object.fromEntries(['typescript', 'eslint', 'c8', 'fast-check', 'playwright', 'pg'].map(name =>
  [name, JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')).version]));
writeFileSync('test-artifacts/static.json', JSON.stringify(report, null, 2));
assert.ok(report.lint.every(row => !row.added.length), 'New lint diagnostics: see static.json');
assert.equal(report.types.added.length, 0, 'New type diagnostics: see static.json');
assert.equal(report.secrets.length, 0, 'Secret findings: see static.json');
console.log(JSON.stringify({ syntax: report.syntax.length, newLint: 0, newTypes: 0, secrets: 0 }));
