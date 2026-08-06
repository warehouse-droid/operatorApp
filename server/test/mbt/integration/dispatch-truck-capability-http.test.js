// @ts-check

import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { createOperator, loginOperator } from "../../../src/auth-repository.js";
import { config } from "../../../src/config.js";
import { closeDb, query } from "../../../src/db.js";
import { replaceDispatchFleetSetup } from "../../../src/dispatch-setup-repository.js";
import { app } from "../../../src/server.js";

const suffix = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 9)}`;
const dispatcherUsername = `p3-bin-http-dispatcher-${suffix}`;
const salesUsername = `p3-bin-http-sales-${suffix}`;
const plate = `P3-BIN-HTTP-${suffix}`.toUpperCase();
const password = "synthetic-p3-bin-http-password";
const originalEnvironment = {
  enabled: config.mbt.enabled,
  masterDataEnabled: config.mbtPhase3.masterDataEnabled
};
let originalFlags = [];
let dispatcher;
let sales;
let truck;
let server;
let baseUrl = "";

/** @param {string} path @param {{token?: string, method?: string, body?: unknown, key?: string}} [options] */
async function request(path, { token = "", method = "GET", body, key = "" } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(key ? { "idempotency-key": key } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { response, payload: await response.json().catch(() => ({})) };
}

function capabilityBody(expectedRevision = 1, truckType = "bin") {
  return {
    expectedRevision,
    actor: { operatorId: "forged-browser-actor", roles: ["admin"] },
    capability: {
      truckType,
      capacityLbs: 52000,
      travelTimePercent: 7,
      baseYard: "3445",
      binSlotCapacity: truckType === "bin" ? 2 : 0,
      supportedBinTypeCodes: truckType === "bin" ? ["14YD", "20YD"] : []
    },
    reason: `Synthetic ${truckType} capability setup`
  };
}

before(async () => {
  originalFlags = (await query(
    `SELECT flag_key, enabled, revision, updated_by, updated_at
       FROM mbt_feature_flags
      WHERE flag_key = ANY($1::text[])
      ORDER BY flag_key`,
    [["mbt_enabled", "mbt_master_data"]]
  )).rows;
  config.mbt.enabled = false;
  config.mbtPhase3.masterDataEnabled = false;
  await createOperator({ username: dispatcherUsername, displayName: "P3 BIN Dispatcher", password, role: "dispatcher" });
  await createOperator({ username: salesUsername, displayName: "P3 BIN Sales", password, role: "sales" });
  dispatcher = await loginOperator(dispatcherUsername, password);
  sales = await loginOperator(salesUsername, password);
  const fleet = await replaceDispatchFleetSetup({
    drivers: [],
    trucks: [{ plate, capacityLbs: 48000, travelTimePercent: 0, baseYard: "3445", active: true }]
  }, { activeOnly: false, deactivateMissing: false });
  truck = fleet.trucks.find((candidate) => candidate.plate === plate);
  assert.ok(truck);
  server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  config.mbt.enabled = originalEnvironment.enabled;
  config.mbtPhase3.masterDataEnabled = originalEnvironment.masterDataEnabled;
  for (const flag of originalFlags) {
    await query(
      `UPDATE mbt_feature_flags
          SET enabled = $2, revision = $3, updated_by = $4, updated_at = $5
        WHERE flag_key = $1`,
      [flag.flag_key, flag.enabled, flag.revision, flag.updated_by, flag.updated_at]
    ).catch(() => undefined);
  }
  if (truck?.id) {
    await query("DELETE FROM dispatch_truck_capability_history WHERE truck_id = $1", [truck.id]).catch(() => undefined);
    await query("DELETE FROM dispatch_truck_bin_types WHERE truck_id = $1", [truck.id]).catch(() => undefined);
    await query("DELETE FROM dispatch_trucks WHERE id = $1", [truck.id]).catch(() => undefined);
  }
  await query(
    "DELETE FROM mbt_command_receipts WHERE actor_operator_id IN (SELECT id::text FROM operators WHERE username = ANY($1::text[]))",
    [[dispatcherUsername, salesUsername]]
  ).catch(() => undefined);
  await query(
    "DELETE FROM mbt_audit_events WHERE actor_operator_id IN (SELECT id::text FROM operators WHERE username = ANY($1::text[]))",
    [[dispatcherUsername, salesUsername]]
  ).catch(() => undefined);
  await query("DELETE FROM operators WHERE username = ANY($1::text[])", [[dispatcherUsername, salesUsername]]).catch(() => undefined);
  await closeDb();
});

test("P3-F10 HTTP hardening: typed truck capabilities are private, gated, server-actor-bound, optimistic, and exactly replayable", async () => {
  const path = `/api/dispatch/setup/trucks/${truck.id}/capabilities`;
  let result = await request(path, { method: "PUT", body: capabilityBody() });
  assert.equal(result.response.status, 401);
  assert.match(result.response.headers.get("cache-control") || "", /no-store/);

  result = await request(path, { token: sales.token, method: "PUT", body: capabilityBody(), key: `${suffix}-sales` });
  assert.equal(result.response.status, 403);
  assert.match(result.response.headers.get("cache-control") || "", /no-store/);

  result = await request(path, { token: dispatcher.token, method: "PUT", body: capabilityBody() });
  assert.equal(result.response.status, 400);
  assert.equal(result.payload.code, "MBT_IDEMPOTENCY_KEY_REQUIRED");
  assert.match(result.response.headers.get("cache-control") || "", /no-store/);

  result = await request(path, {
    token: dispatcher.token,
    method: "PUT",
    body: capabilityBody(),
    key: `${suffix}-closed`
  });
  assert.equal(result.response.status, 409);

  config.mbt.enabled = true;
  config.mbtPhase3.masterDataEnabled = true;
  await query(
    `UPDATE mbt_feature_flags
        SET enabled = true, updated_by = $2, updated_at = now()
      WHERE flag_key = ANY($1::text[])`,
    [["mbt_enabled", "mbt_master_data"], String(dispatcher.operator.id)]
  );

  const key = `${suffix}-bin`;
  result = await request(path, { token: dispatcher.token, method: "PUT", body: capabilityBody(), key });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.response.headers.get("x-mbt-idempotent-replay"), "false");
  assert.equal(result.payload.truck.truckType, "bin");
  assert.equal(result.payload.truck.revision, 2);

  const replay = await request(path, { token: dispatcher.token, method: "PUT", body: capabilityBody(), key });
  assert.equal(replay.response.status, 200, JSON.stringify(replay.payload));
  assert.equal(replay.response.headers.get("x-mbt-idempotent-replay"), "true");
  assert.deepEqual(replay.payload, result.payload);

  const persisted = await query(
    `SELECT truck.revision::int AS revision,
            truck.truck_type,
            count(history.capability_history_id)::int AS history_count,
            (SELECT actor_operator_id
               FROM mbt_audit_events
              WHERE entity_type = 'dispatch_truck' AND entity_id = truck.id::text
              ORDER BY occurred_at DESC LIMIT 1) AS audit_actor
       FROM dispatch_trucks truck
       LEFT JOIN dispatch_truck_capability_history history ON history.truck_id = truck.id
      WHERE truck.id = $1
      GROUP BY truck.id`,
    [truck.id]
  );
  assert.deepEqual(persisted.rows[0], {
    revision: 2,
    truck_type: "bin",
    history_count: 1,
    audit_actor: String(dispatcher.operator.id)
  });

  const stale = await request(path, {
    token: dispatcher.token,
    method: "PUT",
    body: capabilityBody(1, "flatbed"),
    key: `${suffix}-stale`
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.payload.code, "DISPATCH_TRUCK_STALE_REVISION");
});
