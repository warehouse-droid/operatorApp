// Read-only HTTP verification of the restored splits and their delivered siblings.
// Run from /app with: docker exec -i <app> node --input-type=module - < this-file
// Temporary diagnostic authentication is removed in finally. No order or plan is saved.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { query, withTransaction, closeDb } from "./src/db.js";

const refs = ["SOM06255-S2", "SOM06256-S2"];
const siblings = ["SOM06255-S1", "SOM06256-S1"];
const operatorId = randomUUID();
const username = `dispatch-s2-search-check-${operatorId}`;
const token = randomBytes(32).toString("base64url");
const sha = value => createHash("sha256").update(value).digest("hex");
const result = { mode: "live-http-read-verification", requests: [] };

async function sourceFingerprint() {
  const rows = (await query(`SELECT to_jsonb(s) AS header,
    (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM sales_order_lines l
      WHERE l.sales_order_id=s.netsuite_id) AS lines
    FROM sales_orders s WHERE tranid LIKE 'SOM06255%' OR tranid LIKE 'SOM06256%'
    ORDER BY s.tranid`)).rows;
  return sha(JSON.stringify(rows));
}

try {
  const before = await sourceFingerprint();
  await withTransaction(async () => {
    await query(`INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active)
      VALUES($1,$2,'Temporary Dispatch split-search verification',$3,$4,'dispatcher',ARRAY['dispatcher'],true)`,
    [operatorId, username, randomBytes(64).toString("hex"), randomBytes(32).toString("hex")]);
    await query(`INSERT INTO operator_sessions(token_hash,operator_id,expires_at)
      VALUES($1,$2,now()+interval '15 minutes')`, [sha(token), operatorId]);
  });
  for (const path of ["/api/dispatch/orders", "/api/dispatch/v2/order-pool"]) {
    for (const search of [...refs, "SOM0625"]) {
      const started = performance.now();
      const response = await fetch(`http://127.0.0.1:3000${path}?${new URLSearchParams({search})}`, {
        headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60000)
      });
      const payload = await response.json();
      assert.equal(response.status, 200, JSON.stringify(payload));
      const orders = path.includes("/v2/") ? payload.orders : payload;
      assert.ok(Array.isArray(orders));
      const expected = search === "SOM0625" ? [...refs, ...siblings] : [search];
      for (const ref of expected) {
        assert.ok(orders.some(order => order.id === ref), `${path}: missing ${ref}`);
      }
      const check = { path, search, status: response.status, found: expected,
        ms: Math.round(performance.now()-started), orders: orders.filter(order => expected.includes(order.id))
          .map(order => ({ id: order.id, salesQty: order.salesQty, operatorStatus: order.operatorStatus,
            dispatchPlanned: order.dispatchPlanned === true, dispatchCompletionStatus: order.dispatchCompletionStatus,
            dispatchPlanningRestricted: order.dispatchPlanningRestricted === true })) };
      result.requests.push(check);
      process.stderr.write(`Verified ${path}: ${search}, ${check.ms} ms.\n`);
    }
  }
  assert.equal(await sourceFingerprint(), before, "Source orders or lines changed during search verification");
  result.sourceOrdersAndLinesUnchanged = true;
  const splits = (await query(`SELECT split_ref,active FROM dispatch_global_order_splits
    WHERE split_ref=ANY($1::text[]) ORDER BY split_ref`, [refs])).rows;
  assert.equal(splits.length, 2);
  assert.ok(splits.every(row => row.active));
  result.restoredSplitsStillActive = true;
} catch (error) {
  result.error = { name: error.name, message: error.message };
  throw error;
} finally {
  try {
    await withTransaction(async () => {
      await query("DELETE FROM operator_sessions WHERE operator_id=$1 AND token_hash=$2", [operatorId, sha(token)]);
      await query("DELETE FROM operators WHERE id=$1 AND username=$2", [operatorId, username]);
    });
    const remaining = (await query(`SELECT
      (SELECT count(*) FROM operators WHERE id=$1) +
      (SELECT count(*) FROM operator_sessions WHERE operator_id=$1) AS count`, [operatorId])).rows[0];
    assert.equal(Number(remaining.count), 0);
    result.diagnosticAuthenticationRemoved = true;
  } finally {
    await closeDb();
    console.log(JSON.stringify(result));
  }
}
