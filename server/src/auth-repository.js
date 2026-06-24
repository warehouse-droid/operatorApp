import crypto from "node:crypto";
import { promisify } from "node:util";
import { query } from "./db.js";

const scrypt = promisify(crypto.scrypt);
const SESSION_DAYS = 14;

function publicOperator(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    role: row.role,
    active: row.active,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = await scrypt(password, salt, 64);
  return { salt, hash: derived.toString("hex") };
}

async function verifyPassword(password, salt, expectedHash) {
  const { hash } = await hashPassword(password, salt);
  const expected = Buffer.from(expectedHash, "hex");
  const actual = Buffer.from(hash, "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export async function hasOperators() {
  const result = await query("SELECT 1 FROM operators LIMIT 1");
  return result.rowCount > 0;
}

export async function createOperator({ username, displayName, password, role = "operator" }) {
  const cleanUsername = String(username || "").trim().toLowerCase();
  const cleanDisplayName = String(displayName || username || "").trim();
  if (!cleanUsername) throw new Error("Username is required.");
  if (!cleanDisplayName) throw new Error("Display name is required.");
  if (!password || String(password).length < 6) throw new Error("Password must be at least 6 characters.");
  if (!["operator", "dispatcher", "admin"].includes(role)) throw new Error("Invalid operator role.");

  const { salt, hash } = await hashPassword(String(password));
  const id = crypto.randomUUID();
  const result = await query(
    `INSERT INTO operators (id, username, display_name, password_hash, password_salt, role)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, username, display_name, role, active, created_at, updated_at`,
    [id, cleanUsername, cleanDisplayName, hash, salt, role]
  );
  return publicOperator(result.rows[0]);
}

export async function listOperators() {
  const result = await query(
    `SELECT id, username, display_name, role, active, created_at, updated_at
     FROM operators
     ORDER BY active DESC, display_name ASC`
  );
  return result.rows.map(publicOperator);
}

export async function setOperatorActive(id, active) {
  const result = await query(
    `UPDATE operators
     SET active = $2,
         updated_at = now()
     WHERE id = $1
     RETURNING id, username, display_name, role, active, created_at, updated_at`,
    [id, Boolean(active)]
  );
  return publicOperator(result.rows[0]);
}

export async function updateOperatorPassword(id, password) {
  if (!password || String(password).length < 6) throw new Error("Password must be at least 6 characters.");
  const { salt, hash } = await hashPassword(String(password));
  const result = await query(
    `UPDATE operators
     SET password_hash = $2,
         password_salt = $3,
         updated_at = now()
     WHERE id = $1
     RETURNING id, username, display_name, role, active, created_at, updated_at`,
    [id, hash, salt]
  );
  await query("DELETE FROM operator_sessions WHERE operator_id = $1", [id]);
  return publicOperator(result.rows[0]);
}

export async function loginOperator(username, password) {
  const result = await query(
    `SELECT *
     FROM operators
     WHERE username = $1`,
    [String(username || "").trim().toLowerCase()]
  );
  const operator = result.rows[0];
  if (!operator || !operator.active) throw new Error("Invalid username or password.");
  const ok = await verifyPassword(String(password || ""), operator.password_salt, operator.password_hash);
  if (!ok) throw new Error("Invalid username or password.");

  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  await query(
    `INSERT INTO operator_sessions (token_hash, operator_id, expires_at)
     VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
    [tokenHash, operator.id, SESSION_DAYS]
  );
  return { token, operator: publicOperator(operator) };
}

export async function getOperatorByToken(token) {
  if (!token) return null;
  const result = await query(
    `SELECT o.id, o.username, o.display_name, o.role, o.active, o.created_at, o.updated_at
     FROM operator_sessions s
     INNER JOIN operators o ON o.id = s.operator_id
     WHERE s.token_hash = $1
       AND s.expires_at > now()
       AND o.active = true`,
    [hashToken(token)]
  );
  if (!result.rowCount) return null;
  await query(
    `UPDATE operator_sessions
     SET last_seen_at = now()
     WHERE token_hash = $1`,
    [hashToken(token)]
  );
  return publicOperator(result.rows[0]);
}

export async function logoutToken(token) {
  if (!token) return;
  await query("DELETE FROM operator_sessions WHERE token_hash = $1", [hashToken(token)]);
}

export async function writeAudit({
  actorType = "operator",
  actorOperatorId = null,
  source = "delivery",
  action,
  orderId = null,
  lineId = null,
  details = {}
}) {
  await query(
    `INSERT INTO delivery_audit_log (
       actor_type, actor_operator_id, source, action, order_id, line_id, details
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      actorType,
      actorOperatorId,
      source,
      action,
      orderId || null,
      lineId || null,
      JSON.stringify(details || {})
    ]
  );
}

export async function listAudit({ limit = 100, orderId = null, operatorId = null } = {}) {
  const params = [];
  const clauses = [];
  if (orderId) {
    params.push(orderId);
    clauses.push(`a.order_id = $${params.length}`);
  }
  if (operatorId) {
    params.push(operatorId);
    clauses.push(`a.actor_operator_id = $${params.length}`);
  }
  params.push(Math.min(Math.max(Number(limit) || 100, 1), 500));

  const result = await query(
    `SELECT a.*,
            o.username,
            o.display_name
     FROM delivery_audit_log a
     LEFT JOIN operators o ON o.id = a.actor_operator_id
     ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT $${params.length}`,
    params
  );
  return result.rows;
}
