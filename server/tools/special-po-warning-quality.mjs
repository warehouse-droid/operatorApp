import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import istanbulCoverage from 'istanbul-lib-coverage';
import { isolatedRun } from './dispatch-source-decision-checks.mjs';

const files = ['src/special-stock-request-repository.js', 'src/special-stock-request-service.js', 'public/scm-special-stock-requests.js'];
const test = 'test/mbt/integration/special-po-warning.test.js';
const baseline = '/workspace/server/deployments/special-po-warning-20261019/before';
function run(args, name, options = {}) {
  const result = spawnSync('node', args, { encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024, ...options });
  writeFileSync(`test-artifacts/${name}.log`, result.stdout + result.stderr);
  return result;
}
const diagnostics = [];
for (const file of files) {
  assert.equal(run(['--check', file], `syntax-${file.replaceAll('/', '-')}`).status, 0);
  const messages = [];
  for (const [mode, path] of [['before', `${baseline}/${file}`], ['after', file]]) {
    const result = run(['node_modules/eslint/bin/eslint.js', '--config', 'tools/special-po-warning-eslint.config.mjs',
      '--stdin', '--stdin-filename', file, '--format', 'json'], `lint-${mode}-${file.replaceAll('/', '-')}`, { input: readFileSync(path, 'utf8') });
    assert.ok([0, 1].includes(result.status));
    messages.push(JSON.parse(result.stdout).flatMap(entry => entry.messages.map(message => JSON.stringify({ rule: message.ruleId, message: message.message }))));
  }
  const remaining = [...messages[0]];
  for (const message of messages[1]) {
    const index = remaining.indexOf(message);
    assert.ok(index >= 0, `New lint diagnostic: ${file}: ${message}`);
    remaining.splice(index, 1);
  }
  diagnostics.push({ file, before: messages[0].length, after: messages[1].length });
}

const typeRoot = '/tmp/special-po-warning-types';
const typeMessages = [];
try {
  mkdirSync(typeRoot, { recursive: true });
  for (const name of ['src', 'public', 'package.json']) cpSync(`${baseline}/${name}`, `${typeRoot}/${name}`, { recursive: true });
  symlinkSync('/app/node_modules', `${typeRoot}/node_modules`, 'dir');
  for (const [mode, cwd] of [['before', typeRoot], ['after', '/app']]) {
    const result = run(['/app/node_modules/typescript/bin/tsc', '--allowJs', '--checkJs', '--noEmit', '--skipLibCheck', '--noResolve',
      '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', ...files], `types-${mode}`, { cwd });
    assert.ok([0, 1, 2].includes(result.status), `Type checker did not finish: ${mode}: ${result.status} ${result.signal} ${result.error?.message || ''}`);
    typeMessages.push((result.stdout + result.stderr).split('\n').filter(line => /error TS\d+/.test(line))
      .map(line => line.replace(/\(\d+,\d+\)/, '').replaceAll(typeRoot, '/app')));
  }
  const remaining = [...typeMessages[0]];
  for (const message of typeMessages[1]) {
    const index = remaining.indexOf(message);
    assert.ok(index >= 0, `New type diagnostic: ${message}`);
    remaining.splice(index, 1);
  }
} finally { rmSync(typeRoot, { recursive: true, force: true }); }
writeFileSync('test-artifacts/static.json', JSON.stringify({ diagnostics,
  types: { before: typeMessages[0].length, after: typeMessages[1].length, scope: 'Changed modules, noResolve; unresolved imports and pre-existing diagnostics compared to baseline' }, node: process.version,
  versions: Object.fromEntries(['eslint', 'typescript', 'c8', 'pg', 'fast-check'].map(name => [name, JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')).version])) }, null, 2));

assert.equal(run(['node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false',
  '--include=src/special-stock-request-repository.js', '--include=src/special-stock-request-service.js',
  '--reporter=json', '--report-dir=test-artifacts/coverage', '--temp-directory=/tmp/special-po-warning-coverage',
  'node', '--test', '--test-concurrency=1', test], 'coverage').status, 0);
const changed = JSON.parse(readFileSync('/workspace/server/deployments/special-po-warning-20261019/changed-lines.json', 'utf8'));
const coverage = istanbulCoverage.createCoverageMap(JSON.parse(readFileSync('test-artifacts/coverage/coverage-final.json', 'utf8')));
const covered = files.filter(file => file.startsWith('src/')).map(file => {
  const lines = coverage.fileCoverageFor(`/app/${file}`).getLineCoverage();
  const executable = changed[file].filter(line => Object.hasOwn(lines, line));
  const result = { file, changed: executable.length, covered: executable.filter(line => lines[line] > 0).length,
    uncovered: executable.filter(line => !lines[line]) };
  assert.equal(result.uncovered.length, 0, `Untested changed code: ${file}`);
  return result;
});
writeFileSync('test-artifacts/changed-line-coverage.json', JSON.stringify(covered, null, 2));

const mutants = [
  ['restore-obsolete-so-comparison', files[0], ').rows[0]?.local_adjusted_at) return false;', ').rows[0]?.missing_adjustment) return false;'],
  ['attempt-native-so-recovery', files[1], "prepared.salesOrderSource === 'manual_link' || Boolean(prepared.localAdjustedAt)", "prepared.salesOrderSource === 'manual_link'"],
  ['require-historical-so-description', files[0], '!custom && !independentPurchase && !special.local_adjusted_at && await query', '!custom && !independentPurchase && await query'],
  ['ignore-issued-po-mismatch', files[0], "orderKind === 'sales_order' && (await query(", "['sales_order', 'purchase_order'].includes(orderKind) && (await query("],
  ['ignore-unadjusted-so-mismatch', files[0], ').rows[0]?.local_adjusted_at) return false;', ').rows[0]) return false;']
];
const mutations = [];
for (const [name, file, before, after] of mutants) {
  const root = `/tmp/special-po-warning-${name}`;
  try {
    mkdirSync(root, { recursive: true });
    for (const directory of ['src', 'public']) cpSync(directory, `${root}/${directory}`, { recursive: true });
    cpSync('package.json', `${root}/package.json`);
    symlinkSync('/app/node_modules', `${root}/node_modules`, 'dir');
    mkdirSync(`${root}/test/mbt/integration`, { recursive: true });
    cpSync(test, `${root}/${test}`);
    const source = readFileSync(file, 'utf8');
    assert.equal(source.split(before).length, 2, `Unique mutation: ${name}`);
    writeFileSync(`${root}/${file}`, source.replace(before, after));
    const result = await isolatedRun(test, { cwd: root, prefix: name });
    assert.equal(result.exit, 1, `Surviving mutation: ${name}`);
    assert.ok(result.failures.length && result.failures.every(failure => !failure.includes('.test.js')), 'Mutation must fail at behavior');
    mutations.push({ name, ...result });
    console.log(JSON.stringify({ mutation: name, ...result }));
  } finally { rmSync(root, { recursive: true, force: true }); }
}
writeFileSync('test-artifacts/mutations.json', JSON.stringify(mutations, null, 2));
console.log(JSON.stringify({ qualityPassed: true, mutantsKilled: mutations.length, coverage: covered }));
