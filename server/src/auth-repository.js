import crypto from "node:crypto";
import { promisify } from "node:util";
import { query } from "./db.js";
import { trackSemanticAudit } from "./audit-context.js";

const scrypt = promisify(crypto.scrypt);
const SESSION_DAYS = 14;
export const OPERATOR_ROLES = Object.freeze([
  "operator",
  "dispatcher",
  "admin",
  "scm",
  "yard_manager",
  "sales",
  "mbt_frontdesk",
  "mbt_billing"
]);
export const SALES_YARD_LOCATION_IDS = Object.freeze([1, 28, 15, 26]);

function normalizeRole(value) {
  return String(value || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
}

function normalizeAuthorities(roles, primaryRole = "operator") {
  const primary = normalizeRole(primaryRole || "operator");
  if (!OPERATOR_ROLES.includes(primary)) throw new Error("Invalid primary operator role.");
  const provided = Array.isArray(roles) ? roles : roles ? [roles] : [];
  const normalized = [...new Set(provided.map(normalizeRole).filter(Boolean))];
  if (normalized.some((role) => !OPERATOR_ROLES.includes(role))) throw new Error("Invalid operator authority.");
  if (!normalized.includes(primary)) normalized.unshift(primary);
  return { role: primary, roles: normalized.length ? normalized : [primary] };
}

function normalizeYardLocationIds(values = []) {
  const provided = Array.isArray(values) ? values : values === null || values === undefined ? [] : [values];
  const normalized = [...new Set(provided.map(Number).filter((value) => Number.isInteger(value) && value > 0))];
  if (normalized.some((value) => !SALES_YARD_LOCATION_IDS.includes(value))) {
    throw new Error("Invalid sales yard authorization.");
  }
  return SALES_YARD_LOCATION_IDS.filter((value) => normalized.includes(value));
}

export function operatorHomeRoute(value) {
  const role = normalizeRole(typeof value === "object" ? value?.role : value);
  const roles = new Set((typeof value === "object" && Array.isArray(value?.roles)
    ? value.roles
    : [role]).map(normalizeRole));
  if (role === "admin") return "/admin";
  if (role === "dispatcher") return "/dispatch";
  if (role === "scm" || role === "scm_staff") return "/scm";
  if (role === "yard_manager") return "/control";
  if (role === "sales") return "/sales";
  if (role === "operator" && roles.has("mbt_frontdesk")) return "/mbt/frontdesk";
  if (role === "operator" && roles.has("mbt_billing")) return "/mbt/billing";
  if (role === "operator") return "/operator";
  if (role === "mbt_frontdesk") return "/mbt/frontdesk";
  if (role === "mbt_billing") return "/mbt/billing";
  return "/";
}

function publicOperator(row) {
  if (!row) return null;
  const authority = normalizeAuthorities(row.roles, row.role);
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    role: authority.role,
    roles: authority.roles,
    homeRoute: operatorHomeRoute(authority),
    yardLocationIds: normalizeYardLocationIds(row.yard_location_ids),
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

export async function createOperator({ username, displayName, password, role = "operator", roles = null, yardLocationIds = [] }) {
  const cleanUsername = String(username || "").trim().toLowerCase();
  const cleanDisplayName = String(displayName || username || "").trim();
  if (!cleanUsername) throw new Error("Username is required.");
  if (!cleanDisplayName) throw new Error("Display name is required.");
  if (!password || String(password).length < 6) throw new Error("Password must be at least 6 characters.");
  const authority = normalizeAuthorities(roles, role);
  const yards = normalizeYardLocationIds(yardLocationIds);

  const { salt, hash } = await hashPassword(String(password));
  const id = crypto.randomUUID();
  const result = await query(
    `INSERT INTO operators (id, username, display_name, password_hash, password_salt, role, roles, yard_location_ids)
     VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8::integer[])
     RETURNING id, username, display_name, role, roles, yard_location_ids, active, created_at, updated_at`,
    [id, cleanUsername, cleanDisplayName, hash, salt, authority.role, authority.roles, yards]
  );
  return publicOperator(result.rows[0]);
}

export async function listOperators() {
  const result = await query(
    `SELECT id, username, display_name, role, roles, yard_location_ids, active, created_at, updated_at
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
     RETURNING id, username, display_name, role, roles, yard_location_ids, active, created_at, updated_at`,
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
     RETURNING id, username, display_name, role, roles, yard_location_ids, active, created_at, updated_at`,
    [id, hash, salt]
  );
  await query("DELETE FROM operator_sessions WHERE operator_id = $1", [id]);
  return publicOperator(result.rows[0]);
}

export async function updateOperatorRoles(id, { role, roles, yardLocationIds } = {}) {
  const current = await query("SELECT id, role, roles, yard_location_ids FROM operators WHERE id = $1", [id]);
  if (!current.rowCount) return null;
  const authority = normalizeAuthorities(roles, role || current.rows[0].role);
  const yards = yardLocationIds === undefined
    ? normalizeYardLocationIds(current.rows[0].yard_location_ids)
    : normalizeYardLocationIds(yardLocationIds);
  const result = await query(
    `UPDATE operators
     SET role = $2,
         roles = $3::text[],
         yard_location_ids = $4::integer[],
         updated_at = now()
     WHERE id = $1
     RETURNING id, username, display_name, role, roles, yard_location_ids, active, created_at, updated_at`,
    [id, authority.role, authority.roles, yards]
  );
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
    `SELECT o.id, o.username, o.display_name, o.role, o.roles, o.yard_location_ids, o.active, o.created_at, o.updated_at
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
  await trackSemanticAudit(query(
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
  ));
}

const UNIFIED_AUDIT_CTE = `WITH unified_audit AS (
  SELECT
    a.id::text AS id,
    a.id AS legacy_sort_id,
    'delivery'::text AS audit_stream,
    a.actor_type,
    a.actor_operator_id,
    NULL::text AS actor_name,
    a.source,
    a.action,
    a.order_id::text AS order_id,
    a.order_id AS numeric_order_id,
    a.line_id,
    NULL::text AS entity_type,
    NULL::text AS entity_id,
    NULL::text AS load_id,
    NULL::text AS truck_id,
    NULL::text AS session_id,
    NULL::bigint AS plan_id,
    NULL::date AS plan_date,
    NULL::jsonb AS before_state,
    NULL::jsonb AS after_state,
    a.details,
    a.created_at
  FROM delivery_audit_log a
  UNION ALL
  SELECT
    a.id::text AS id,
    a.id AS legacy_sort_id,
    'dispatch'::text AS audit_stream,
    COALESCE(NULLIF(a.operator_name, ''), 'operator') AS actor_type,
    a.operator_id AS actor_operator_id,
    a.operator_name AS actor_name,
    a.source,
    a.action,
    a.order_id,
    CASE WHEN a.order_id ~ '^[0-9]+$' THEN a.order_id::bigint ELSE NULL END AS numeric_order_id,
    NULL::bigint AS line_id,
    a.entity_type,
    a.entity_id,
    a.load_id,
    a.truck_id,
    a.session_id,
    a.plan_id,
    a.plan_date,
    a.before_state,
    a.after_state,
    COALESCE(a.details, '{}'::jsonb) AS details,
    a.created_at
  FROM dispatch_audit_log a
  UNION ALL
  SELECT
    a.audit_event_id::text AS id,
    NULL::bigint AS legacy_sort_id,
    'mbt'::text AS audit_stream,
    a.actor_type,
    a.actor_operator_id,
    a.actor_operator_id AS actor_name,
    a.source,
    a.action,
    NULL::text AS order_id,
    NULL::bigint AS numeric_order_id,
    NULL::bigint AS line_id,
    a.entity_type,
    a.entity_id,
    NULL::text AS load_id,
    NULL::text AS truck_id,
    NULL::text AS session_id,
    NULL::bigint AS plan_id,
    NULL::date AS plan_date,
    a.before_state,
    a.after_state,
    jsonb_strip_nulls(jsonb_build_object(
      'auditEventId', a.audit_event_id,
      'actorRoles', a.actor_roles,
      'reason', a.reason,
      'revisionBefore', a.revision_before,
      'revisionAfter', a.revision_after,
      'correlationId', a.correlation_id,
      'requestId', a.request_id,
      'idempotencyKey', a.idempotency_key
    )) AS details,
    a.occurred_at AS created_at
  FROM mbt_audit_events a
), resolved_audit AS (
  SELECT
    a.*,
    COALESCE(o.username, NULLIF(a.actor_name, '')) AS username,
    COALESCE(o.display_name, NULLIF(a.actor_name, '')) AS display_name,
    COALESCE(
      so.tranid,
      tr.tranid,
      po.tranid,
      co.co_ref,
      a.details->>'tranid',
      a.details->>'coRef',
      a.details->>'vrmaRef',
      a.details->>'sourceOrderRef',
      a.details->>'orderRef',
      a.details->>'receivingOrderId',
      a.details->>'deliveryOrderId',
      NULLIF(a.order_id, ''),
      NULLIF(a.entity_id, '')
    ) AS tranid
  FROM unified_audit a
  LEFT JOIN operators o ON o.id = a.actor_operator_id
  LEFT JOIN sales_orders so ON so.netsuite_id = a.numeric_order_id
  LEFT JOIN transfer_orders tr ON tr.netsuite_id = a.numeric_order_id
  LEFT JOIN purchase_orders po ON po.netsuite_id = a.numeric_order_id
  LEFT JOIN local_co_orders co ON co.delivery_order_id = a.numeric_order_id
)`;

export async function listAudit({
  limit = 100,
  orderId = null,
  operatorId = null,
  from = null,
  to = null,
  actor = "",
  action = "",
  tranid = ""
} = {}) {
  const params = [];
  const clauses = [];
  if (orderId) {
    params.push(String(orderId));
    clauses.push(`a.order_id = $${params.length}`);
  }
  if (operatorId) {
    params.push(operatorId);
    clauses.push(`a.actor_operator_id = $${params.length}`);
  }
  if (from) {
    params.push(from);
    clauses.push(`a.created_at >= $${params.length}::timestamptz`);
  }
  if (to) {
    params.push(to);
    clauses.push(`a.created_at <= $${params.length}::timestamptz`);
  }
  if (actor) {
    params.push(`%${String(actor).trim()}%`);
    clauses.push(`(
      COALESCE(a.display_name, '') ILIKE $${params.length}
      OR COALESCE(a.username, '') ILIKE $${params.length}
      OR COALESCE(a.actor_name, '') ILIKE $${params.length}
      OR COALESCE(a.actor_type, '') ILIKE $${params.length}
      OR COALESCE(a.actor_operator_id, '') ILIKE $${params.length}
    )`);
  }
  if (action) {
    params.push(`%${String(action).trim()}%`);
    clauses.push(`a.action ILIKE $${params.length}`);
  }
  if (tranid) {
    params.push(`%${String(tranid).trim()}%`);
    clauses.push(`COALESCE(a.tranid, '') ILIKE $${params.length}`);
  }
  params.push(Math.min(Math.max(Number(limit) || 100, 1), 500));

  const result = await query(
    `${UNIFIED_AUDIT_CTE}, limited_audit AS MATERIALIZED (
       SELECT a.*
       FROM resolved_audit a
       ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY a.created_at DESC, a.legacy_sort_id DESC NULLS LAST, a.id DESC
       LIMIT $${params.length}
     )
     SELECT
       a.id,
       a.audit_stream,
       a.actor_type,
       a.actor_operator_id,
       a.actor_name,
       a.source,
       a.action,
       a.order_id,
       a.numeric_order_id,
       a.line_id,
       a.entity_type,
       a.entity_id,
       a.created_at,
       a.username,
       a.display_name,
       a.tranid,
       jsonb_strip_nulls(jsonb_build_object(
         'entityType', a.entity_type,
         'entityId', a.entity_id,
         'loadId', a.load_id,
         'truckId', a.truck_id,
         'sessionId', a.session_id,
         'planId', a.plan_id,
         'planDate', a.plan_date,
         'before', a.before_state,
         'after', a.after_state
       )) || COALESCE(a.details, '{}'::jsonb) AS details
     FROM limited_audit a
     ORDER BY a.created_at DESC, a.legacy_sort_id DESC NULLS LAST, a.id DESC`,
    params
  );
  return result.rows;
}

export async function listAuditOptions({
  from = null,
  to = null,
  tranid = ""
} = {}) {
  const params = [];
  const clauses = [];
  if (from) {
    params.push(from);
    clauses.push(`a.created_at >= $${params.length}::timestamptz`);
  }
  if (to) {
    params.push(to);
    clauses.push(`a.created_at <= $${params.length}::timestamptz`);
  }
  if (tranid) {
    params.push(`%${String(tranid).trim()}%`);
    clauses.push(`COALESCE(a.tranid, '') ILIKE $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await query(
    `${UNIFIED_AUDIT_CTE}, filtered AS (
       SELECT a.action,
              NULLIF(COALESCE(a.display_name, a.username, a.actor_name, a.actor_type, a.actor_operator_id), '') AS actor
       FROM resolved_audit a
       ${where}
     )
     SELECT
       COALESCE(jsonb_agg(DISTINCT actor ORDER BY actor) FILTER (WHERE actor IS NOT NULL), '[]'::jsonb) AS actors,
       COALESCE(jsonb_agg(DISTINCT action ORDER BY action) FILTER (WHERE action IS NOT NULL), '[]'::jsonb) AS actions
     FROM filtered`,
    params
  );
  return {
    actors: result.rows[0]?.actors || [],
    actions: result.rows[0]?.actions || []
  };
}
