import assert from "node:assert/strict";
import test, { after } from "node:test";
import { closeDb, query, withTransaction } from "../../../src/db.js";
import { getSmartScmPlanningRun, listSmartScmProposals, persistPurchaseStockDrafts } from "../../../src/smart-scm-planning-repository.js";

after(closeDb);

test("saved planning proposals return full Ultimate loads ahead of higher-score mixed loads", async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, "1");
  await withTransaction(async () => {
    const run = (await query(`INSERT INTO scm_smart_planning_runs(status,trigger_source,settings_snapshot,completed_at)
      VALUES('ready','ultimate-replay','{"truck_capacity_lbs":30}',now()) RETURNING id`)).rows[0];
    const makeLine = (id, pallets, weight, level) => ({
      itemId: id, itemName: `Urgency fixture ${id}`, itemDescription: "", unit: "EACH",
      destinationLocationId: 1, destinationName: "3445", requiredPallets: pallets,
      proposedPallets: pallets, confirmedPallets: 0, residualPallets: pallets,
      salesQuantity: pallets, palletWeight: weight, lineWeight: pallets * weight,
      toPlt: 1, toLyr: 0, toSec: 0, toPcs: 0, manualPlanningRequired: false,
      urgencyLevel: level, urgencyScore: 100, urgent: level !== "normal", reason: { physicalPalletWeightLbs: 0 }
    });
    const mixed = [makeLine(2950001, 1, 9, "ultimate_urgent"), makeLine(2950002, 4, 3, "normal")];
    const full = [makeLine(2950001, 3, 9, "ultimate_urgent")];
    const common = { proposalType: "PO", phase: "direct_vendor", sourceKind: "vendor",
      sourceName: "Replay Vendor", destinationLocationId: 1, destinationName: "3445", vendor: "Replay Vendor",
      status: "held", urgent: true, urgencyLevel: "ultimate_urgent", provisional: false,
      routeStops: [{ locationId: 1, name: "3445", sequence: 1 }] };
    await persistPurchaseStockDrafts(run.id, [
      { ...common, proposalKey: `replay-mixed:${run.id}`, lines: mixed, totalPallets: 5, totalWeight: 21, utilization: 0.7, urgencyScore: 100 },
      { ...common, proposalKey: `replay-full:${run.id}`, lines: full, totalPallets: 3, totalWeight: 27, utilization: 0.9, urgencyScore: 10 }
    ]);
    const expected = [`replay-full:${run.id}`, `replay-mixed:${run.id}`];
    assert.deepEqual((await getSmartScmPlanningRun(run.id)).proposals.map((proposal) => proposal.proposalKey), expected);
    assert.deepEqual((await listSmartScmProposals({ runId: run.id })).map((proposal) => proposal.proposalKey), expected);
  }, { rollback: true });
});
