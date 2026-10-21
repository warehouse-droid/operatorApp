import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const root = `/tmp/bin-corrections-mutations-${process.pid}`;
await mkdir(root, { recursive: true });
const results = [];
try {
  for (const directory of ['src', 'public', 'test']) { await cp(directory, `${root}/${directory}`, { recursive: true }); }
  await mkdir(`${root}/tools`);
  await cp('tools/bin-planning-suites.mjs', `${root}/tools/bin-planning-suites.mjs`);
  await cp('tools/mbt-bin-cancel-undelivered.mjs', `${root}/tools/mbt-bin-cancel-undelivered.mjs`);
  for (const name of ['node_modules', 'package.json', 'test-artifacts', 'data']) { await symlink(`/app/${name}`, `${root}/${name}`); }
  function runSuite() {
    return spawnSync(process.execPath, ['tools/bin-planning-suites.mjs', 'selected',
      'test/mbt/unit/mbt-bin-corrections.test.js', 'test/mbt/integration/mbt-bin-corrections.test.js',
      'test/mbt/unit/mbt-bin-cancellation.test.js', 'test/mbt/integration/mbt-bin-cancellation.test.js'],
    { cwd: root, encoding: 'utf8', env: process.env, timeout: 120000 });
  }
  const control = runSuite();
  await writeFile('test-artifacts/mutation-green-control.log', control.stdout + control.stderr);
  assert.equal(control.status, 0, 'The unmutated scratch copy must pass before mutations.');
  const mutants = [
    ['wrong-default-fee', 'public/mbt-frontdesk.js', 'item.itemCode.toUpperCase() === "DELIVERY_CHARGE_MBT"',
      'item.itemCode.toUpperCase() === "DELIVERY_CHARGE_MBBS"'],
    ['force-aggregate-150', 'src/mbt/customer-charge-calculator.js',
      '  const rawLines = rawChargeLines(bin, kind, aggregateLines, input);',
      '  if (aggregateLines.length && !input.orderFrom150) { throw new Error("150 required"); }\n  const rawLines = rawChargeLines(bin, kind, aggregateLines, input);'],
    ['allow-premature-exchange', 'src/mbt/frontdesk-service.js',
      '      await assertFrontdeskBinDelivered(serviceLineId, { lock: true });\n      const incomingType',
      '      const incomingType'],
    ['misreport-availability', 'src/mbt/bin-dispatch-service.js',
      'No available ${binType.rows[0].type_code} bin', 'The front leg is missing for ${binType.rows[0].type_code} bin'],
    ['omit-planning-truck-import', 'public/mbt-planning.js', '      mergePlanningFleet(data.trucks);', '      void data.trucks;'],
    ['ignore-approved-adjustments', 'src/mbt/customer-charge-request-service.js',
      'safeAdd(gross, Number(adjustments.rows[0].total_minor), "Adjusted contract total")',
      'safeAdd(gross, 0, "Adjusted contract total")'],
    ['show-cancelled-bin', 'public/mbt-frontdesk.js', '    if (line.status === "cancelled") continue;', '    void line.status;'],
    ['allow-other-bin-credit', 'tools/mbt-bin-cancel-undelivered.mjs',
      "    assert.ok(chargeBelongsToLine(request, state), 'A charge belongs to another physical bin');", '    void state;'],
    ['skip-cancellation-revision', 'tools/mbt-bin-cancel-undelivered.mjs',
      "  assert.equal(Number(line.revision), input.expectedLineRevision, 'Bin revision changed');", '  void input.expectedLineRevision;'],
    ['wrong-active-total', 'src/mbt/customer-charge-request-service.js',
      'const gross = safeAdd(base, Number(additions.rows[0].total_minor), "Current contract total");',
      'const gross = safeAdd(base + 1, Number(additions.rows[0].total_minor), "Current contract total");'],
    ['ignore-driver-activity', 'tools/mbt-bin-cancel-undelivered.mjs',
      '  for (const visit of visits) { assertUnstartedVisit(visit); }', '  void visits;'],
    ['ignore-step-activity', 'tools/mbt-bin-cancel-undelivered.mjs',
      '  await assertNoServiceEvidence(state);', '  void state;'],
    ['ignore-confirmed-amount', 'tools/mbt-bin-cancel-undelivered.mjs',
      "  assert.equal(amount, input.expectedAmountMinor, 'Confirmed charge amount changed');", '  void amount;']
  ];
  for (const [name, file, before, after] of mutants) {
    const path = `${root}/${file}`;
    const source = await readFile(path, 'utf8');
    assert.equal(source.split(before).length, 2, `${name}: unique mutation site`);
    await writeFile(path, source.replace(before, after));
    const run = runSuite();
    await writeFile(`test-artifacts/mutation-${name}.log`, run.stdout + run.stderr);
    let propertyKilled;
    if (['ignore-approved-adjustments', 'wrong-active-total'].includes(name)) {
      const property = spawnSync(process.execPath, ['--test', '--test-name-pattern=signed adjustments',
        'test/mbt/unit/mbt-bin-cancellation.test.js'], { cwd: root, encoding: 'utf8', env: process.env, timeout: 30000 });
      await writeFile(`test-artifacts/mutation-${name}-property-only.log`, property.stdout + property.stderr);
      propertyKilled = property.status === 1;
      assert.ok(propertyKilled, `${name}: the adjustment property alone must detect this mutation`);
    }
    await writeFile(path, source);
    results.push({ name, killed: run.status === 1, propertyKilled });
    assert.equal(await readFile(path, 'utf8'), source);
  }
  await writeFile('test-artifacts/mutations.json', JSON.stringify(results, null, 2));
  assert.ok(results.every(result => result.killed), JSON.stringify(results));
  const restored = runSuite();
  await writeFile('test-artifacts/mutation-restored-control.log', restored.stdout + restored.stderr);
  assert.equal(restored.status, 0, 'Restored scratch sources must pass after mutations.');
  console.log(`Manual mutations: ${results.length}/${results.length} killed.`);
} finally { await rm(root, { recursive: true, force: true }); }
