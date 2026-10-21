import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { app } from "../src/server.js";
import { createOperator } from "../src/auth-repository.js";
import { query, closeDb } from "../src/db.js";
import { consolidateCompatibleDrafts, persistPurchaseStockDrafts } from "../src/smart-scm-planning-repository.js";

assert.equal(process.env.MBT_TEST_ISOLATED, "1");
assert.equal(new URL(process.env.DATABASE_URL).hostname, "db");
const directory = "test-artifacts/scm-ultimate-packing-20261005";
const fixture = JSON.parse(readFileSync(`${directory}/replay-input.json`, "utf8"));
const original = fixture.plans.find((plan) => Number(plan.id) === 429);
const drafts = original.proposals.filter((proposal) => Number(proposal.sourceVendorYardId) === 73)
  .map((proposal) => ({ ...proposal, lines: proposal.lines.map((line) => ({ ...line, confirmedPallets: 0,
    residualPallets: Number(line.proposedPallets) })) }));
const packed = consolidateCompatibleDrafts(drafts, original.settings_snapshot, "runtime-replay-429");
let server;
try {
  await query("INSERT INTO dispatch_vendor_yards(id,vendor,yard) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING",
    [73, drafts[0].vendor, drafts[0].plant || drafts[0].sourceName]);
  const run = (await query(`INSERT INTO scm_smart_planning_runs(status,trigger_source,settings_snapshot,completed_at)
    VALUES('ready','ultimate-runtime',$1::jsonb,now()) RETURNING id`, [JSON.stringify(original.settings_snapshot)])).rows[0];
  await persistPurchaseStockDrafts(run.id, packed);
  const username = `urgency-runtime-${randomUUID()}`;
  const password = randomUUID();
  await createOperator({ username, displayName: "Urgency replay", password, role: "scm", roles: ["scm"] });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }) });
  assert.equal(login.status, 200);
  const token = (await login.json()).token;
  assert.equal((await fetch(`${base}/api/scm/smart/planning-runs/${run.id}`)).status, 401);
  const response = await fetch(`${base}/api/scm/smart/planning-runs/${run.id}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  const saved = await response.json();
  const matching = saved.proposals.filter((proposal) => proposal.lines.some((line) =>
    Number(line.destinationLocationId) === 28 && line.urgencyLevel === "ultimate_urgent"));
  assert.equal(matching.length, 1);
  const quantity = matching[0].lines.filter((line) => Number(line.destinationLocationId) === 28
    && line.urgencyLevel === "ultimate_urgent").reduce((sum, line) => sum + Number(line.proposedPallets), 0);
  assert.equal(quantity, 25);
  assert.equal(saved.proposals.length, packed.length);
  for (const proposal of saved.proposals) {
    assert.ok(proposal.totalWeightLbs <= Number(original.settings_snapshot.truck_capacity_lbs) + 0.000001);
  }
  const html = await fetch(`${base}/scm-smart.html`);
  assert.equal(html.status, 200);
  assert.ok((await html.text()).includes("&urgency=20261005-v1"));
  const js = await fetch(`${base}/scm-smart-proposals.js`);
  assert.equal(js.status, 200);
  assert.equal(await js.text(), readFileSync("public/scm-smart-proposals.js", "utf8"));
  const result = { health: 200, login: 200, anonymousPlanning: 401, authenticatedPlanning: 200,
    sourcePlan: 429, sourceVendorYardId: 73, urgentDestination: 28, urgentPallets: quantity,
    urgentLoads: matching.length, totalSourceLoads: saved.proposals.length, assets: 2 };
  writeFileSync(`${directory}/final/runtime.json`, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await closeDb();
}
