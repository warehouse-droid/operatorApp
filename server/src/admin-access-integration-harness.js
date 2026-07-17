import assert from "node:assert/strict";

const { app } = await import("./server.js");
const { createOperator } = await import("./auth-repository.js");
const { closeDb, query } = await import("./db.js");

const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const username = `yard_access_${runId}`;
let yardManager = null;
let dispatcher = null;
let adminAccount = null;
let server = null;

async function postJson(baseUrl, path, body, token = "") {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { response, payload };
}

async function getJson(baseUrl, path, token) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { response, payload };
}

async function putJson(baseUrl, path, body, token) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  return { response, payload: text ? JSON.parse(text) : null };
}

try {
  yardManager = await createOperator({
    username,
    displayName: "Yard Access Harness",
    password: "Rollback123",
    role: "yard_manager"
  });
  dispatcher = await createOperator({
    username: `dispatch_access_${runId}`,
    displayName: "Dispatch Access Harness",
    password: "Rollback123",
    role: "dispatcher",
    roles: ["dispatcher", "yard_manager"]
  });
  adminAccount = await createOperator({
    username: `admin_access_${runId}`,
    displayName: "Admin Access Harness",
    password: "Rollback123",
    role: "admin"
  });

  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const login = await postJson(baseUrl, "/api/auth/login", { username, password: "Rollback123" });
  assert.equal(login.response.status, 200, "Yard Manager login should succeed");
  assert.equal(login.payload.operator?.role, "yard_manager");
  const token = login.payload.token;

  const control = await getJson(baseUrl, "/api/control/order-locks", token);
  assert.equal(control.response.status, 200, "Yard Manager should access Control APIs");

  const operator = await getJson(baseUrl, "/api/operator/history?limit=1", token);
  assert.equal(operator.response.status, 200, "Yard Manager should access Operator APIs");

  const admin = await getJson(baseUrl, "/api/operators", token);
  assert.equal(admin.response.status, 403, "Yard Manager should not access Admin APIs");
  assert.equal(admin.payload.redirect, "/control");

  const dispatch = await getJson(baseUrl, "/api/dispatch/config", token);
  assert.equal(dispatch.response.status, 403, "Yard Manager should be redirected away from Dispatch APIs");
  assert.equal(dispatch.payload.redirect, "/control");

  const failedLogin = await postJson(baseUrl, "/api/auth/login", { username, password: "incorrect" });
  assert.equal(failedLogin.response.status, 401, "Invalid login should fail");

  const dispatcherLogin = await postJson(baseUrl, "/api/auth/login", { username: dispatcher.username, password: "Rollback123" });
  assert.equal(dispatcherLogin.response.status, 200, "Dispatcher login should succeed");
  assert.deepEqual(new Set(dispatcherLogin.payload.operator?.roles), new Set(["dispatcher", "yard_manager"]), "Login should return all account authorities");
  const loadedOrders = await getJson(baseUrl, "/api/dispatch/loaded-orders?from=2000-01-01&to=2099-12-31&yard=all", dispatcherLogin.payload.token);
  assert.equal(loadedOrders.response.status, 200, "Dispatcher should access the Dispatch Loaded Export API");
  assert.ok(Array.isArray(loadedOrders.payload));
  const controlLoadedOrders = await getJson(baseUrl, "/api/control/loaded-orders?from=2000-01-01&to=2099-12-31&yard=all", dispatcherLogin.payload.token);
  assert.equal(controlLoadedOrders.response.status, 200, "A Dispatcher with Yard Manager authority should receive Yard Control access");

  const accountListBefore = await getJson(baseUrl, "/api/operators", dispatcherLogin.payload.token);
  assert.equal(accountListBefore.response.status, 403, "The account should not receive Admin access before it is granted");
  assert.equal(accountListBefore.payload.redirect, "/dispatch", "Forbidden redirects should still follow the primary role");

  const adminLogin = await postJson(baseUrl, "/api/auth/login", { username: adminAccount.username, password: "Rollback123" });
  assert.equal(adminLogin.response.status, 200, "Admin login should succeed");
  const roleUpdate = await putJson(baseUrl, `/api/operators/${dispatcher.id}/roles`, {
    role: "dispatcher",
    roles: ["dispatcher", "yard_manager", "admin"]
  }, adminLogin.payload.token);
  assert.equal(roleUpdate.response.status, 200, "Admin should be able to update account authorities");
  assert.equal(roleUpdate.payload.role, "dispatcher", "Updating authorities should preserve the selected primary role");

  const accountListAfter = await getJson(baseUrl, "/api/operators", dispatcherLogin.payload.token);
  assert.equal(accountListAfter.response.status, 200, "Updated authority should take effect in an existing session without another login");

  const audit = await query(
    `SELECT action, actor_type, actor_operator_id, details
       FROM delivery_audit_log
      WHERE action IN ('operator.login', 'operator.login_failed')
        AND (actor_operator_id = $1 OR details->>'username' = $2)
      ORDER BY id`,
    [yardManager.id, username]
  );
  assert.ok(audit.rows.some((row) => row.action === "operator.login" && row.actor_operator_id === yardManager.id), "Successful login audit row missing");
  assert.ok(audit.rows.some((row) => row.action === "operator.login_failed" && row.actor_type === "anonymous"), "Failed login audit row missing");

  console.log("Admin access integration checks passed.");
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (yardManager) {
    await query("DELETE FROM operator_sessions WHERE operator_id = $1", [yardManager.id]).catch(() => null);
    await query("DELETE FROM delivery_audit_log WHERE actor_operator_id = $1 OR details->>'username' = $2", [yardManager.id, username]).catch(() => null);
    await query("DELETE FROM operators WHERE id = $1", [yardManager.id]).catch(() => null);
  }
  if (dispatcher) {
    await query("DELETE FROM operator_sessions WHERE operator_id = $1", [dispatcher.id]).catch(() => null);
    await query("DELETE FROM delivery_audit_log WHERE actor_operator_id = $1", [dispatcher.id]).catch(() => null);
    await query("DELETE FROM operators WHERE id = $1", [dispatcher.id]).catch(() => null);
  }
  if (adminAccount) {
    await query("DELETE FROM operator_sessions WHERE operator_id = $1", [adminAccount.id]).catch(() => null);
    await query("DELETE FROM delivery_audit_log WHERE actor_operator_id = $1 OR details->>'operatorId' = $2", [adminAccount.id, dispatcher?.id || ""]).catch(() => null);
    await query("DELETE FROM operators WHERE id = $1", [adminAccount.id]).catch(() => null);
  }
  await closeDb();
}
