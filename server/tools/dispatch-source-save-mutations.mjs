import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve('test-artifacts/source-save/mutations');
const frontend = 'test/dispatch/frontend/dispatch-source-refresh.test.js';
const property = 'test/dispatch/property/dispatch-source-refresh.property.test.js';
const mutations = [
  ['digest', 'src/dispatch-source-refresh.js', 'digestDispatchPlan(baseline) !== baseDigest', 'false', property],
  ['archive-kind', 'src/dispatch-source-refresh.js', "row.archive_reason !== 'before_netsuite_source_acceptance'", 'false', property],
  ['route', 'src/dispatch-source-refresh.js', '!isDeepStrictEqual(row.trucks, plan.trucks)', 'false', property],
  ['draft-overwrite', 'public/dispatch.js', 'dispatchSourceValueEqual(order[field], old[field]) || dispatchSourceValueEqual(order[field], fresh[field])', 'true', property],
  ['pending-request', 'public/dispatch.js', '|| pendingPlanSaveAttempt || pendingDispatchPlanAction || confirmInFlight) {return false;}', '|| pendingDispatchPlanAction || confirmInFlight) {return false;}', frontend],
  ['discard-completed-save', 'public/dispatch.js', '|| pendingPlanSaveAttempt || pendingDispatchPlanAction || confirmInFlight) {return false;}', '|| saveInFlight || pendingPlanSaveAttempt || pendingDispatchPlanAction || confirmInFlight) {return false;}', frontend]
];
mkdirSync(root, { recursive: true });
try {
  for (const dir of ['src', 'public']) {cpSync(dir, `${root}/${dir}`, { recursive: true });}
  for (const file of ['package.json', frontend, property, 'test/support/sales-order-cargo-fixture.mjs']) {
    mkdirSync(resolve(root, file, '..'), { recursive: true });
    cpSync(file, `${root}/${file}`);
  }
  symlinkSync(resolve('node_modules'), `${root}/node_modules`, 'dir');
  for (const [name, file, before, after, suite] of mutations) {
    const original = readFileSync(`${root}/${file}`, 'utf8');
    assert.equal(original.split(before).length, 2, `unique mutant target: ${name}`);
    writeFileSync(`${root}/${file}`, original.replace(before, after));
    try {
      const result = spawnSync(process.execPath, ['--test', suite], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      const output = `${result.stdout}${result.stderr}`;
      writeFileSync(`test-artifacts/source-save/mutant-${name}.log`, output);
      assert.ok(result.status === 1 && /not ok/u.test(output) && !/SyntaxError|Cannot find module/u.test(output), `mutant survived or failed invalidly: ${name}`);
      console.log(`killed ${name} (${suite === property ? 'property suite alone' : 'frontend race suite'})`);
    } finally {writeFileSync(`${root}/${file}`, original);}
  }
  console.log(`mutations killed: ${mutations.length}/${mutations.length}`);
} finally {rmSync(root, { recursive: true, force: true });}
