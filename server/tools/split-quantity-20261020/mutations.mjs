import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.equal(new URL(process.env.DATABASE_URL).hostname, 'db');
const out = 'test-artifacts/split-quantity-20261020';
const root = mkdtempSync('/tmp/split-quantity-mutants-');
const domain = 'src/dispatch-split-quantity-domain.js';
const unit = 'test/dispatch/unit/split-quantity-validation.test.js';
const integration = 'test/dispatch/integration/split-quantity-validation.test.js';
const frontend = 'test/dispatch/frontend/split-quantity-validation.test.js';
const guard = 'await assertDispatchSplitQuantityChanges(';
const mutants = [
  { name: 'allow-shortage', file: domain, from: 'Math.abs(allocated - expected) > EPSILON',
    to: 'allocated - expected > EPSILON', tests: [unit], property: true },
  { name: 'allow-excess', file: domain, from: 'Math.abs(allocated - expected) > EPSILON',
    to: 'expected - allocated > EPSILON', tests: [unit], property: true },
  { name: 'reject-balanced', file: domain, from: 'Math.abs(allocated - expected) > EPSILON',
    to: 'Math.abs(allocated - expected) >= 0', tests: [unit], property: true },
  { name: 'skip-domain-validation', file: domain, from: 'export function assertSplitLineQuantities(source, children) {',
    to: 'export function assertSplitLineQuantities(source, children) { return;', tests: [unit], property: true },
  { name: 'trust-packing-claims', file: domain, from: 'assertPacking(original, item, label);',
    to: '// packing validation removed', tests: [unit] },
  { name: 'skip-legacy-server-check', file: 'src/dispatch-plan-repository.js',
    from: `${guard}{ orders }, { previousPlan });`,
    to: '// quantity guard removed', tests: [integration] },
  { name: 'skip-v2-server-check', file: 'src/dispatch-planner-v2-repository.js',
    from: `${guard}result.plan, { previousPlan: persistedPlan });`,
    to: '// quantity guard removed', tests: [integration] },
  { name: 'save-invalid-recovery-draft', file: 'src/server.js',
    from: '  "DISPATCH_SPLIT_QUANTITY_MISMATCH",',
    to: '// exclusion removed', tests: ['test/dispatch/integration/split-quantity-validation-http.test.js'] },
  { name: 'skip-browser-mutation-check', file: 'public/dispatch.js',
    from: 'const validationMessage = splitQuantityValidationMessage(order, cleanParts);',
    to: 'const validationMessage = "";', tests: [frontend], property: true }
];
const results = [];
function run(name, tests, property = false) {
  const args = ['--test', '--test-concurrency=1', ...(property ? ['--test-name-pattern=^property:'] : []), ...tests];
  const result = spawnSync(process.execPath, args, { cwd: root, env: process.env, encoding: 'utf8', timeout: 120000 });
  const log = (result.stdout || '') + (result.stderr || '');
  writeFileSync(`${out}/mutations/${name}${property ? '-property' : ''}.log`, log);
  const fail = Number(log.match(/^# fail (\d+)$/m)?.[1] || 0);
  assert.equal(result.signal, null, name);
  assert.ok(!/SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find module/u.test(log), name);
  return { exit: result.status, fail, killed: result.status !== 0 && fail > 0 };
}
try {
  mkdirSync(`${out}/mutations`, { recursive: true });
  for (const folder of ['src', 'public', 'test']) cpSync(folder, `${root}/${folder}`, { recursive: true });
  cpSync('package.json', `${root}/package.json`);
  symlinkSync(resolve('node_modules'), `${root}/node_modules`);
  const control = run('unmutated-control', [unit, integration, frontend]);
  assert.equal(control.exit, 0);
  for (const mutant of mutants) {
    const filename = `${root}/${mutant.file}`, original = readFileSync(filename, 'utf8');
    assert.equal(original.split(mutant.from).length, 2, `Mutation must have exactly one target: ${mutant.name}`);
    try {
      writeFileSync(filename, original.replace(mutant.from, mutant.to));
      const result = { name: mutant.name, ...run(mutant.name, mutant.tests) };
      if (mutant.property) result.propertyOnly = run(mutant.name, mutant.tests, true);
      results.push(result);
      writeFileSync(`${out}/mutations.json`, JSON.stringify(results, null, 2) + '\n');
      assert.ok(result.killed, mutant.name);
      if (mutant.property) assert.ok(result.propertyOnly.killed, `${mutant.name} property blind spot`);
    } finally { writeFileSync(filename, original); }
  }
  console.log(JSON.stringify(results));
} finally { rmSync(root, { recursive: true, force: true }); }
