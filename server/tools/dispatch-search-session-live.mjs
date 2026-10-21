// Exercise the released browser request builder against the running HTTP APIs.
// Temporary diagnostic credentials/lease are removed in finally; no plan/order is edited.
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { query, withTransaction, closeDb } from "../src/db.js";

const id = randomUUID();
const sessionId = `dispatch-search-check-${id}`;
const username = `dispatch-search-check-${id}`;
const auth = randomBytes(32).toString("base64url");
const lease = randomBytes(32).toString("base64url");
const hash = value => createHash("sha256").update(value).digest("hex");
const date = "1900-01-01";
const refs = ["TOB01164", "TOB01163"];
// Operational verification allows the measured baseline search latency (~18s).
// This does not change the browser regression suite or its performance checks.
const httpTimeoutMs = 60000;
const source = await readFile("/app/public/dispatch.js", "utf8");
const start = source.indexOf("function dispatchOrderFeedRequest(");
const end = source.indexOf("\nfunction timeText(", start);
assert.ok(start > 0 && end > start);
const context = vm.createContext({ URLSearchParams, currentPlanDate: date, dispatchSessionId: sessionId,
  planEditLeaseToken: lease, history: true });
vm.runInContext(`function isDispatchHistoryEditMode() { return history; }\n${source.slice(start, end)}`, context);
const snapshot = async () => (await query(`SELECT t.tranid,
  md5(jsonb_build_object('order',to_jsonb(t),'lines',
    (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.line_stage,l.id) FROM transfer_order_lines l WHERE l.transfer_order_id=t.netsuite_id))::text) AS hash
  FROM transfer_orders t WHERE t.tranid=ANY($1::text[]) ORDER BY t.tranid`, [refs])).rows;
const before = await snapshot();
assert.equal(before.length, 2);
const result = { requests: [], diagnosticRecordsRemoved: false, ordersUnchanged: false };
try {
  await withTransaction(async () => {
    await query(`INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active)
      VALUES($1,$2,'Temporary Dispatch search verification',$3,$4,'dispatcher',ARRAY['dispatcher'],true)`,
    [id, username, randomBytes(64).toString("hex"), randomBytes(32).toString("hex")]);
    await query(`INSERT INTO operator_sessions(token_hash,operator_id,expires_at)
      VALUES($1,$2,now()+interval '15 minutes')`, [hash(auth), id]);
    const inserted = await query(`INSERT INTO dispatch_plan_edit_leases
      (plan_date,operator_id,operator_name,session_id,token_hash,acquired_at,heartbeat_at,expires_at,updated_at)
      VALUES($1,$2,'Temporary Dispatch search verification',$3,$4,now(),now(),now()+interval '15 minutes',now())
      ON CONFLICT (plan_date) DO NOTHING`, [date, id, sessionId, hash(lease)]);
    assert.equal(inserted.rowCount, 1, "Diagnostic lease date is already in use; do not replace it");
  });
  for (const history of [false, true]) {
    context.history = history;
    for (const versioned of [false, true]) {
      for (const ref of refs) {
        const request = context.dispatchOrderFeedRequest({ search: ref, versioned });
        if (process.env.DISPATCH_SEARCH_WARMUP_PROBE === "1") {
          const url = new URL(request.url, "http://127.0.0.1:3000");
          url.pathname = versioned ? "/api/dispatch/v2/order-pool" : "/api/dispatch/orders";
          if (history) url.searchParams.set("sessionId", sessionId);
          request.url = url.pathname + url.search;
          result.repairedContextProbe = true;
        }
        result.attempt = { ref, history, versioned, path: request.url, startedAt: new Date().toISOString() };
        const started = performance.now();
        const response = await fetch(`http://127.0.0.1:3000${request.url}`, {
          headers: { authorization: `Bearer ${auth}`, ...request.headers }, signal: AbortSignal.timeout(httpTimeoutMs)
        });
        const payload = await response.json();
        assert.equal(response.status, 200, JSON.stringify(payload));
        const orders = versioned ? payload.orders : payload;
        assert.ok(Array.isArray(orders));
        result.requests.push({ ref, history, versioned, status: response.status,
          found: orders.some(order => order.id === ref), returned: orders.length, ms: Math.round(performance.now() - started) });
      }
    }
  }
  assert.deepEqual(await snapshot(), before);
  result.ordersUnchanged = true;
} catch (error) {
  result.error = { name: error.name, message: error.message };
  throw error;
} finally {
  await query("DELETE FROM dispatch_plan_edit_leases WHERE operator_id=$1 AND session_id=$2", [id, sessionId]);
  await query("DELETE FROM operator_sessions WHERE operator_id=$1 AND token_hash=$2", [id, hash(auth)]);
  await query("DELETE FROM operators WHERE id=$1 AND username=$2", [id, username]);
  result.diagnosticRecordsRemoved = (await query(`SELECT
    (SELECT count(*) FROM operators WHERE id=$1) +
    (SELECT count(*) FROM operator_sessions WHERE operator_id=$1) +
    (SELECT count(*) FROM dispatch_plan_edit_leases WHERE operator_id=$1::text AND session_id=$2) AS count`, [id, sessionId])).rows[0].count === "0";
  assert.equal(result.diagnosticRecordsRemoved, true);
  await closeDb();
  console.log(JSON.stringify(result));
}
