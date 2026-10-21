import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const artifact = '/app/test-artifacts/operator-to-yard-flow-deployment/reconciliation-mutations';
const temporary = await mkdtemp('/tmp/to-reconciliation-mutants-');
const mutations = [
  ['add-cumulative-loads', 'operator-to-yard-flow-reconciliation-plan.mjs', 'quantities.set(key, quantity);', 'quantities.set(key, quantity+(quantities.get(key)||0));'],
  ['accept-wrong-sales-unit', 'operator-to-yard-flow-reconciliation-proof.mjs', "if (!item || proofUnit(item.unitsDisplay || item.units?.refName) !== line.unit)", 'if (!item)'],
  ['accept-wrong-source', 'operator-to-yard-flow-reconciliation-proof.mjs', 'sourceNetSuiteId: Number(source.id),\n        transactionType:', 'sourceNetSuiteId: Number(record.createdFrom.id),\n        transactionType:'],
  ['reopen-historical-transfer', 'operator-to-yard-flow-reconcile.mjs', "header.status === 'G' ? 'historical_completed'", "header.status === 'NEVER' ? 'historical_completed'"],
  ['omit-atomic-repair', 'operator-to-yard-flow-reconcile.mjs', 'export async function reconcileTransferOrder(id, evidence, { apply = false } = {}) {\n  return withTransaction(async () => {', 'export async function reconcileTransferOrder(id, evidence, { apply = false } = {}) {\n  return (async () => {'],
  ['omit-legacy-load-capture', 'operator-to-yard-flow-reconcile.mjs', "if (!lines.length || input.jobs.some", 'if (true || !lines.length || input.jobs.some']
];
await mkdir(artifact, { recursive: true });
try {
  await mkdir(`${temporary}/tools`);
  for (const name of ['operator-to-yard-flow-reconciliation-plan.mjs', 'operator-to-yard-flow-reconciliation-proof.mjs', 'operator-to-yard-flow-reconcile.mjs']) {await cp(`/app/tools/${name}`, `${temporary}/tools/${name}`);}
  await symlink('/app/src', `${temporary}/src`);
  const tests = ['unit/operator-to-yard-flow-reconciliation.test.js', 'unit/operator-to-yard-flow-reconciliation-proof.test.js', 'integration/operator-to-yard-flow-reconciliation.test.js'];
  for (const test of tests) {
    const source = (await readFile(`/app/test/mbt/${test}`, 'utf8')).replaceAll('../../../tools/', `${temporary}/tools/`)
      .replaceAll('../../../src/', '/app/src/').replaceAll('../../support/', '/app/test/support/');
    await writeFile(`${temporary}/${test.replaceAll('/', '-')}`, source);
  }
  const results = [];
  for (const [name, file, before, after] of mutations) {
    const path = `${temporary}/tools/${file}`, original = await readFile(path, 'utf8');
    assert.equal(original.split(before).length, 2, `Unique mutation anchor: ${name}`);
    const changed = name === 'omit-atomic-repair' ? original.replace(before, after).replace('    return output;\n  });\n}', '    return output;\n  })();\n}') : original.replace(before, after);
    await writeFile(path, changed);
    const run = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...tests.map(test => `${temporary}/${test.replaceAll('/', '-')}`)], { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    await writeFile(path, original);
    const output = (run.stdout || '') + (run.stderr || '');
    await writeFile(`${artifact}/${name}.log`, output);
    assert.ok(run.status !== 0 && /not ok/u.test(output) && !/SyntaxError|ERR_MODULE_NOT_FOUND/u.test(output), `Mutation survived or failed infrastructure: ${name}`);
    results.push({ name, killed: true }); console.log(`Killed ${name}`);
  }
  await writeFile(`${artifact}/results.json`, JSON.stringify(results, null, 2) + '\n');
} finally { await rm(temporary, { recursive: true, force: true }); }
