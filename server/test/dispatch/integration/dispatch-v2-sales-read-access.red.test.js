// @ts-check

import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { createDispatchV2Fixture } from "../support/dispatch-v2-fixture.js";

let fixture;
let seeded;

before(async () => {
  fixture = await createDispatchV2Fixture({ role: "sales" });
  seeded = await fixture.seedPlan({
    date: "2098-08-14",
    refs: ["TST-SALES-DISPATCH-V2"]
  });
});

after(async () => {
  await fixture?.close();
});

test("Sales can read Dispatch v2 planning but cannot mutate it", async () => {
  const bootstrap = await fixture.request(
    `/api/dispatch/v2/bootstrap?planId=${encodeURIComponent(seeded.id)}&date=${seeded.plan_date}`
  );
  assert.equal(bootstrap.response.status, 200, JSON.stringify(bootstrap.payload));
  assert.equal(bootstrap.payload.plan?.id, seeded.id);

  const orderFeed = await fixture.request("/api/dispatch/v2/order-feed/TST-SALES-DISPATCH-V2");
  assert.equal(orderFeed.response.status, 404,
    "A missing order may return 404, but the Sales read must pass authorization instead of returning 403.");

  const mutation = await fixture.request(`/api/dispatch/v2/plans/${seeded.id}/commands`, {
    method: "POST",
    body: {
      commandId: "sales-must-not-write",
      baseRevision: seeded.revision,
      commandType: "replace_plan",
      payload: { orders: [], trucks: [] }
    }
  });
  assert.equal(mutation.response.status, 403,
    "Restoring read-only Sales planning access must not grant Dispatch mutation authority.");
});
