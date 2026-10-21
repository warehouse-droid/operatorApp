import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Linter } from 'eslint';
import { cp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import { scanUnifiedDiff, scanTextForSecrets } from '../test/support/scan-diff-secrets.mjs';

const backend = ['src/mbt/frontdesk-bin-readiness.js', 'src/mbt/frontdesk-service.js',
  'src/mbt/customer-charge-request-service.js', 'src/mbt/customer-charge-calculator.js', 'src/mbt/bin-dispatch-service.js'];
const tests = ['test/mbt/unit/mbt-bin-corrections.test.js', 'test/mbt/integration/mbt-bin-corrections.test.js',
  'test/mbt/integration/mbt-bin-corrections-browser.test.js', 'test/mbt/unit/mbt-bin-cancellation.test.js',
  'test/mbt/integration/mbt-bin-cancellation.test.js', 'tools/mbt-bin-cancel-undelivered.mjs'];
const report = {};
function check(name, command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  writeFileSync(`test-artifacts/${name}.log`, result.stdout + result.stderr);
  report[name] = { exit: result.status };
  if (result.status !== 0) { console.log(result.stdout + result.stderr); }
  return result.status;
}
const baseline = '/workspace/server/test-artifacts/mbt-bin-corrections-20261015/baseline/';
const typeRoot = `/tmp/bin-corrections-types-${process.pid}`;
const typeDiagnostics = [];
try {
  for (const version of ['before', 'current']) {
    const root = `${typeRoot}/${version}`;
    await mkdir(root, { recursive: true });
    await cp('src', `${root}/src`, { recursive: true });
    for (const name of ['node_modules', 'package.json', 'tools', 'contracts']) { await symlink(`/app/${name}`, `${root}/${name}`); }
    if (version === 'before') {
      for (const file of backend.filter(name => !name.endsWith('frontdesk-bin-readiness.js'))) {
        await cp(baseline + file, `${root}/${file}`);
      }
    }
    const project = JSON.parse(readFileSync('tsconfig.mbt.json', 'utf8'));
    project.files = backend.filter(name => version === 'current' || !name.endsWith('frontdesk-bin-readiness.js'));
    project.include = [];
    await writeFile(`${root}/tsconfig.json`, JSON.stringify(project));
    const result = spawnSync('/app/node_modules/.bin/tsc', ['--project', `${root}/tsconfig.json`, '--noEmit'], { encoding: 'utf8' });
    writeFileSync(`test-artifacts/types-${version}.log`, result.stdout + result.stderr);
    const diagnostics = [...result.stdout.matchAll(/^(.*?)\(\d+,\d+\): error (TS\d+): (.*)$/gm)]
      .map(match => `${match[1].replace(root, '<source>')}: ${match[2]}: ${match[3]}`);
    assert.ok(result.status === 0 || diagnostics.length, result.stdout + result.stderr);
    typeDiagnostics.push(diagnostics);
  }
  const count = rows => rows.reduce((counts, row) => counts.set(row, (counts.get(row) || 0) + 1), new Map());
  const before = count(typeDiagnostics[0]);
  const added = [...count(typeDiagnostics[1])].filter(([key, total]) => total > (before.get(key) || 0));
  report.types = { baseline: typeDiagnostics[0].length, current: typeDiagnostics[1].length, newDiagnostics: added, exit: added.length ? 1 : 0 };
} finally { await rm(typeRoot, { recursive: true, force: true }); }
check('lint', 'node_modules/.bin/eslint', ['--config', 'eslint.mbt.config.js', '--max-warnings=0', ...backend, ...tests]);
const host = readFileSync('public/dispatch.js', 'utf8') + readFileSync('public/dispatch-auth.js', 'utf8');
const globals = Object.fromEntries([...host.matchAll(/^(?:async\s+)?(?:function|let|const)\s+([\w$]+)/gm)]
  .map(match => [match[1], 'writable']));
const browserGlobals = ['window','document','localStorage','sessionStorage','fetch','Option','Intl','URL','URLSearchParams',
  'structuredClone','Response','setTimeout','clearTimeout','console','location','navigator'];
Object.assign(globals, Object.fromEntries(browserGlobals.map(name => [name, 'readonly'])));
const rules = Object.fromEntries(['no-undef','no-unreachable','no-dupe-args','no-dupe-keys','no-duplicate-case','valid-typeof',
  'no-import-assign','no-unsafe-finally'].map(name => [name, 'error']));
for (const file of ['public/mbt-frontdesk.js', 'public/mbt-planning.js']) {
  assert.equal(check(file.split('/').at(-1) + '-syntax', process.execPath, ['--check', file]), 0);
  const diagnostics = new Linter().verify(readFileSync(file, 'utf8'), {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'script', globals }, rules });
  report[file] = diagnostics;
}
const secrets = [];
for (const file of [...backend, ...tests, 'public/mbt-frontdesk.js', 'public/mbt-frontdesk.html', 'public/mbt-planning.js']) {
  if (file.endsWith('frontdesk-bin-readiness.js') || tests.includes(file)) {
    secrets.push(...scanTextForSecrets(readFileSync(file, 'utf8'), file));
  } else {
    const diff = spawnSync('diff', ['-U3', '--label', 'a/' + file, '--label', 'b/' + file, baseline + file, file], { encoding: 'utf8' });
    secrets.push(...scanUnifiedDiff(diff.stdout));
  }
}
report.secrets = { findings: secrets, exit: secrets.length ? 1 : 0 };
writeFileSync('test-artifacts/static.json', JSON.stringify(report, null, 2));
assert.ok(Object.values(report).every(value => Array.isArray(value) ? value.length === 0 : value.exit === 0));
writeFileSync('test-artifacts/toolchain.json', JSON.stringify(Object.fromEntries(
  ['typescript','eslint','c8','fast-check','playwright','pg'].map(name =>
    [name, JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')).version])), null, 2));
console.log('Types, lint and browser syntax passed.');
