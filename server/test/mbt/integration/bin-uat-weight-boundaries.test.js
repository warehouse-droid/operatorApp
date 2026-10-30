import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { query, closeDb } from '../../../src/db.js';
import { saveTransportTrip } from '../../../src/mbt/bin-transport-service.js';
import { getMbtBinPlanning } from '../../../src/mbt/bin-planning-read.js';
import { transportFixture, transportInput } from '../support/bin-transport-fixtures.js';
import { run, storedPlan, boundary } from '../support/bin-planning-fixtures.js';

after(closeDb);
async function weightFixture() {
  const f = await transportFixture();
  await query('UPDATE dispatch_trucks SET capacity_lbs=48000 WHERE id=$1', [f.binTruckId]);
  await query("UPDATE dispatch_plan_snapshots SET trucks=jsonb_set(trucks,'{0,capacityLbs}','48000') WHERE plan_id=$1", [f.planId]);
  await query('UPDATE mbt_bin_assets SET tare_weight_kg=0 WHERE asset_id=$1', [f.assetId]);
  await query('UPDATE mbt_bin_types SET maximum_payload_kg=27215 WHERE bin_type_id=(SELECT bin_type_id FROM mbt_bin_assets WHERE asset_id=$1)', [f.assetId]);
  return f;
}
for (const weightLbs of [47999, 48000, 48001]) {
  test(`UAT WT01-WT03: ${weightLbs} lb on a 48000 lb truck saves and confirms; only excess warns`, async () => {
    const f = await weightFixture();
    const input = await transportInput(f, [{ lineKey: 'loose-1', quantity: '1' }]);
    const trip = (await saveTransportTrip({ ...input, weightLbs })).body.trip;
    await run(f, 'assign', { visitId: trip.tripId, expectedVisitRevision: trip.revision, assetAssignments: [] });
    await run(f, 'confirm');
    const read = await getMbtBinPlanning({ planDate: f.planDate }, boundary);
    const warnings = read.capacityWarnings.filter(warning => warning.visitId === trip.tripId);
    assert.equal((await storedPlan(f.planId)).status, 'confirmed');
    assert.equal(warnings.length > 0, weightLbs > 48000);
    if (warnings.length) {
      assert.equal(warnings[0].weightLbs, weightLbs);
      assert.equal(warnings[0].capacityLbs, 48000);
      assert.equal(warnings[0].excessLbs, 1);
    }
  });
}

test('UAT WT06: overweight Load 2 does not block a 17350 lb trip on Load 4, and warning stays on Load 2', async () => {
  const f = await weightFixture();
  const plan = await storedPlan(f.planId), loads = plan.trucks[0].loads;
  assert.ok(loads.length >= 2);
  for (const [index, name, minute] of [[0, 'BINTEST Load 2', 540], [1, 'BINTEST Load 4', 660], [2, 'Empty later load', 780]]) {
    Object.assign(loads[index], { name, plannedStartMinute: minute, plannedFinishMinute: minute + 90,
      startMode: 'fixed', startTime: ['09:00', '11:00', '13:00'][index] });
  }
  await query('UPDATE dispatch_plan_snapshots SET trucks=$2::jsonb WHERE plan_id=$1', [f.planId, JSON.stringify(plan.trucks)]);
  const timings = start => [0, 20, 40, 55].map((offset, index) => ({ sequence: index + 1, arrival: start + offset, depart: start + offset + 5 }));
  for (const [index, weightLbs, minute] of [[0, 59000, 540], [1, 17350, 660]]) {
    const input = await transportInput(f, [{ lineKey: 'loose-1', quantity: '1' }]);
    const trip = (await saveTransportTrip({ ...input, weightLbs })).body.trip;
    await run(f, 'assign', { loadId: f.binLoadIds[index], visitId: trip.tripId,
      expectedVisitRevision: trip.revision, assetAssignments: [], stopTimings: timings(minute) });
  }
  await run(f, 'confirm');
  const read = await getMbtBinPlanning({ planDate: f.planDate }, boundary);
  assert.equal((await storedPlan(f.planId)).status, 'confirmed');
  assert.ok(read.capacityWarnings.some(warning => warning.loadId === f.binLoadIds[0] && warning.weightLbs === 59000));
  assert.ok(read.capacityWarnings.every(warning => warning.loadId !== f.binLoadIds[1]));
  assert.equal((await query('SELECT count(*)::int AS n FROM mbt_transport_trips WHERE source_key=lower($1) AND status=$2', [f.sourceRef, 'planned'])).rows[0].n, 2);
});
