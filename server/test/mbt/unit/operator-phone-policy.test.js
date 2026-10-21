import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { readFileSync } from "node:fs";
import { getOperatorPhonePolicy, materializeOperatorPhonePolicy } from "../../../src/operator-phone-policy.js";
import { createOperatorPhonePolicyRouter } from "../../../src/operator-phone-policy-router.js";
import { materializeMbtAdminGates, MBT_ADMIN_WRITABLE_GATE_KEYS } from "../../../src/mbt/feature-gate-catalog.js";

test("phone rollout is disabled unless the database flag is explicitly true", () => {
  for (const row of [null, undefined, {}, { enabled: false }, { enabled: "true" }, { enabled: 1 }]) {
    assert.equal(materializeOperatorPhonePolicy(row).enabled, false);
  }
  assert.deepEqual(materializeOperatorPhonePolicy({ enabled: true, revision: 7 }), {
    flagKey: "operator_phone_layout", enabled: true, revision: 7
  });
  assert.equal(materializeOperatorPhonePolicy({ enabled: true, revision: "7" }).revision, 7);
  for (const revision of [undefined, 0, -1, "invalid", "9007199254740992"]) {
    assert.equal(materializeOperatorPhonePolicy({ enabled: true, revision }).revision, null);
  }
});

test("policy reads the live Operator phone gate without caching", async () => {
  let enabled = true;
  const queryFn = async (sql, values) => {
    assert.match(sql, /FROM mbt_feature_flags/);
    assert.deepEqual(values, ["operator_phone_layout"]);
    return { rows: [{ enabled, revision: 2 }] };
  };
  assert.equal((await getOperatorPhonePolicy({ queryFn })).enabled, true);
  enabled = false;
  assert.equal((await getOperatorPhonePolicy({ queryFn })).enabled, false);
  assert.equal((await getOperatorPhonePolicy({ queryFn: async () => ({ rows: [] }) })).enabled, false);
});

test("Admin owns an independent default-off phone gate", () => {
  assert.ok(MBT_ADMIN_WRITABLE_GATE_KEYS.includes("operator_phone_layout"));
  const gates = flags => materializeMbtAdminGates({ flags, environment: { enabled: false } }).find(row => row.flagKey === "operator_phone_layout");
  assert.equal(gates([]).effective, false);
  assert.equal(gates([]).locked, true);
  assert.equal(gates([{ flagKey: "operator_phone_layout", enabled: false, revision: 1 }]).effective, false);
  assert.equal(gates([{ flagKey: "operator_phone_layout", enabled: true, revision: 2 }]).effective, true);
  const migration = readFileSync("migrations/272_operator_phone_layout.sql", "utf8");
  assert.match(migration, /'operator_phone_layout',\s+false/);
  assert.match(migration, /ON CONFLICT \(flag_key\) DO NOTHING/);
});

test("policy HTTP reads never cache and surface unavailable gates as errors", async () => {
  let unavailable = false;
  const app = express();
  app.use("/policy", createOperatorPhonePolicyRouter({ readPolicy: async () => {
    if (unavailable) throw new Error("Unavailable test database");
    return { flagKey: "operator_phone_layout", enabled: true, revision: 1 };
  } }));
  app.use((error, _req, res, _next) => res.status(503).json({ error: error.message }));
  let server;
  try {
    server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}/policy`;
    const response = await fetch(base);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json()).enabled, true);
    unavailable = true;
    assert.equal((await fetch(base)).status, 503);
  } finally { if (server) await new Promise(resolve => server.close(resolve)); }
  const source = readFileSync("src/server.js", "utf8");
  assert.match(source, /app\.use\("\/api\/operator\/phone-layout-policy", requireOperator, requireOperatorAccess, createOperatorPhonePolicyRouter\(\)\)/);
});
