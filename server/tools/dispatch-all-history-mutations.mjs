import assert from 'node:assert/strict';
import { cp,mkdir,readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const artifact = path.resolve('test-artifacts/dispatch-all-history-20261002');
const root = path.join(artifact,'mutation-source');
await mkdir(root,{recursive: true});
for (const directory of ['src','public']) { await cp(directory,path.join(root,directory),{recursive: true}); }
const property = 'test/dispatch/property/historical-planning-safety.property.test.js';
const prefix = 'test/dispatch/unit/executed-prefix-historical-reflexivity.test.js';
const packing = 'test/dispatch/integration/to-dependency-packing-independent.test.js';
const missing = 'test/dispatch/integration/historical-missing-order-snapshot.test.js';
const classification = 'test/dispatch/unit/historical-replay-fixture-classification.test.js';
const suites = [property,prefix,packing,missing,classification];
for (const file of suites) {
  await mkdir(path.dirname(path.join(root,file)),{recursive: true});
  await cp(file,path.join(root,file));
}
await mkdir(path.join(root,'tools'),{recursive: true});
await cp('tools/dispatch-all-history-fixture-classification.mjs',path.join(root,'tools/dispatch-all-history-fixture-classification.mjs'));
function run(files) {
  return spawnSync(process.execPath,['--test','--test-concurrency=1',...files],
    {cwd: root,env: process.env,encoding: 'utf8',maxBuffer: 8*1024*1024,timeout: 180000});
}
assert.equal(run(suites).status,0,'The unchanged mutation fixture must first pass');
const mutations = [
  {id: 'historical-cargo-equality-omitted',file: 'src/dispatch-history-mode.js',
    from: 'return isDeepStrictEqual(payload.orders, previousPlan.orders || [])',to: 'return true',tests: [property]},
  {id: 'unknown-stop-fallback-removed',file: 'src/dispatch-load-assignment.js',
    from: 'if (previous && [...scope.stopIds].some',to: 'if (false && previous && [...scope.stopIds].some',tests: [property,prefix]},
  {id: 'unknown-stop-real-changes-ignored',file: 'src/dispatch-load-assignment.js',
    from: 'const conservativeChanges = changedLockedLoadAssignments(previousPlan, nextPlan, new Set([scope.loadId]));',
    to: 'const conservativeChanges = [];',tests: [property,prefix]},
  {id: 'aggregate-cargo-evidence-omitted',file: 'src/dispatch-load-assignment.js',
    from: '...(!(order.items || []).length ? { quantities: Object.fromEntries(Object.entries(ALLOCATION_MEASURE_FIELDS)\n      .map(([field, aliases]) => [field, allocationMeasureValue(order, aliases)])) } : {}),',
    to: '...{},',tests: [property]},
  {id: 'packing-blocker-reintroduced',file: 'src/scm-dependency-preview-service.js',
    from: 'ignorePacking: ["link_to", "unlink_to", "change_mode"].includes(action)',
    to: 'ignorePacking: false',tests: [packing]},
  {id: 'group-child-pickups-omitted',file: 'src/dispatch-pickup-visits.js',
    from: 'const children = Array.isArray(order.childOrderDetails) ? order.childOrderDetails : [];',
    to: 'const children = [];',tests: [property]},
  {id: 'whole-group-co-authority-removed',file: 'src/dispatch-pickup-visits.js',
    from: '|| order.transitCo',to: '|| false',tests: [property]},
  {id: 'future-historical-cargo-accepted',file: 'src/dispatch-historical-order-snapshots.js',
    from: 'WHERE evidence_at <= $2 AND lower(card',to: 'WHERE true AND lower(card',tests: [property,missing]},
  {id: 'rejected-draft-cargo-accepted',file: 'src/dispatch-historical-order-snapshots.js',
    from: "AND archive_reason IS DISTINCT FROM 'save_recovery'\n          AND checkpoint_kind IS DISTINCT FROM 'recovery'\n          AND summary->'saveRecovery'->'applied' IS DISTINCT FROM 'false'::jsonb",
    to: '',tests: [property,missing]},
  {id: 'oldest-cargo-preferred',file: 'src/dispatch-historical-order-snapshots.js',
    from: 'evidence_at DESC,source_id DESC',to: 'evidence_at ASC,source_id DESC',tests: [property,missing]},
  {id: 'unrelated-audit-stop-accepted',file: 'src/dispatch-historical-order-snapshots.js',
    from: "stop->>'id'=route.id",to: 'true',tests: [missing]},
  {id: 'applied-history-classified-as-draft',file: 'tools/dispatch-all-history-fixture-classification.mjs',
    from: 'state.summary?.saveRecovery?.applied === false',to: 'true',tests: [classification]}
];
const report = {startedAt: new Date().toISOString(),mutations: []};
for (const mutation of mutations) {
  const file = path.join(root,mutation.file);
  const original = await readFile(file,'utf8');
  assert.ok(original.includes(mutation.from),`Mutation anchor missing: ${mutation.id}`);
  await writeFile(file,original.replace(mutation.from,mutation.to));
  try {
    const result = run(mutation.tests);
    const output = result.stdout+result.stderr;
    const killed = result.status !== 0 && /(?:testCodeFailure|ERR_ASSERTION|Property failed)/u.test(output)
      && !/(?:ERR_MODULE_NOT_FOUND|SyntaxError)/u.test(output);
    const row = {id: mutation.id,killed,status: result.status,tests: mutation.tests};
    // Attribute property evidence to the property suite alone, rather than a
    // different regression that happened to fail first in a combined run.
    if (mutation.tests.includes(property)) {
      const propertyRun = run([property]);
      row.propertyKilled = propertyRun.status !== 0 && /(?:ERR_ASSERTION|Property failed)/u.test(propertyRun.stdout+propertyRun.stderr);
      await writeFile(path.join(artifact,`mutation-${mutation.id}-property.log`),propertyRun.stdout+propertyRun.stderr,{mode: 0o600});
      assert.equal(row.propertyKilled,true,`Property mutation survived: ${mutation.id}`);
    }
    report.mutations.push(row);
    await writeFile(path.join(artifact,`mutation-${mutation.id}.log`),output,{mode: 0o600});
    console.log(JSON.stringify(row));
    assert.equal(killed,true,`Mutation survived: ${mutation.id}`);
  } finally { await writeFile(file,original); }
}
report.completedAt = new Date().toISOString();
report.restoredSuiteExit = run(suites).status;
await writeFile(path.join(artifact,'mutations.json'),JSON.stringify(report,null,2),{mode: 0o600});
assert.equal(report.restoredSuiteExit,0);
