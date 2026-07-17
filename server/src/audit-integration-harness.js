import assert from "node:assert/strict";

const { app } = await import("./server.js");
const { createOperator, listAudit, listAuditOptions } = await import("./auth-repository.js");
const { writeDispatchAudit } = await import("./dispatch-audit-repository.js");
const { closeDb, query } = await import("./db.js");

const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const username = `audit_harness_${runId}`;
const presetName = `Audit Harness ${runId}`;
const vrmaRef = `VRMA-AUDIT-${runId}`;
let operator = null;
let server = null;

async function jsonRequest(baseUrl, path, { method = "GET", token = "", body = null } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  return { response, payload: text ? JSON.parse(text) : null };
}

async function waitForFallbackAudit(operatorId) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await query(
      `SELECT *
         FROM delivery_audit_log
        WHERE actor_operator_id = $1
          AND action = 'application.post.scm.view.presets'
        ORDER BY id DESC
        LIMIT 1`,
      [operatorId]
    );
    if (result.rows[0]) return result.rows[0];
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

try {
  operator = await createOperator({
    username,
    displayName: "Audit Integration Harness",
    password: "AuditHarness123",
    role: "scm"
  });
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const login = await jsonRequest(baseUrl, "/api/auth/login", {
    method: "POST",
    body: { username, password: "AuditHarness123" }
  });
  assert.equal(login.response.status, 200, "Audit harness login should succeed");

  const preset = await jsonRequest(baseUrl, "/api/scm/view-presets", {
    method: "POST",
    token: login.payload.token,
    body: {
      name: presetName,
      description: "Fallback audit coverage",
      config: { mode: "audit-harness" },
      secret: "must-not-be-recorded"
    }
  });
  assert.equal(preset.response.status, 200, "The unaudited SCM mutation should succeed");

  const fallback = await waitForFallbackAudit(operator.id);
  assert.ok(fallback, "A mutating route without a semantic event must receive a fallback audit row");
  assert.equal(fallback.source, "scm");
  assert.equal(fallback.details?.status, 200);
  assert.equal(fallback.details?.request?.body?.name, presetName);
  assert.equal(fallback.details?.request?.body?.secret, "[REDACTED]");

  await writeDispatchAudit({
    action: "scm.vrma_order.created",
    entityType: "scm_vrma_order",
    entityId: vrmaRef,
    orderId: vrmaRef,
    operatorId: operator.id,
    operatorName: operator.display_name,
    source: "scm",
    before: null,
    after: { vrmaRef },
    details: { vrmaRef, lineCount: 1 }
  });

  const unified = await listAudit({ tranid: vrmaRef, limit: 20 });
  const vrmaAudit = unified.find((row) => row.action === "scm.vrma_order.created");
  assert.equal(vrmaAudit?.audit_stream, "dispatch", "Admin audit must include the dispatch audit stream");
  assert.equal(vrmaAudit?.tranid, vrmaRef, "Admin TranID filtering must resolve a VRMA reference");
  assert.equal(vrmaAudit?.details?.after?.vrmaRef, vrmaRef, "Dispatch before/after state must be visible in Admin details");

  const options = await listAuditOptions({ tranid: vrmaRef });
  assert.ok(options.actions.includes("scm.vrma_order.created"), "Admin action filters must include VRMA events");

  console.log("Unified application audit integration checks passed.");
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (operator) {
    await query("DELETE FROM scm_view_presets WHERE updated_by = $1 OR created_by = $1", [operator.id]).catch(() => null);
    await query("DELETE FROM dispatch_audit_log WHERE operator_id = $1 OR order_id = $2", [operator.id, vrmaRef]).catch(() => null);
    await query("DELETE FROM operator_sessions WHERE operator_id = $1", [operator.id]).catch(() => null);
    await query("DELETE FROM delivery_audit_log WHERE actor_operator_id = $1", [operator.id]).catch(() => null);
    await query("DELETE FROM operators WHERE id = $1", [operator.id]).catch(() => null);
  }
  await closeDb();
}
