// @ts-check

import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { createOperator, loginOperator } from "../../../src/auth-repository.js";
import { config } from "../../../src/config.js";
import { closeDb, query } from "../../../src/db.js";
import { getDispatchPlan } from "../../../src/dispatch-plan-repository.js";
import { app } from "../../../src/server.js";
import { assignMbtBinFrontLeg } from "../../../src/mbt/bin-dispatch-service.js";
import {
  binAssignmentCommand,
  binDispatchPlanDate,
  createBinDispatchFixture,
  enabledBinDispatchBoundary
} from "../support/bin-dispatch-fixtures.js";

const suffix = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 9)}`;
const username = `p311-confirm-http-${suffix}`;
const password = "synthetic-p311-confirm-http-password";
const sessionPrefix = `p311-confirm-http-session-${suffix}`;
const originalEnvironment = {
  enabled: config.mbt.enabled,
  binDispatchEnabled: config.mbtPhase3.binDispatchEnabled
};
let originalFlags = [];
let token = "";
let server;
let baseUrl = "";

/** @param {string} path @param {{method?: string, body?: unknown}} [options] */
async function request(path, { method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { response, payload: await response.json().catch(() => ({})) };
}

/** @param {string} planDate @param {string} sessionId */
async function acquireLease(planDate, sessionId) {
  const result = await request("/api/dispatch/plan-edit-lease/acquire", {
    method: "POST",
    body: { planDate, sessionId }
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  return String(result.payload.editLeaseToken);
}

/** @param {Record<string, any>} plan */
function uiShapedTrucks(plan) {
  return structuredClone(plan.trucks).map((truck) => ({
    ...truck,
    loads: (truck.loads || []).map((load) => ({
      ...load,
      stops: (load.stops || []).map((stop, index) => stop?.mbt ? {
        ...stop,
        loadId: String(load.id),
        timing: { arrival: 720 + index * 30, depart: 745 + index * 30 }
      } : stop)
    }))
  }));
}

/** @param {Record<string, any>} plan @param {string} editLeaseToken @param {string} sessionId @param {Record<string, any>[]} trucks @param {Record<string, any>[]} [orders] */
function confirmBody(plan, editLeaseToken, sessionId, trucks, orders = plan.orders) {
  return {
    planId: String(plan.id),
    planDate: plan.planDate,
    editLeaseToken,
    baseRevision: null,
    orders,
    trucks,
    summary: plan.summary,
    audit: {
      sessionId,
      action: "dispatch_plan_confirmed",
      details: { planDate: plan.planDate, saveMode: "confirm" }
    }
  };
}

/** @param {string} planId */
async function durableState(planId) {
  const selected = await query(
    `SELECT plan.status, plan.revision::int, snapshot.orders, snapshot.trucks
       FROM dispatch_plans plan
       JOIN dispatch_plan_snapshots snapshot ON snapshot.plan_id = plan.id
      WHERE plan.id = $1`,
    [planId]
  );
  return selected.rows[0];
}

/** @param {string} label @param {number} offset */
async function assignedFixture(label, offset) {
  const fixture = await createBinDispatchFixture({ label, planDate: binDispatchPlanDate(offset) });
  const selected = await query("SELECT trucks FROM dispatch_plan_snapshots WHERE plan_id = $1", [fixture.planId]);
  const snapshotTrucks = structuredClone(selected.rows[0].trucks);
  snapshotTrucks[1].driverId = null;
  snapshotTrucks[1].driverLogin = "";
  snapshotTrucks[1].loads[0].driverId = null;
  snapshotTrucks[1].loads[0].driverLogin = "";
  await query(
    "UPDATE dispatch_plan_snapshots SET trucks = $2::jsonb WHERE plan_id = $1",
    [fixture.planId, JSON.stringify(snapshotTrucks)]
  );
  await assignMbtBinFrontLeg(binAssignmentCommand(fixture, label), {
    capability: enabledBinDispatchBoundary
  });
  const plan = await getDispatchPlan(fixture.planId);
  assert.ok(plan);
  return { fixture, plan };
}

before(async () => {
  originalFlags = (await query(
    `SELECT flag_key, enabled, revision, updated_by, updated_at
       FROM mbt_feature_flags
      WHERE flag_key = ANY($1::text[])
      ORDER BY flag_key`,
    [["mbt_enabled", "mbt_bin_dispatch"]]
  )).rows;
  config.mbt.enabled = true;
  config.mbtPhase3.binDispatchEnabled = true;
  await query(
    `UPDATE mbt_feature_flags SET enabled = true, updated_by = $2, updated_at = now()
      WHERE flag_key = ANY($1::text[])`,
    [["mbt_enabled", "mbt_bin_dispatch"], username]
  );
  await createOperator({
    username,
    displayName: "P3.11 Confirm HTTP Dispatcher",
    password,
    role: "dispatcher",
    roles: ["dispatcher"]
  });
  token = (await loginOperator(username, password)).token;
  server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {await new Promise((resolve) => server.close(resolve));}
  config.mbt.enabled = originalEnvironment.enabled;
  config.mbtPhase3.binDispatchEnabled = originalEnvironment.binDispatchEnabled;
  for (const flag of originalFlags) {
    await query(
      `UPDATE mbt_feature_flags
          SET enabled = $2, revision = $3, updated_by = $4, updated_at = $5
        WHERE flag_key = $1`,
      [flag.flag_key, flag.enabled, flag.revision, flag.updated_by, flag.updated_at]
    ).catch(() => undefined);
  }
  await closeDb();
});

test("P3.11 HTTP Confirm: UI-only MBT loadId/timing is a no-op and reaches locked dedicated confirmation", async () => {
  const { fixture, plan } = await assignedFixture("http-noop", 1900);
  const sessionId = `${sessionPrefix}-noop`;
  const lease = await acquireLease(fixture.planDate, sessionId);
  const result = await request(`/api/dispatch/plans/${fixture.planId}/confirm`, {
    method: "POST",
    body: confirmBody(plan, lease, sessionId, uiShapedTrucks(plan))
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.status, "confirmed");
  assert.equal(Number(result.payload.revision), 3);
});

const changedCases = [
  ["action", (trucks) => {
    trucks[0].loads[0].stops[0].actionCode = "return_bin";
  }],
  ["asset", (trucks) => {
    trucks[0].loads[0].stops[0].assetId = "00000000-0000-4000-8000-000000000999";
  }],
  ["marker", (trucks) => {
    trucks[0].loads[0].stops[0].mbt.mandatory = false;
  }],
  ["moved group", (trucks) => {
    trucks[0].loads[1].stops.push(trucks[0].loads[0].stops.pop());
  }]
];

for (const [index, [label, mutate]] of changedCases.entries()) {
  test(`P3.11 HTTP Confirm: changed BIN ${label} enters generic fail-closed save with zero writes`, async () => {
    const { fixture, plan } = await assignedFixture(`http-changed-${String(label).replaceAll(" ", "-")}`, 1901 + index);
    const sessionId = `${sessionPrefix}-${String(label).replaceAll(" ", "-")}`;
    const lease = await acquireLease(fixture.planDate, sessionId);
    const stateBefore = await durableState(fixture.planId);
    const trucks = uiShapedTrucks(plan);
    mutate(trucks);
    const result = await request(`/api/dispatch/plans/${fixture.planId}/confirm`, {
      method: "POST",
      body: confirmBody(plan, lease, sessionId, trucks)
    });
    assert.equal(result.response.status, 409, JSON.stringify(result.payload));
    assert.equal(result.payload.code, "MBT_CAPABILITY_DISABLED");
    assert.deepEqual(await durableState(fixture.planId), stateBefore);
  });
}

test("P3.11 HTTP Confirm: an ordinary order change cannot piggyback on an unchanged BIN group", async () => {
  const { fixture, plan } = await assignedFixture("http-ordinary-change", 1905);
  const sessionId = `${sessionPrefix}-ordinary-change`;
  const lease = await acquireLease(fixture.planDate, sessionId);
  const stateBefore = await durableState(fixture.planId);
  const orders = [...plan.orders, {
    id: `P311-SO-${suffix}`,
    type: "SO",
    customer: "Synthetic unpersisted ordinary order",
    address: "1 Example Road",
    localDispatchStatus: "open",
    items: []
  }];
  const result = await request(`/api/dispatch/plans/${fixture.planId}/confirm`, {
    method: "POST",
    body: confirmBody(plan, lease, sessionId, uiShapedTrucks(plan), orders)
  });
  assert.equal(result.response.status, 409, JSON.stringify(result.payload));
  assert.equal(result.payload.code, "MBT_CAPABILITY_DISABLED");
  assert.deepEqual(await durableState(fixture.planId), stateBefore);
});
