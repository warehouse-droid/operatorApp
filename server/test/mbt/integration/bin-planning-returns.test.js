import assert from "node:assert/strict";
import test, { after } from "node:test";
import { closeDb } from "../../../src/db.js";
import { app } from "../../../src/server.js";
import { config } from "../../../src/config.js";
import { updateOperatorPassword, loginOperator } from "../../../src/auth-repository.js";
import { planJobsForDriver } from "../../../src/driver-repository.js";
import { assertOrdinaryDispatchPreservesBins } from "../../../src/mbt/bin-planning-domain.js";
import { planningFixture, command, run, storedPlan } from "../support/bin-planning-fixtures.js";
after(closeDb);

async function confirmThroughDispatch(f) {
  config.dispatch.driverOrientedPlanning = true;
  await updateOperatorPassword(f.actor.operatorId, 'bin-return-test-password');
  const token = (await loginOperator(f.actor.operatorId, 'bin-return-test-password')).token;
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const input = await command(f, 'confirm');
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/dispatch/plans/${f.planId}/confirm`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ planDate: f.planDate, baseRevision: input.baseRevision, baseDigest: input.baseDigest,
        editLeaseToken: f.editLease.token, sessionId: f.editLease.sessionId, audit: { sessionId: f.editLease.sessionId } })
    });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

for (const withVisit of [false, true]) {
  test(`BIN returns publish only at confirmation and changes require confirmation again (visit=${withVisit})`, async () => {
    const f = await planningFixture(withVisit ? 2192 : 2191);
    if (withVisit) await run(f, "assign");
    const before = await storedPlan(f.planId);
    const visitLoad = before.trucks[0].loads[0];
    const returnLoad = { id: 'BIN-return', name: 'Return', truckId: f.binTruckId, driverId: f.driverId,
      startMode: 'fixed', start: '15:00', driverSequence: 3, plannedStartMinute: 900,
      plannedFinishMinute: 960, returnOnly: true, manual: true, returnYard: '3445', visits: [] };
    const visits = withVisit ? [{ ...visitLoad, visits: [{ visitId: f.frontVisitId,
      expectedVisitRevision: 1, stopOverrides: [] }] }] : [];
    const board = async nextReturn => {
      if (withVisit) {
        const plan = await storedPlan(f.planId);
        const load = plan.trucks[0].loads.find(l => l.id === visitLoad.id);
        // Save the existing authoritative visit through the normal command helper.
        const revision = (await command(f, 'assign')).expectedVisitRevision;
        visits[0] = { ...load, start: '07:00', driverSequence: 0,
          visits: [{ visitId: f.frontVisitId, expectedVisitRevision: revision, stopOverrides: [] }] };
      }
      await run(f, 'save_board', { loads: [...visits, nextReturn] });
    };
    const returns = async () => planJobsForDriver(await storedPlan(f.planId), f.driverLogin, { allowBin: true })
      .filter(job => job.loadId === returnLoad.id && job.stopId.startsWith('return-'));
    await board(returnLoad);
    assert.equal((await returns()).length, 0);
    const draft = await storedPlan(f.planId);
    for (const change of [{ mbtReturnReleased: true }, { returnYard: '2' }, { returnOnly: false }]) {
      const tampered = structuredClone(draft);
      Object.assign(tampered.trucks.flatMap(t => t.loads).find(l => l.id === returnLoad.id), change);
      assert.throws(() => assertOrdinaryDispatchPreservesBins(draft, tampered), e => e.code === 'MBT_BIN_PLANNING_REQUIRED');
    }
    const confirm = () => withVisit ? run(f, 'confirm') : confirmThroughDispatch(f);
    await confirm();
    assert.equal((await returns()).length, 1, 'Confirmed BIN return must reach the driver');
    if (withVisit) assert.equal((await returns())[0].fromAddress, '100 Test Route');
    await board(returnLoad);
    assert.equal((await returns()).length, 1, 'An unchanged board save keeps the return released');
    const changed = { ...returnLoad, returnYard: '2' };
    await board(changed);
    assert.equal((await returns()).length, 0, 'Changed return remains hidden until confirmed');
    await confirm();
    assert.equal((await returns()).length, 1);
    assert.equal((await returns())[0].toLocation, '2');
  });
}
