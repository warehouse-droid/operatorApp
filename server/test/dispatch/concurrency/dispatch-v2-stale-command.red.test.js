// @ts-check

import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { query } from "../../../src/db.js";
import { createDispatchV2Fixture } from "../support/dispatch-v2-fixture.js";

let fixture;

before(async () => {
  fixture = await createDispatchV2Fixture();
});

after(async () => {
  await fixture?.close();
});

test("DP-10: concurrent dispatchers at the same revision produce one durable winner and one stale rejection", async () => {
  const seeded = await fixture.seedPlan({ date: "2025-03-15", refs: ["DP-RACE-A", "DP-RACE-B"] });
  const leftLease = await fixture.acquireLease({ planDate: seeded.plan_date, sessionId: "dispatch-v2-race-left" });
  // The production implementation retains one edit lease. The second request
  // deliberately reuses the valid lease token to test optimistic plan revision
  // concurrency rather than lease ownership.
  const bootResult = await fixture.request(`/api/dispatch/v2/bootstrap?planId=${seeded.id}&date=${seeded.plan_date}`);
  assert.equal(bootResult.response.status, 200, JSON.stringify(bootResult.payload));
  const boot = bootResult.payload;
  assert.ok(boot.plan?.digest);

  const command = (commandId, orderRef) => fixture.request(`/api/dispatch/v2/plans/${seeded.id}/commands`, {
    method: "POST",
    headers: { "x-dispatch-edit-lease": leftLease },
    body: {
      commandId,
      baseRevision: boot.plan.revision,
      baseDigest: boot.plan.digest,
      sessionId: commandId,
      commandType: "remove_order",
      payload: { orderRef }
    }
  });
  const outcomes = await Promise.all([command("dp10-left", "DP-RACE-A"), command("dp10-right", "DP-RACE-B")]);
  const winners = outcomes.filter((outcome) => outcome.response.status === 200);
  const stale = outcomes.filter((outcome) => outcome.response.status === 409);
  assert.equal(winners.length, 1, JSON.stringify(outcomes.map((outcome) => outcome.payload)));
  assert.equal(stale.length, 1, JSON.stringify(outcomes.map((outcome) => outcome.payload)));
  assert.equal(stale[0].payload.code, "STALE_DISPATCH_PLAN");

  const finalResult = await fixture.request(`/api/dispatch/v2/bootstrap?planId=${seeded.id}&date=${seeded.plan_date}`);
  assert.equal(finalResult.response.status, 200, JSON.stringify(finalResult.payload));
  assert.equal(finalResult.payload.plan.revision, boot.plan.revision + 1);
  const removed = winners[0].payload.patch.removedOrderRefs[0];
  assert.equal(finalResult.payload.plan.board.orderRefs.includes(removed), false);
  assert.equal(finalResult.payload.plan.board.orderRefs.length, 1);
});

test("DP-10: a matching revision with a mismatched snapshot digest fails closed", async () => {
  const seeded = await fixture.seedPlan({ date: "2025-03-16", refs: ["DP-DIGEST-A"] });
  const lease = await fixture.acquireLease({ planDate: seeded.plan_date, sessionId: "dispatch-v2-digest" });
  const initial = await fixture.request(`/api/dispatch/v2/bootstrap?planId=${seeded.id}&date=${seeded.plan_date}`);
  assert.equal(initial.response.status, 200, JSON.stringify(initial.payload));

  await query(
    `UPDATE dispatch_plan_snapshots
        SET summary = summary || '{"outOfBandChange":true}'::jsonb
      WHERE plan_id = $1`,
    [seeded.id]
  );
  const changed = await fixture.request(`/api/dispatch/v2/bootstrap?planId=${seeded.id}&date=${seeded.plan_date}`);
  assert.equal(changed.payload.plan.revision, initial.payload.plan.revision);
  assert.notEqual(changed.payload.plan.digest, initial.payload.plan.digest);

  const result = await fixture.request(`/api/dispatch/v2/plans/${seeded.id}/commands`, {
    method: "POST",
    headers: { "x-dispatch-edit-lease": lease },
    body: {
      commandId: "dp10-digest-mismatch",
      baseRevision: initial.payload.plan.revision,
      baseDigest: initial.payload.plan.digest,
      sessionId: "dispatch-v2-digest",
      commandType: "remove_order",
      payload: { orderRef: "DP-DIGEST-A" }
    }
  });
  assert.equal(result.response.status, 409, JSON.stringify(result.payload));
  assert.equal(result.payload.code, "STALE_DISPATCH_PLAN");
  assert.equal(
    (await query("SELECT count(*)::int AS count FROM dispatch_plan_commands WHERE command_id = 'dp10-digest-mismatch'")).rows[0].count,
    0
  );
});
