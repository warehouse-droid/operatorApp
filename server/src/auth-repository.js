import { normalizeOperatorYardLocationIds } from "./operator-yard-access.js";
import crypto from "node:crypto";
import { normalizeAccountEmail } from "./account-email.js";
import { promisify } from "node:util";
import { query, withTransaction } from "./db.js";
import { trackSemanticAudit, withAuditRequestId } from "./audit-context.js";

const scrypt = promisify(crypto.scrypt);
const SESSION_DAYS = 14;
export const OPERATOR_ROLES = Object.freeze([
  "operator",
  "dispatcher",
  "admin",
  "scm",
  "yard_manager",
  "sales",
  "field_sales",
  "mbr_sales",
  "repair_technician",
  "repair_office",
  "mbt_frontdesk",
  "mbt_billing",
  "boss",
  "accounting"
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
  if (role === "boss") return "/boss";
  if (role === "admin") return "/admin";
  if (role === "dispatcher") return "/dispatch";
  if (role === "scm" || role === "scm_staff") return "/scm";
  if (role === "yard_manager") return "/control";
  if (role === "sales") return "/sales";
  if (role === "field_sales") return "/field-sales/";
  if (role === "mbr_sales") return "/mbr/contracts";
  if (role === "repair_technician") return "/repair/workshop";
  if (role === "repair_office") return "/repair";
  if (role === "accounting") return "/accounting";
  if (role === "operator" && roles.has("mbt_frontdesk")) return "/mbt/frontdesk";
  if (role === "operator" && roles.has("mbt_billing")) return "/mbt/billing";
  if (role === "operator") return "/operator";
  if (role === "mbt_frontdesk") return "/mbt/frontdesk";
  if (role === "mbt_billing") return "/mbt/billing";
  return "/";
}

function aggregateAccessSelect(alias = "operators") {
  return `(SELECT COALESCE(array_agg(a.yard_location_id ORDER BY a.yard_location_id), ARRAY[]::integer[])
    FROM aggregate_request_yard_assignments a WHERE a.operator_id = ${alias}.id) AS aggregate_request_yard_location_ids`;
}

function publicOperator(row) {
  if (!row) return null;
  const authority = normalizeAuthorities(row.roles, row.role);
  return {
    id: row.id,
    username: row.username,
    email: row.email || "",
    display_name: row.display_name,
    role: authority.role,
    roles: authority.roles,
    homeRoute: operatorHomeRoute(authority),
    yardLocationIds: normalizeYardLocationIds(row.yard_location_ids),
    operatorYardLocationIds: normalizeOperatorYardLocationIds(row.operator_yard_location_ids),
    aggregateRequestYardLocationIds: row.aggregate_request_yard_location_ids || [],
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

export async function createOperator({ username, displayName, email = "", password, role = "operator", roles = null, yardLocationIds = [], operatorYardLocationIds = [] }) {
  const cleanEmail = normalizeAccountEmail(email);
  const cleanUsername = String(username || "").trim().toLowerCase();
  const cleanDisplayName = String(displayName || username || "").trim();
  if (!cleanUsername) throw new Error("Username is required.");
  if (!cleanDisplayName) throw new Error("Display name is required.");
  if (!password || String(password).length < 6) throw new Error("Password must be at least 6 characters.");
  const authority = normalizeAuthorities(roles, role);
  const yards = normalizeYardLocationIds(yardLocationIds);
  const operatorYards = normalizeOperatorYardLocationIds(operatorYardLocationIds);

  const { salt, hash } = await hashPassword(String(password));
  const id = crypto.randomUUID();
  const result = await query(
    `INSERT INTO operators (id, username, display_name, password_hash, password_salt, role, roles, yard_location_ids, operator_yard_location_ids, email)
     VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8::integer[], $9::integer[], $10)
     RETURNING id, username, display_name, email, role, roles, yard_location_ids, operator_yard_location_ids, active, created_at, updated_at, ${aggregateAccessSelect()}`,
    [id, cleanUsername, cleanDisplayName, hash, salt, authority.role, authority.roles, yards, operatorYards, cleanEmail]
  );
  return publicOperator(result.rows[0]);
}

export async function listOperators() {
  const result = await query(
    `SELECT id, username, display_name, email, role, roles, yard_location_ids, operator_yard_location_ids, active, created_at, updated_at, ${aggregateAccessSelect()}
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
     RETURNING id, username, display_name, email, role, roles, yard_location_ids, operator_yard_location_ids, active, created_at, updated_at, ${aggregateAccessSelect()}`,
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
     RETURNING id, username, display_name, email, role, roles, yard_location_ids, operator_yard_location_ids, active, created_at, updated_at, ${aggregateAccessSelect()}`,
    [id, hash, salt]
  );
  await query("DELETE FROM operator_sessions WHERE operator_id = $1", [id]);
  return publicOperator(result.rows[0]);
}

export async function updateOperatorRoles(id, { role, roles, yardLocationIds, operatorYardLocationIds } = {}) {
  const current = await query("SELECT id, role, roles, yard_location_ids, operator_yard_location_ids FROM operators WHERE id = $1", [id]);
  if (!current.rowCount) return null;
  const authority = normalizeAuthorities(roles, role || current.rows[0].role);
  const yards = yardLocationIds === undefined
    ? normalizeYardLocationIds(current.rows[0].yard_location_ids)
    : normalizeYardLocationIds(yardLocationIds);
  const operatorYards = normalizeOperatorYardLocationIds(operatorYardLocationIds === undefined
    ? current.rows[0].operator_yard_location_ids : operatorYardLocationIds);
  const result = await query(
    `UPDATE operators
     SET role = $2,
         roles = $3::text[],
         yard_location_ids = $4::integer[],
         operator_yard_location_ids = $5::integer[],
         updated_at = now()
     WHERE id = $1
     RETURNING id, username, display_name, email, role, roles, yard_location_ids, operator_yard_location_ids, active, created_at, updated_at, ${aggregateAccessSelect()}`,
    [id, authority.role, authority.roles, yards, operatorYards]
  );
  return publicOperator(result.rows[0]);
}

export async function loginOperator(username, password) {
  return withTransaction(async () => {
  const result = await query(
    `SELECT *, ${aggregateAccessSelect()}
     FROM operators
     WHERE username = $1 FOR UPDATE`,
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
  });
}

export async function getOperatorByToken(token) {
  if (!token) return null;
  const result = await query(
    `SELECT o.id, o.username, o.display_name, o.email, o.role, o.roles, o.yard_location_ids, o.operator_yard_location_ids, o.active, o.created_at, o.updated_at, ${aggregateAccessSelect("o")}
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

/** @param {{actorType?: string, actorOperatorId?: string | null, source?: string, action: string,
 * orderId?: string | number | null, lineId?: string | number | null, details?: Record<string, any>}} event */
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
      JSON.stringify(withAuditRequestId(details || {}))
    ]
  ));
}

// Columns every audit stream projects, in order. Streams fill the ones they have and NULL the rest.
const AUDIT_COLUMNS = [
  "id", "legacy_sort_id", "audit_stream", "category", "severity", "actor_type", "actor_operator_id",
  "actor_name", "source", "action", "message", "request_id", "order_id", "numeric_order_id", "line_id",
  "entity_type", "entity_id", "load_id", "truck_id", "session_id", "plan_id", "plan_date",
  "before_state", "after_state", "details", "created_at"
];
const AUDIT_COLUMN_TYPES = {
  id: "text", legacy_sort_id: "bigint", audit_stream: "text", category: "text", severity: "text",
  actor_type: "text", actor_operator_id: "text", actor_name: "text", source: "text", action: "text",
  message: "text", request_id: "text", order_id: "text", numeric_order_id: "bigint", line_id: "bigint",
  entity_type: "text", entity_id: "text", load_id: "text", truck_id: "text", session_id: "text",
  plan_id: "bigint", plan_date: "date", before_state: "jsonb", after_state: "jsonb", details: "jsonb",
  created_at: "timestamptz"
};

function auditStreamSelect(columns, from) {
  const unknown = Object.keys(columns).filter((column) => !AUDIT_COLUMNS.includes(column));
  if (unknown.length) throw new Error(`Unknown audit columns: ${unknown.join(", ")}`);
  const projected = AUDIT_COLUMNS.map((column) => (
    columns[column] === undefined ? `NULL::${AUDIT_COLUMN_TYPES[column]} AS ${column}` : `${columns[column]} AS ${column}`
  ));
  return `SELECT\n    ${projected.join(",\n    ")}\n  ${from}`;
}

// Severity of application rows: HTTP 5xx and failed actions are errors; rejections are warnings.
const DELIVERY_SEVERITY = `CASE
      WHEN a.action ~* '(fail|error|crash)'
        OR a.details->>'outcome' IN ('failed', 'error')
        OR a.details->>'status' ~ '^5[0-9]{2}$' THEN 'error'
      WHEN a.details->>'outcome' IN ('rejected', 'client_disconnected', 'uncertain')
        OR a.details->>'status' ~ '^4[0-9]{2}$'
        OR a.action ~* '(reject|warn|conflict|missing|timeout|expired)' THEN 'warning'
      ELSE 'info'
    END`;

const AUDIT_STREAMS = [
  auditStreamSelect({
    id: "a.id::text",
    legacy_sort_id: "a.id",
    audit_stream: "'delivery'::text",
    category: `CASE
      WHEN a.source ILIKE 'netsuite%' OR a.action LIKE 'netsuite.%' OR a.action LIKE 'returns.netsuite.%' THEN 'netsuite'
      WHEN a.actor_type IN ('operator', 'driver', 'anonymous') OR a.actor_operator_id IS NOT NULL THEN 'user'
      ELSE 'system'
    END`,
    severity: DELIVERY_SEVERITY,
    actor_type: "a.actor_type",
    actor_operator_id: "a.actor_operator_id",
    source: "a.source",
    action: "a.action",
    message: "COALESCE(a.details->>'errorMessage', a.details->>'error', a.details->>'message', a.details->>'reason')",
    request_id: "a.details->>'auditRequestId'",
    order_id: "a.order_id::text",
    numeric_order_id: "a.order_id",
    line_id: "a.line_id",
    details: "a.details",
    created_at: "a.created_at"
  }, "FROM delivery_audit_log a"),
  auditStreamSelect({
    id: "a.id::text",
    legacy_sort_id: "a.id",
    audit_stream: "'dispatch'::text",
    category: "CASE WHEN a.operator_id IS NOT NULL OR NULLIF(a.operator_name, '') IS NOT NULL THEN 'user' ELSE 'system' END",
    severity: "CASE WHEN a.action ~* '(fail|error)' THEN 'error' WHEN a.action ~* '(reject|conflict|warn)' THEN 'warning' ELSE 'info' END",
    actor_type: "COALESCE(NULLIF(a.operator_name, ''), 'operator')",
    actor_operator_id: "a.operator_id",
    actor_name: "a.operator_name",
    source: "a.source",
    action: "a.action",
    message: "COALESCE(a.details->>'error', a.details->>'reason')",
    request_id: "a.details->>'auditRequestId'",
    order_id: "a.order_id",
    numeric_order_id: "CASE WHEN a.order_id ~ '^[0-9]+$' THEN a.order_id::bigint ELSE NULL END",
    entity_type: "a.entity_type",
    entity_id: "a.entity_id",
    load_id: "a.load_id",
    truck_id: "a.truck_id",
    session_id: "a.session_id",
    plan_id: "a.plan_id",
    plan_date: "a.plan_date",
    before_state: "a.before_state",
    after_state: "a.after_state",
    details: "COALESCE(a.details, '{}'::jsonb)",
    created_at: "a.created_at"
  }, "FROM dispatch_audit_log a"),
  auditStreamSelect({
    id: "a.audit_event_id::text",
    audit_stream: "'mbt'::text",
    category: "CASE WHEN a.actor_operator_id IS NOT NULL THEN 'user' ELSE 'system' END",
    severity: "'info'::text",
    actor_type: "a.actor_type",
    actor_operator_id: "a.actor_operator_id",
    actor_name: "a.actor_operator_id",
    source: "a.source",
    action: "a.action",
    message: "a.reason",
    entity_type: "a.entity_type",
    entity_id: "a.entity_id",
    before_state: "a.before_state",
    after_state: "a.after_state",
    details: `jsonb_strip_nulls(jsonb_build_object(
      'auditEventId', a.audit_event_id,
      'actorRoles', a.actor_roles,
      'reason', a.reason,
      'revisionBefore', a.revision_before,
      'revisionAfter', a.revision_after,
      'correlationId', a.correlation_id,
      'requestId', a.request_id,
      'idempotencyKey', a.idempotency_key
    ))`,
    created_at: "a.occurred_at"
  }, "FROM mbt_audit_events a"),
  auditStreamSelect({
    id: "'boss:' || e.id::text",
    legacy_sort_id: "e.id",
    audit_stream: "'boss_approval'::text",
    category: "CASE WHEN e.actor_id IS NULL THEN 'system' ELSE 'user' END",
    severity: "'info'::text",
    actor_type: "CASE WHEN e.actor_id IS NULL THEN 'system' ELSE 'operator' END",
    actor_operator_id: "e.actor_id",
    actor_name: "COALESCE(e.actor_name, 'NetSuite')",
    source: "'boss_approvals'::text",
    action: "'boss.approval.' || e.kind",
    order_id: "r.order_id::text",
    numeric_order_id: "r.order_id",
    entity_type: "'boss_approval_request'::text",
    entity_id: "r.id::text",
    details: `jsonb_build_object('requestId', r.id, 'cycle', r.cycle,
      'tranid', e.snapshot->>'tranid', 'decision', e.kind,
      'snapshotCapturedAt', e.snapshot->>'refreshedAt', 'snapshot', e.snapshot)`,
    created_at: "e.created_at"
  }, `FROM boss_approval_events e
  JOIN boss_approval_requests r ON r.id=e.request_id`),
  // Failed and slow requests, process logs, crashes, NetSuite postings and browser errors.
  auditStreamSelect({
    id: "'sys:' || a.id::text",
    legacy_sort_id: "a.id",
    audit_stream: "'system'::text",
    category: "a.category",
    severity: "a.severity",
    actor_type: "a.actor_type",
    actor_operator_id: "a.actor_operator_id",
    actor_name: "a.actor_name",
    source: "a.source",
    action: "a.action",
    message: "a.message",
    request_id: "a.request_id",
    details: `jsonb_strip_nulls(jsonb_build_object(
      'outcome', a.outcome,
      'process', a.process_name,
      'method', a.http_method,
      'route', a.route,
      'status', a.status_code,
      'durationMs', a.duration_ms,
      'errorCode', a.error_code,
      'orderRef', a.order_ref,
      'repeatCount', NULLIF(a.repeat_count, 1)
    )) || a.details`,
    created_at: "a.occurred_at"
  }, "FROM system_audit_events a"),
  // Every operator IF/IR posting attempt (receiving, customer pickup, delivery prep, TO and direct PO jobs).
  auditStreamSelect({
    id: "'post:' || t.id::text",
    legacy_sort_id: "t.id",
    audit_stream: "'netsuite_posting'::text",
    category: "'netsuite'::text",
    severity: "CASE t.outcome WHEN 'failed' THEN 'error' WHEN 'uncertain' THEN 'warning' ELSE 'info' END",
    actor_type: "'operator'::text",
    actor_operator_id: "c.actor_operator_id",
    source: "'netsuite-posting'::text",
    action: "'netsuite.posting.' || lower(s.transaction_type) || '.' || t.outcome",
    message: `COALESCE(t.error, s.transaction_type || ' ' || t.outcome || ' for ' || s.source_order_kind || ' '
      || COALESCE(NULLIF(s.source_order_ref, ''), s.source_netsuite_id::text) || ' (attempt ' || t.attempt_number || ')')`,
    order_id: "s.source_netsuite_id::text",
    numeric_order_id: "s.source_netsuite_id",
    entity_type: "'operator_netsuite_posting_step'::text",
    entity_id: "s.external_id",
    details: `jsonb_strip_nulls(jsonb_build_object(
      'commandId', c.id,
      'commandRequestId', c.request_id,
      'commandStatus', c.status,
      'functionKey', c.function_key,
      'transactionType', s.transaction_type,
      'yard', c.yard_code,
      'locationId', c.canonical_location_id,
      'stepIndex', s.step_index,
      'attempt', t.attempt_number,
      'outcome', t.outcome,
      'sourceOrderKind', s.source_order_kind,
      'sourceOrderRef', NULLIF(s.source_order_ref, ''),
      'externalId', s.external_id,
      'startedAt', t.started_at,
      'finishedAt', t.finished_at,
      'error', t.error
    )) || t.details`,
    created_at: "t.started_at"
  }, `FROM operator_netsuite_posting_attempts t
  JOIN operator_netsuite_posting_steps s ON s.id = t.step_id
  JOIN operator_netsuite_posting_commands c ON c.id = s.command_id`),
  // Sales order Item Fulfillment automation (Dispatch completion -> NetSuite IF).
  auditStreamSelect({
    id: "'soif:' || e.id::text",
    legacy_sort_id: "e.id",
    audit_stream: "'so_fulfillment'::text",
    category: "'netsuite'::text",
    severity: "CASE WHEN e.action ~* '(fail|error)' THEN 'error' WHEN e.action ~* '(attention|reject|block|uncertain|mismatch)' THEN 'warning' ELSE 'info' END",
    actor_type: "CASE WHEN NULLIF(e.actor_id, '') IS NULL THEN 'system' ELSE 'operator' END",
    actor_operator_id: "NULLIF(e.actor_id, '')",
    actor_name: "NULLIF(e.actor_id, '')",
    source: "'so-fulfillment'::text",
    action: "'so_fulfillment.' || e.action",
    message: "NULLIF(e.reason, '')",
    order_id: "c.source_sales_order_id::text",
    numeric_order_id: "c.source_sales_order_id",
    entity_type: "'dispatch_sales_order_if_candidate'::text",
    entity_id: "c.id::text",
    details: `jsonb_strip_nulls(jsonb_build_object(
      'candidateId', c.id,
      'dispatchOrderRef', c.dispatch_order_ref,
      'sourceOrderRef', c.source_sales_order_ref,
      'externalId', c.external_id,
      'reason', NULLIF(e.reason, '')
    )) || e.details`,
    created_at: "e.created_at"
  }, `FROM dispatch_sales_order_if_audit_events e
  JOIN dispatch_sales_order_if_candidates c ON c.id = e.candidate_id`),
  // SO / PO / TO reconciliation (webhook, nightly, manual and backfill runs).
  auditStreamSelect({
    id: "'recon:' || r.id::text",
    legacy_sort_id: "r.id",
    audit_stream: "'reconciliation'::text",
    category: "'reconciliation'::text",
    severity: "CASE WHEN r.action ~* '(fail|error)' THEN 'error' WHEN r.validation_status = 'rejected' THEN 'warning' ELSE 'info' END",
    actor_type: "CASE WHEN r.source = 'manual' THEN 'operator' ELSE 'system' END",
    actor_operator_id: "NULLIF(r.actor, '')",
    actor_name: "NULLIF(r.actor, '')",
    source: "'reconciliation-' || r.source",
    action: "'reconciliation.' || lower(r.record_type) || '.' || r.action",
    message: "CASE WHEN r.validation_status = 'rejected' THEN 'Rejected by validation' END",
    order_id: "r.parent_order_netsuite_id::text",
    numeric_order_id: "r.parent_order_netsuite_id",
    entity_type: "lower(r.record_type)",
    entity_id: "r.netsuite_transaction_id::text",
    details: `jsonb_strip_nulls(jsonb_build_object(
      'runId', r.run_id,
      'eventType', r.event_type,
      'recordType', r.record_type,
      'validation', r.validation_status,
      'transactionRef', r.transaction_ref,
      'parentOrderKind', r.parent_order_kind,
      'parentOrderRef', r.parent_order_ref,
      'netsuiteLineKey', r.netsuite_line_key,
      'occurredAt', r.occurred_at,
      'payload', r.payload
    ))`,
    created_at: "r.created_at"
  }, "FROM scm_reconciliation_audit_events r")
];

// What each stream above (same order) can produce. A Category or request-id filter leaves out streams
// that cannot match, so e.g. "Failed / slow requests" never scans the large application audit table.
const AUDIT_STREAM_SCOPES = [
  { stream: "delivery", categories: ["user", "netsuite", "system"], requestIds: true },
  { stream: "dispatch", categories: ["user", "system"], requestIds: true },
  { stream: "mbt", categories: ["user", "system"], requestIds: false },
  { stream: "boss_approval", categories: ["user", "system"], requestIds: false },
  { stream: "system", categories: ["request", "netsuite", "system", "client"], requestIds: true },
  { stream: "netsuite_posting", categories: ["netsuite"], requestIds: false },
  { stream: "so_fulfillment", categories: ["netsuite"], requestIds: false },
  { stream: "reconciliation", categories: ["reconciliation"], requestIds: false }
];
if (AUDIT_STREAM_SCOPES.length !== AUDIT_STREAMS.length) throw new Error("Every audit stream needs a scope.");

function unifiedAuditCte({ category = "", requestId = "" } = {}) {
  const streams = AUDIT_STREAMS.filter((_, index) => {
    const scope = AUDIT_STREAM_SCOPES[index];
    return (!category || scope.categories.includes(category)) && (!requestId || scope.requestIds);
  });
  return `WITH unified_audit AS (
  ${streams.join("\n  UNION ALL\n  ")}
), resolved_audit AS (
  SELECT
    a.*,
    COALESCE(o.username, NULLIF(a.actor_name, '')) AS username,
    COALESCE(CASE WHEN a.audit_stream='boss_approval' THEN a.actor_name END,
      o.display_name, NULLIF(a.actor_name, '')) AS display_name,
    COALESCE(
      CASE WHEN a.audit_stream='boss_approval' THEN a.details->>'tranid' END,
      so.tranid,
      tr.tranid,
      po.tranid,
      co.co_ref,
      a.details->>'tranid',
      a.details->>'coRef',
      a.details->>'vrmaRef',
      a.details->>'sourceOrderRef',
      a.details->>'orderRef',
      a.details->>'parentOrderRef',
      a.details->>'transactionRef',
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
}

export const AUDIT_CATEGORIES = Object.freeze(["user", "netsuite", "reconciliation", "system", "request", "client"]);
const AUDIT_SEVERITY_FILTERS = Object.freeze({
  errors: ["error", "critical"],
  problems: ["warning", "error", "critical"],
  info: ["info"],
  warning: ["warning"],
  error: ["error"],
  critical: ["critical"]
});
const AUDIT_STATEMENT_TIMEOUT = "30s";
// Free-text search reads each row's own text (not joined names), so it filters inside every stream
// before the joins; without a From date it covers this many days.
export const AUDIT_SEARCH_DEFAULT_DAYS = 30;

function auditFilterClauses({ orderId, operatorId, from, to, actor, action, tranid, category, severity, search, requestId }) {
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
  const categoryValue = String(category || "").trim().toLowerCase();
  if (categoryValue) {
    if (!AUDIT_CATEGORIES.includes(categoryValue)) {
      throw Object.assign(new Error(`Unknown audit category: ${categoryValue}`), { status: 400 });
    }
    params.push(categoryValue);
    clauses.push(`a.category = $${params.length}`);
  }
  const severityValue = String(severity || "").trim().toLowerCase();
  if (severityValue) {
    const severities = AUDIT_SEVERITY_FILTERS[severityValue];
    if (!severities) throw Object.assign(new Error(`Unknown audit severity filter: ${severityValue}`), { status: 400 });
    params.push(severities);
    clauses.push(`a.severity = ANY($${params.length}::text[])`);
  }
  const requestIdValue = String(requestId || "").trim();
  if (requestIdValue) {
    params.push(requestIdValue);
    clauses.push(`a.request_id = $${params.length}`);
  }
  const searchValue = String(search || "").trim();
  if (searchValue) {
    params.push(`%${searchValue.replace(/[\\%_]/g, (match) => `\\${match}`)}%`);
    clauses.push(`(
      a.action ILIKE $${params.length}
      OR COALESCE(a.source, '') ILIKE $${params.length}
      OR COALESCE(a.message, '') ILIKE $${params.length}
      OR COALESCE(a.order_id, '') ILIKE $${params.length}
      OR COALESCE(a.entity_id, '') ILIKE $${params.length}
      OR COALESCE(a.actor_name, '') ILIKE $${params.length}
      OR a.details::text ILIKE $${params.length}
    )`);
  }
  return { params, clauses };
}

async function runAuditQuery(sql, params) {
  try {
    return await withTransaction(async () => {
      await query(`SET LOCAL statement_timeout = '${AUDIT_STATEMENT_TIMEOUT}'`);
      return query(sql, params);
    });
  } catch (error) {
    if (error?.code === "57014") {
      throw Object.assign(new Error("The audit search took too long. Narrow the From/To range or add a filter, then try again."), {
        status: 400,
        code: "AUDIT_QUERY_TIMEOUT"
      });
    }
    throw error;
  }
}

export async function listAudit({
  limit = 100,
  offset = 0,
  orderId = null,
  operatorId = null,
  from = null,
  to = null,
  actor = "",
  action = "",
  tranid = "",
  category = "",
  severity = "",
  search = "",
  requestId = ""
} = {}) {
  const searching = Boolean(String(search || "").trim());
  const effectiveFrom = from || (searching ? new Date(Date.now() - AUDIT_SEARCH_DEFAULT_DAYS * 86_400_000).toISOString() : null);
  const { params, clauses } = auditFilterClauses({
    orderId, operatorId, from: effectiveFrom, to, actor, action, tranid, category, severity, search, requestId
  });
  params.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
  const limitParam = params.length;
  params.push(Math.min(Math.max(Math.trunc(Number(offset) || 0), 0), 10000));
  const offsetParam = params.length;

  const result = await runAuditQuery(
    `${unifiedAuditCte({ category: String(category || "").trim().toLowerCase(), requestId: String(requestId || "").trim() })}, limited_audit AS MATERIALIZED (
       SELECT a.*
       FROM resolved_audit a
       ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY a.created_at DESC, a.legacy_sort_id DESC NULLS LAST, a.id DESC
       LIMIT $${limitParam} OFFSET $${offsetParam}
     )
     SELECT
       a.id,
       a.audit_stream,
       a.category,
       a.severity,
       a.actor_type,
       a.actor_operator_id,
       a.actor_name,
       a.source,
       a.action,
       a.message,
       a.request_id,
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

// Without a From date the filter options cover the last 30 days, which keeps the page fast.
const AUDIT_OPTIONS_DEFAULT_DAYS = 30;

export async function listAuditOptions({
  from = null,
  to = null,
  tranid = "",
  category = ""
} = {}) {
  const effectiveFrom = from || new Date(Date.now() - AUDIT_OPTIONS_DEFAULT_DAYS * 86_400_000).toISOString();
  const { params, clauses } = auditFilterClauses({ from: effectiveFrom, to, tranid, category });
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await runAuditQuery(
    `${unifiedAuditCte({ category: String(category || "").trim().toLowerCase() })}, filtered AS (
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
    actions: result.rows[0]?.actions || [],
    categories: AUDIT_CATEGORIES,
    optionsFrom: effectiveFrom
  };
}

export async function updateOperatorEmail(id, value) {
  const email = normalizeAccountEmail(value);
  const result = await query(`UPDATE operators SET email=$2, updated_at=now() WHERE id=$1
    RETURNING id, username, display_name, email, role, roles, yard_location_ids, operator_yard_location_ids,
    active, created_at, updated_at, ${aggregateAccessSelect()}`, [id, email]);
  return publicOperator(result.rows[0]);
}
