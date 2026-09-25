// Read-only deployment probes; no operator confirmation or NetSuite posting.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { getReceivingOrder } from "/app/src/receiving-repository.js";
import { closeDb } from "/app/src/db.js";

const assets = EXPECTED_ASSETS;
try {
  for (const base of ["http://127.0.0.1:3000", "https://test.mbbsoperation.com"]) {
    const health = await fetch(base + "/health");
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
    for (const [name, sha] of Object.entries(assets)) {
      const response = await fetch(base + "/" + name.replace("public/", ""), { headers: { "Cache-Control": "no-cache" } });
      assert.equal(response.status, 200, name);
      assert.equal(crypto.createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex"), sha, name);
    }
  }
  const source = readFileSync("/app/public/operator.js", "utf8"), context = vm.createContext({});
  for (const name of ["qty", "receivingRemainingSalesQty", "hasReceivingRemainingQty"]) {
    const start = source.indexOf("function " + name + "("), end = source.indexOf("\n}", start) + 2;
    assert.ok(start >= 0 && end > start);
    new vm.Script(source.slice(start, end)).runInContext(context);
  }
  const parent = await getReceivingOrder(945685), split = await getReceivingOrder(-260063887792827);
  const balances = order => order.lines.filter(line => context.hasReceivingRemainingQty(line)).map(line => [line.sku, Number(line.quantity)]);
  assert.deepEqual(balances(parent), [["OAK-RKT-SG-1272", 108], ["OAK-PAV-AB-2424", 304], ["OAK-PAV-HL-1224", 228]]);
  assert.equal(balances(split).length, 14);
  assert.deepEqual(balances(split), [
    ["OAK-PAV-AL-2424", 152], ["OAK-RKT-HL-1248", 72], ["OAK-RKT-SB-1472", 126], ["OAK-RKT-SG-1448", 84],
    ["OAK-RKT-AL-1472", 126], ["OAK-RKT-AB-1248", 72], ["OAK-PAV-BLK-1224", 228], ["OAK-STEP-BLK-1672", 48],
    ["OAK-PAV-HL-1224", 228], ["OAK-RKT-HL-1272", 108], ["OAK-RKT-HL-1472", 126], ["OAK-PAV-HB-2424", 456],
    ["OAK-PAV-AB-2424", 248], ["OAK-RKT-HB-1672", 288]
  ]);
  const prior = await getReceivingOrder(990616);
  // The operator completed SO11663 after its earlier display fix. The read-only
  // pre-release snapshot now records receipt_status=received and no open lines.
  assert.equal(prior.receipt_status, "received");
  assert.equal(balances(prior).length, 0);
  console.log(JSON.stringify({ health: 200, publicAssetHashesVerified: 6, order: parent.tranid,
    openLines: balances(parent), split: split.tranid, splitLines: 14, priorOrder: prior.tranid,
    priorReceiptStatus: prior.receipt_status, priorOpenLines: 0, liveReceiptSubmissions: 0 }));
} finally { await closeDb(); }
