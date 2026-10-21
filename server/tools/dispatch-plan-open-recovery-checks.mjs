import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Linter } from 'eslint';

const artifact = 'test-artifacts/dispatch-open-recovery';
const source = readFileSync('public/dispatch.js', 'utf8');
const start = source.indexOf('async function createPlanForDate(');
const end = source.indexOf('\nfunction resetPlanningBoard(', start);
const body = source.slice(start, end);
const failures = text => [...text.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]).sort();
const baseline = readFileSync(`${artifact}/frontend-baseline.log`, 'utf8');
const final = readFileSync(`${artifact}/frontend-final.log`, 'utf8');
const baselineFailures = failures(baseline);
const finalFailures = failures(final);
assert.deepEqual(finalFailures, baselineFailures, 'No new frontend regressions');
console.log(JSON.stringify({ frontendBaselineFailures: baselineFailures, frontendFinalFailures: finalFailures,
  baselineCounts: baseline.match(/^# (?:tests|pass|fail|skipped) .+$/gm),
  finalCounts: final.match(/^# (?:tests|pass|fail|skipped) .+$/gm) }));

const globals = Object.fromEntries(['ensureDispatchPlanEditor', 'dispatchEditModeMessage', 'currentPlanDate',
  'localPlanGeneration', 'dispatchSessionId', 'planEditLeaseToken', 'localPlanDirty',
  'applyDispatchPlanSnapshotResult', 'resetUndoHistory', 'compactCurrentPlan', 'currentPlan',
  'dispatchStorageSet', 'DISPATCH_PLAN_DATE_KEY', 'loadPlanHistory', 'fetch'].map(name => [name, 'writable']));
const lint = new Linter().verify(body, { languageOptions: { ecmaVersion: 'latest', sourceType: 'script', globals },
  rules: { 'no-undef': 'error', 'no-unreachable': 'error', 'no-shadow': 'error', 'eqeqeq': 'error',
    'no-unused-vars': ['error', { varsIgnorePattern: '^createPlanForDate$' }] } });
assert.deepEqual(lint, []);
console.log('Changed-function lint: 0 findings');
const declarations = Object.keys(globals).filter(name => name !== 'fetch')
  .map(name => `declare let ${name}: ${['currentPlanDate', 'dispatchSessionId', 'planEditLeaseToken', 'DISPATCH_PLAN_DATE_KEY'].includes(name)
    ? 'string' : name === 'localPlanGeneration' ? 'number' : name === 'localPlanDirty' ? 'boolean' : 'any'};`).join('\n');
writeFileSync('/tmp/dispatch-plan-open.ts', `${declarations}\n${body}`);
const types = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--strict',
  '--target', 'ES2022', '--lib', 'ES2022,DOM', '--skipLibCheck', '--typeRoots', '/app/node_modules/@types',
  '/tmp/dispatch-plan-open.ts'], { encoding: 'utf8' });
writeFileSync(`${artifact}/types.log`, types.stdout + types.stderr);
assert.equal(types.status, 0, types.stdout + types.stderr);
console.log('Changed-function type check: passed (existing global interfaces treated as any)');

const test = 'test/dispatch/frontend/dispatch-plan-open-recovery.test.js';
const mutants = [
  ['omit hydration', '    applyDispatchPlanSnapshotResult({ exists: true, plan: { ...plan, assignedOrderSnapshots: plan.orders } });', '', true],
  ['overwrite dirty draft', 'if (hasSavedPlan && localPlanDirty)', 'if (false)', true],
  ['block new empty date', 'const hasSavedPlan = Number(plan.revision) > 0 || plan.orders.length > 0 || plan.trucks.length > 0;', 'const hasSavedPlan = true;', true],
  ['accept late navigation', 'currentPlanDate !== requestedDate || localPlanGeneration !== requestedGeneration', 'false', true],
  ['accept wrong date', 'plan.planDate !== planDate', 'false', true],
  ['ignore HTTP failure', 'if (!response.ok) throw new Error(await response.text());', '', false],
  ['allow read-only creation', 'if (!ensureDispatchPlanEditor()) throw new Error(dispatchEditModeMessage());', '', false]
];
mkdirSync('/tmp/dispatch-open-mutants', { recursive: true });
for (const [name, from, to, property] of mutants) {
  assert.ok(body.includes(from));
  const modified = source.slice(0, start) + body.replace(from, to) + source.slice(end);
  const mutantPath = '/tmp/dispatch-open-mutants/dispatch.js';
  writeFileSync(mutantPath, modified);
  for (const propertyOnly of property ? [false, true] : [false]) {
    const result = spawnSync(process.execPath, ['--test', ...(propertyOnly ? ['--test-name-pattern=property'] : []), test],
      { encoding: 'utf8', env: { ...process.env, NODE_V8_COVERAGE: '', DISPATCH_OPEN_RECOVERY_SOURCE_PATH: mutantPath } });
    writeFileSync(`${artifact}/mutant-${name.replaceAll(' ', '-')}${propertyOnly ? '-property' : ''}.log`, result.stdout + result.stderr);
    assert.ok(result.status > 0, `Mutant survived: ${name} (${propertyOnly ? 'property' : 'full'})`);
  }
}
console.log('Mutation: 7/7 killed by full suite; 5/5 applicable mutants killed by property suite alone');

// Check executable added lines against the actual V8 ranges from the final run.
const records = readdirSync(`${artifact}/v8`).filter(name => name.endsWith('.json'))
  .flatMap(name => JSON.parse(readFileSync(`${artifact}/v8/${name}`, 'utf8')).result)
  .filter(record => record.url.endsWith('/public/dispatch.js') || record.url === 'public/dispatch.js');
const functions = records.flatMap(record => record.functions)
  .filter(fn => fn.functionName === 'createPlanForDate' && fn.ranges[0].startOffset === start);
assert.ok(functions.length);
let offset = start;
const uncovered = [];
let executable = 0;
for (const line of body.split('\n')) {
  const position = offset + line.search(/\S/);
  if (line.trim() && !/^[\s{});]+$/.test(line)) {
    executable++;
    const hit = functions.some(fn => {
      const ranges = fn.ranges.filter(range => position >= range.startOffset && position < range.endOffset)
        .sort((a, b) => (a.endOffset - a.startOffset) - (b.endOffset - b.startOffset));
      return ranges[0]?.count > 0;
    });
    if (!hit) uncovered.push(line.trim());
  }
  offset += line.length + 1;
}
assert.deepEqual(uncovered, []);
console.log(JSON.stringify({ coverage: { executableFunctionLines: executable, uncovered },
  sourceSha256: createHash('sha256').update(source).digest('hex'), node: process.version }));
