// @ts-check

import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

import { closeDb, query } from "../src/db.js";
import { binDispatchOrders } from "../src/mbt/dispatch-bin-safety.js";

const SNAPSHOT_SCAN_PAGE_SIZE = 1;

const SNAPSHOT_SCAN_SOURCES = Object.freeze([
  Object.freeze({
    source: "current",
    sql: `SELECT snapshot.plan_id::text AS scan_id,
                 'current'::text AS source,
                 snapshot.plan_id::text AS record_id,
                 snapshot.plan_id::text AS plan_id,
                 snapshot.orders,
                 snapshot.trucks
            FROM dispatch_plan_snapshots snapshot
           WHERE ($1::bigint IS NULL OR snapshot.plan_id > $1::bigint)
           ORDER BY snapshot.plan_id ASC
           LIMIT $2::integer`
  }),
  Object.freeze({
    source: "history",
    sql: `SELECT history.id::text AS scan_id,
                 'history'::text AS source,
                 history.id::text AS record_id,
                 history.plan_id::text AS plan_id,
                 history.orders,
                 history.trucks
            FROM dispatch_plan_snapshot_history history
           WHERE ($1::bigint IS NULL OR history.id > $1::bigint)
           ORDER BY history.id ASC
           LIMIT $2::integer`
  })
]);

export const REQUIRED_MBT_P1_MIGRATIONS = Object.freeze([
  "102_mbt_authorities_flags_audit.sql",
  "103_netsuite_customer_master_foundation.sql",
  "104_mbt_assets_templates_fleet.sql",
  "105_mbt_rates_contracts_visits.sql",
  "106_mbt_billing_outbox.sql",
  "107_mbt_netsuite_mappings_preflight.sql"
]);

export const REQUIRED_MBT_P2_MIGRATIONS = Object.freeze([
  ...REQUIRED_MBT_P1_MIGRATIONS,
  "108_mbt_netsuite_sandbox_readiness.sql",
  "109_mbt_local_first_configuration.sql"
]);

export const REQUIRED_MBT_P3_MIGRATIONS = Object.freeze([
  ...REQUIRED_MBT_P2_MIGRATIONS,
  "110_mbt_p3_feature_gates_imports.sql",
  "111_mbt_p3_customer_sync_mirror.sql",
  "112_mbt_p3_shared_dispatch_master_data.sql",
  "113_mbt_p3_frontdesk_contract_chain.sql",
  "114_mbt_p3_local_import_provenance.sql",
  "115_mbt_p3_asset_registry_reconciliation.sql",
  "116_mbt_p3_bin_dispatch_operations.sql",
  "117_mbt_p3_driver_bin_execution.sql",
  "118_mbt_p3_driver_operational_reservations.sql",
  "119_mbt_p3_reconciliation_shadow_billing.sql",
  "120_mbt_p3_driver_clock_evidence.sql",
  "121_mbt_p3_completed_load_snapshots.sql",
  "122_mbt_rental_pricing_and_monthly_billing.sql",
  "123_mbt_contract_service_lines.sql",
  "124_mbt_bin_order_sites.sql",
  "125_mbt_item_bound_assets_and_addresses.sql",
  "126_mbt_item_owned_pricing.sql",
  "127_mbt_custom_bin_items_and_free_asset_addresses.sql",
  "128_mbt_guarded_deletion_item_rate_cards_delivery_orders.sql",
  "129_mbt_dump_site_hours_and_bin_estimates.sql",
  "130_mbt_multi_item_quoted_distance_pricing.sql",
  "131_sales_order_reconciliation.sql",
  "132_so_reconciliation_type_filter.sql",
  "133_driver_pwa_offline_mode.sql",
  "134_so_reconciliation_db_only.sql",
  "135_dispatch_planner_incremental_commands.sql",
  "136_dispatch_planner_command_actor_identity.sql",
  "137_dispatch_planner_followup_progress.sql",
  "138_smart_scm_authoritative_on_order.sql",
  "139_sales_order_reload_cycles.sql",
  "140_driver_yard_dependency_soft_mode.sql",
  "141_transfer_dependency_revision_reprint.sql",
  "142_mbt_frontdesk_customer_charge_requests.sql",
  "143_mbt_item_charge_bases_and_aggregate.sql",
  "144_mbt_mbbs_billing_address_overrides.sql",
  "145_scm_po_split_active_ref_uniqueness.sql",
  "146_smart_scm_blanket_load_merge.sql",
  "147_scm_po_vendor_reference_backfill.sql",
  "148_scm_po_history_line_financial_backfill.sql",
  "149_sales_stock_requests.sql",
  "150_stock_request_closed_status.sql",
  "151_stock_request_remarks.sql",
  "152_sales_stock_request_over_availability_gate.sql",
  "153_driver_camera_device_copy_gate.sql",
  "154_sales_order_delivery_instructions.sql",
  "155_delivery_instruction_media_replacement.sql",
  "156_scm_vendor_item_price.sql",
  "157_yard_movement_history_indexes.sql",
  "158_mbt_mbbs_candidate_billing.sql",
  "159_dispatch_order_completion_status.sql"
]);

export const REQUIRED_MBT_P3_FLAGS = Object.freeze([
  "mbt_asset_management",
  "mbt_billing_operations",
  "mbt_bin_dispatch",
  "mbt_customer_sync",
  "mbt_driver_execution",
  "mbt_enabled",
  "mbt_frontdesk_operations",
  "mbt_master_data",
  "mbt_netsuite_writes"
]);

const P2_RUNTIME_ENDPOINT = "http://127.0.0.1:3000/api/mbt/config/netsuite/preflight";
/** @type {ReadonlyArray<readonly [string, string]>} */
const P2_CLOSED_RUNTIME_GATES = Object.freeze(/** @type {Array<readonly [string, string]>} */ ([
  Object.freeze(["MBT_ENABLED", "false"]),
  Object.freeze(["MBT_NETSUITE_WRITES_ENABLED", "false"]),
  Object.freeze(["NETSUITE_DIRECT_ACCESS_ENABLED", "false"])
]));

const P2_OPERATIONAL_STATE_SQL = `SELECT
  (SELECT count(*)::int FROM mbt_netsuite_preflight_runs) AS preflight_runs,
  (SELECT count(*)::int FROM mbt_contracts) AS contracts,
  (SELECT count(*)::int FROM mbt_service_visits) AS visits,
  (SELECT count(*)::int FROM mbt_bin_asset_reservations) AS reservations,
  (SELECT count(*)::int FROM mbt_bin_movements) AS movements,
  (SELECT count(*)::int FROM mbt_billing_versions) AS billing_versions,
  (SELECT count(*)::int FROM mbt_deposit_records) AS deposits,
  (SELECT count(*)::int FROM mbt_netsuite_outbox) AS outbox,
  (SELECT COALESCE(jsonb_agg(flag_key ORDER BY flag_key), '[]'::jsonb)
     FROM mbt_feature_flags
    WHERE enabled) AS enabled_flags`;

const P3_RUNTIME_STATUS_ENDPOINT = "http://127.0.0.1:3000/api/mbt/status";
const P3_RUNTIME_BLOCKED_ENDPOINT = "http://127.0.0.1:3000/api/mbt/bin-assets/00000000-0000-4000-8000-000000000014/reservations";
/** @type {ReadonlyArray<readonly [string, string]>} */
const P3_CLOSED_RUNTIME_GATES = Object.freeze(/** @type {Array<readonly [string, string]>} */ ([
  Object.freeze(["MBT_ENABLED", "false"]),
  Object.freeze(["MBT_CUSTOMER_SYNC_ENABLED", "false"]),
  Object.freeze(["MBT_MASTER_DATA_ENABLED", "false"]),
  Object.freeze(["MBT_ASSET_MANAGEMENT_ENABLED", "false"]),
  Object.freeze(["MBT_FRONTDESK_OPERATIONS_ENABLED", "false"]),
  Object.freeze(["MBT_BIN_DISPATCH_ENABLED", "false"]),
  Object.freeze(["MBT_DRIVER_EXECUTION_ENABLED", "false"]),
  Object.freeze(["MBT_BILLING_OPERATIONS_ENABLED", "false"]),
  Object.freeze(["MBT_NETSUITE_WRITES_ENABLED", "false"]),
  Object.freeze(["NETSUITE_DIRECT_ACCESS_ENABLED", "false"]),
  Object.freeze(["SMART_SCM_LIVE_EXECUTION_ENABLED", "false"]),
  Object.freeze(["SAMSARA_WRITES_ENABLED", "false"])
]));

const P3_OPERATIONAL_STATE_SQL = `SELECT
  (SELECT count(*)::int FROM mbt_netsuite_preflight_runs) AS preflight_runs,
  (SELECT count(*)::int FROM mbt_contracts) AS contracts,
  (SELECT count(*)::int FROM mbt_service_visits) AS visits,
  (SELECT count(*)::int FROM mbt_bin_asset_reservations) AS reservations,
  (SELECT count(*)::int FROM mbt_bin_movements) AS movements,
  (SELECT count(*)::int FROM mbt_billing_versions) AS billing_versions,
  (SELECT count(*)::int FROM mbt_deposit_records) AS deposits,
  (SELECT count(*)::int FROM mbt_netsuite_outbox) AS outbox,
  (SELECT count(*)::int FROM mbt_command_receipts) AS command_receipts,
  (SELECT count(*)::int FROM mbt_audit_events) AS audit_events,
  (SELECT COALESCE(
     jsonb_agg(jsonb_build_object('flagKey', flag_key, 'enabled', enabled) ORDER BY flag_key),
     '[]'::jsonb
   ) FROM mbt_feature_flags) AS feature_flags`;

/** @param {unknown} value */
function text(value) {
  return String(value ?? "").trim();
}

/** @param {Record<string, unknown>} identity */
function publicIdentity(identity) {
  return {
    id: text(identity.id),
    type: text(identity.type)
  };
}

/**
 * @param {Array<{source?: unknown, record_id?: unknown, plan_id?: unknown, orders?: unknown, trucks?: unknown}>} snapshotRows
 */
function dispatchCollisionsForSnapshotRows(snapshotRows) {
  const dispatchCollisions = [];
  for (const row of snapshotRows) {
    const identities = binDispatchOrders({
      orders: Array.isArray(row?.orders) ? row.orders : [],
      trucks: Array.isArray(row?.trucks) ? row.trucks : []
    });
    if (identities.length > 0) {
      dispatchCollisions.push({
        source: text(row.source),
        recordId: text(row.record_id),
        planId: text(row.plan_id),
        identities: identities.map(publicIdentity)
      });
    }
  }
  return dispatchCollisions;
}

/**
 * @param {Array<{scan_id?: unknown}>} rows
 * @param {string | null} cursor
 */
function nextSnapshotCursor(rows, cursor) {
  let previous = cursor === null ? null : BigInt(cursor);
  let next = cursor;
  for (const row of rows) {
    const candidate = text(row?.scan_id);
    if (!/^-?\d+$/.test(candidate)) {
      throw new Error("Dispatch snapshot pagination requires a numeric keyset.");
    }
    const numericCandidate = BigInt(candidate);
    if (previous !== null && numericCandidate <= previous) {
      throw new Error("Dispatch snapshot pagination requires a strictly increasing keyset.");
    }
    previous = numericCandidate;
    next = candidate;
  }
  return next;
}

/** @param {typeof query} runQuery */
async function inspectDispatchSnapshotCollisions(runQuery) {
  const dispatchCollisions = [];
  for (const scan of SNAPSHOT_SCAN_SOURCES) {
    /** @type {string | null} */
    let cursor = null;
    while (true) {
      const page = await runQuery(scan.sql, [cursor, SNAPSHOT_SCAN_PAGE_SIZE]);
      if (!Array.isArray(page?.rows)) {
        throw new Error(`Dispatch ${scan.source} snapshot scan did not return rows.`);
      }
      if (page.rows.length > SNAPSHOT_SCAN_PAGE_SIZE) {
        throw new Error(`Dispatch ${scan.source} snapshot scan exceeded its bounded page size.`);
      }
      dispatchCollisions.push(...dispatchCollisionsForSnapshotRows(page.rows));
      if (page.rows.length === 0) {
        break;
      }
      cursor = nextSnapshotCursor(page.rows, cursor);
      if (page.rows.length < SNAPSHOT_SCAN_PAGE_SIZE) {
        break;
      }
    }
  }
  return dispatchCollisions;
}

/**
 * @param {object} input
 * @param {Array<string | {filename?: unknown}>} input.appliedMigrations
 * @param {Array<{flag_key?: unknown, enabled?: unknown}>} input.flags
 * @param {Array<{source?: unknown, record_id?: unknown, plan_id?: unknown, orders?: unknown, trucks?: unknown}>} input.snapshotRows
 * @param {readonly string[]} input.requiredMigrations
 */
function evaluateDeploymentReadiness({
  appliedMigrations = [],
  flags = [],
  snapshotRows = [],
  requiredMigrations
}) {
  const applied = new Set(appliedMigrations.map((entry) =>
    text(typeof entry === "object" && entry !== null ? entry.filename : entry)
  ));
  const missingMigrations = requiredMigrations.filter((filename) => !applied.has(filename));
  const enabledFlags = flags
    .filter((flag) => flag?.enabled === true)
    .map((flag) => text(flag.flag_key))
    .filter(Boolean)
    .sort();
  const dispatchCollisions = dispatchCollisionsForSnapshotRows(snapshotRows);
  return {
    ready: missingMigrations.length === 0
      && enabledFlags.length === 0
      && dispatchCollisions.length === 0,
    missingMigrations,
    enabledFlags,
    dispatchCollisions
  };
}

/**
 * @param {object} input
 * @param {Array<string | {filename?: unknown}>} input.appliedMigrations
 * @param {Array<{flag_key?: unknown, enabled?: unknown}>} input.flags
 * @param {Array<{source?: unknown, record_id?: unknown, plan_id?: unknown, orders?: unknown, trucks?: unknown}>} input.snapshotRows
 */
export function evaluateMbtP1DeploymentReadiness(input) {
  return evaluateDeploymentReadiness({
    ...input,
    requiredMigrations: REQUIRED_MBT_P1_MIGRATIONS
  });
}

/**
 * @param {object} input
 * @param {Array<string | {filename?: unknown}>} input.appliedMigrations
 * @param {Array<{flag_key?: unknown, enabled?: unknown}>} input.flags
 * @param {Array<{source?: unknown, record_id?: unknown, plan_id?: unknown, orders?: unknown, trucks?: unknown}>} input.snapshotRows
 */
export function evaluateMbtP2DeploymentReadiness(input) {
  return evaluateDeploymentReadiness({
    ...input,
    requiredMigrations: REQUIRED_MBT_P2_MIGRATIONS
  });
}

/**
 * @param {object} input
 * @param {Array<string | {filename?: unknown}>} input.appliedMigrations
 * @param {Array<{flag_key?: unknown, enabled?: unknown}>} input.flags
 * @param {Array<{source?: unknown, record_id?: unknown, plan_id?: unknown, orders?: unknown, trucks?: unknown}>} input.snapshotRows
 */
export function evaluateMbtP3DeploymentReadiness(input) {
  const base = evaluateDeploymentReadiness({
    ...input,
    requiredMigrations: REQUIRED_MBT_P3_MIGRATIONS
  });
  const actualFlags = (Array.isArray(input.flags) ? input.flags : [])
    .map((flag) => text(flag?.flag_key))
    .filter(Boolean)
    .sort();
  const actualSet = new Set(actualFlags);
  const requiredSet = new Set(REQUIRED_MBT_P3_FLAGS);
  const missingFlags = REQUIRED_MBT_P3_FLAGS.filter((flagKey) => !actualSet.has(flagKey));
  const unexpectedFlags = [...actualSet].filter((flagKey) => !requiredSet.has(flagKey)).sort();
  const duplicateFlags = [...new Set(actualFlags.filter((flagKey, index) =>
    actualFlags.indexOf(flagKey) !== index))].sort();
  const nonFalseFlags = (Array.isArray(input.flags) ? input.flags : [])
    .filter((flag) => requiredSet.has(text(flag?.flag_key)) && flag?.enabled !== false)
    .map((flag) => text(flag?.flag_key))
    .filter(Boolean)
    .sort();
  return {
    ...base,
    ready: base.ready
      && missingFlags.length === 0
      && unexpectedFlags.length === 0
      && duplicateFlags.length === 0
      && nonFalseFlags.length === 0,
    missingFlags,
    unexpectedFlags,
    duplicateFlags,
    nonFalseFlags
  };
}

/**
 * @param {object} input
 * @param {typeof query} input.runQuery
 * @param {readonly string[]} input.requiredMigrations
 * @param {(input: {appliedMigrations: Array<string | {filename?: unknown}>, flags: Array<{flag_key?: unknown, enabled?: unknown}>, snapshotRows: Array<never>}) => ReturnType<typeof evaluateMbtP1DeploymentReadiness>} input.evaluate
 */
async function inspectDeploymentReadiness({ runQuery, requiredMigrations, evaluate }) {
  const [migrations, flags, dispatchCollisions] = await Promise.all([
    runQuery(
      `SELECT filename
         FROM schema_migrations
        WHERE filename = ANY($1::text[])
        ORDER BY filename`,
      [requiredMigrations]
    ),
    runQuery(
      `SELECT flag_key, enabled
         FROM mbt_feature_flags
        ORDER BY flag_key`
    ),
    inspectDispatchSnapshotCollisions(runQuery)
  ]);
  const readiness = evaluate({
    appliedMigrations: migrations.rows,
    flags: flags.rows,
    snapshotRows: []
  });
  return {
    ...readiness,
    ready: readiness.ready && dispatchCollisions.length === 0,
    dispatchCollisions
  };
}

/** @param {{runQuery?: typeof query}} [options] */
export async function inspectMbtP1DeploymentReadiness({ runQuery = query } = {}) {
  return inspectDeploymentReadiness({
    runQuery,
    requiredMigrations: REQUIRED_MBT_P1_MIGRATIONS,
    evaluate: evaluateMbtP1DeploymentReadiness
  });
}

/** @param {{runQuery?: typeof query}} [options] */
export async function inspectMbtP2DeploymentReadiness({ runQuery = query } = {}) {
  return inspectDeploymentReadiness({
    runQuery,
    requiredMigrations: REQUIRED_MBT_P2_MIGRATIONS,
    evaluate: evaluateMbtP2DeploymentReadiness
  });
}

/** @param {{runQuery?: typeof query}} [options] */
export async function inspectMbtP3DeploymentReadiness({ runQuery = query } = {}) {
  return inspectDeploymentReadiness({
    runQuery,
    requiredMigrations: REQUIRED_MBT_P3_MIGRATIONS,
    evaluate: evaluateMbtP3DeploymentReadiness
  });
}

/** @param {Record<string, unknown>} environment */
function assertP2RuntimeSmokeEnvironment(environment) {
  if (text(environment.NODE_ENV) !== "production" || text(environment.MBT_TEST_ISOLATED) !== "1") {
    throw new Error("The Phase 2 endpoint smoke requires an isolated production runtime.");
  }
  for (const [name, expected] of P2_CLOSED_RUNTIME_GATES) {
    if (text(environment[name]).toLowerCase() !== expected) {
      throw new Error(`The Phase 2 endpoint smoke requires ${name} to remain closed.`);
    }
  }
}

/** @param {typeof query} runQuery */
async function p2OperationalState(runQuery) {
  const selected = await runQuery(P2_OPERATIONAL_STATE_SQL);
  if (!Array.isArray(selected?.rows) || selected.rows.length !== 1) {
    throw new Error("The Phase 2 endpoint smoke could not inspect operational state.");
  }
  return selected.rows[0];
}

/** @param {typeof query} runQuery @param {{operatorId: string, username: string, tokenHash: string}} fixture */
async function insertP2RuntimeOperator(runQuery, fixture) {
  await runQuery(
    `INSERT INTO operators (
       id, username, display_name, password_hash, password_salt,
       role, roles, yard_location_ids, active
     ) VALUES ($1, $2, 'MBT P2 isolated runtime smoke', $3, $4,
               'admin', ARRAY['admin']::text[], ARRAY[]::integer[], true)`,
    [fixture.operatorId, fixture.username, "runtime-smoke-disabled", "runtime-smoke-disabled"]
  );
  await runQuery(
    `INSERT INTO operator_sessions (token_hash, operator_id, expires_at)
     VALUES ($1, $2, clock_timestamp() + interval '5 minutes')`,
    [fixture.tokenHash, fixture.operatorId]
  );
}

/** @param {typeof query} runQuery @param {string} operatorId */
async function deleteP2RuntimeOperator(runQuery, operatorId) {
  await runQuery("DELETE FROM operators WHERE id = $1", [operatorId]);
}

/** @param {typeof fetch} fetchImpl @param {string} url @param {RequestInit} [init] */
async function fetchJson(fetchImpl, url, init = {}) {
  const response = await fetchImpl(url, init);
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("The Phase 2 endpoint smoke received a non-JSON response.");
  }
  return { status: Number(response.status), body };
}

/** @param {unknown} value @param {string} label */
function responseObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The Phase 2 ${label} response is malformed.`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {Record<string, unknown>} before @param {Record<string, unknown>} after */
function sameOperationalState(before, after) {
  return JSON.stringify(before) === JSON.stringify(after);
}

/** @param {Record<string, unknown>} state */
function assertP2DatabaseFlagsClosed(state) {
  if (!Array.isArray(state.enabled_flags) || state.enabled_flags.length > 0) {
    throw new Error("The Phase 2 endpoint smoke requires all database posting flags to remain closed.");
  }
}

/**
 * Exercise the actual production image through localhost only. The temporary
 * Admin identity exists solely in the isolated gauntlet database and is always
 * removed; no NetSuite request can occur because direct access must be closed.
 *
 * @param {object} [options]
 * @param {typeof query} [options.runQuery]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {Record<string, unknown>} [options.environment]
 */
export async function runMbtP2ProductionRuntimeSmoke({
  runQuery = query,
  fetchImpl = fetch,
  environment = process.env
} = {}) {
  assertP2RuntimeSmokeEnvironment(environment);
  const nonce = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString("base64url");
  const fixture = {
    operatorId: `mbt-p2-runtime-smoke-${nonce}`,
    username: `mbt-p2-runtime-smoke-${nonce}`,
    tokenHash: crypto.createHash("sha256").update(token).digest("hex")
  };
  const before = await p2OperationalState(runQuery);
  assertP2DatabaseFlagsClosed(before);
  try {
    await insertP2RuntimeOperator(runQuery, fixture);
    const anonymous = await fetchJson(fetchImpl, `${P2_RUNTIME_ENDPOINT}/latest`);
    const headers = { Authorization: `Bearer ${token}` };
    const authenticated = await fetchJson(fetchImpl, `${P2_RUNTIME_ENDPOINT}/latest`, { headers });
    const preflight = await fetchJson(fetchImpl, P2_RUNTIME_ENDPOINT, { method: "POST", headers });
    const authenticatedBody = responseObject(authenticated.body, "authenticated readiness");
    const preflightBody = responseObject(preflight.body, "fail-closed preflight");
    const after = await p2OperationalState(runQuery);
    const operationalStateUnchanged = sameOperationalState(before, after);
    if (anonymous.status !== 401
      || authenticated.status !== 200
      || authenticatedBody.phase !== 2
      || preflight.status !== 409
      || preflightBody.code !== "MBT_NETSUITE_DIRECT_ACCESS_REQUIRED"
      || !operationalStateUnchanged) {
      throw new Error("The Phase 2 production runtime endpoint smoke did not fail closed.");
    }
    return {
      ready: true,
      anonymousStatus: anonymous.status,
      authenticatedStatus: authenticated.status,
      preflightStatus: preflight.status,
      preflightCode: String(preflightBody.code),
      operationalStateUnchanged
    };
  } finally {
    await deleteP2RuntimeOperator(runQuery, fixture.operatorId);
  }
}

/** @param {Record<string, unknown>} environment */
function assertP3RuntimeSmokeEnvironment(environment) {
  if (text(environment.NODE_ENV) !== "production" || text(environment.MBT_TEST_ISOLATED) !== "1") {
    throw new Error("The Phase 3 endpoint smoke requires an isolated production runtime.");
  }
  for (const [name, expected] of P3_CLOSED_RUNTIME_GATES) {
    if (text(environment[name]).toLowerCase() !== expected) {
      throw new Error(`The Phase 3 endpoint smoke requires ${name} to remain closed.`);
    }
  }
}

/** @param {typeof query} runQuery */
async function p3OperationalState(runQuery) {
  const selected = await runQuery(P3_OPERATIONAL_STATE_SQL);
  if (!Array.isArray(selected?.rows) || selected.rows.length !== 1) {
    throw new Error("The Phase 3 endpoint smoke could not inspect operational state.");
  }
  return selected.rows[0];
}

/** @param {Record<string, unknown>} state */
function assertP3DatabaseFlagsClosed(state) {
  const flags = Array.isArray(state.feature_flags) ? state.feature_flags : [];
  const actual = flags.map((flag) => ({
    flagKey: text(flag?.flagKey),
    enabled: flag?.enabled
  }));
  const expected = REQUIRED_MBT_P3_FLAGS.map((flagKey) => ({ flagKey, enabled: false }));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("The Phase 3 endpoint smoke requires exactly nine closed database flags.");
  }
}

/** @param {typeof query} runQuery @param {{operatorId: string, username: string, tokenHash: string}} fixture */
async function insertP3RuntimeOperator(runQuery, fixture) {
  await runQuery(
    `INSERT INTO operators (
       id, username, display_name, password_hash, password_salt,
       role, roles, yard_location_ids, active
     ) VALUES ($1, $2, 'MBT P3 isolated runtime smoke', $3, $4,
               'admin', ARRAY['admin']::text[], ARRAY[]::integer[], true)`,
    [fixture.operatorId, fixture.username, "runtime-smoke-disabled", "runtime-smoke-disabled"]
  );
  await runQuery(
    `INSERT INTO operator_sessions (token_hash, operator_id, expires_at)
     VALUES ($1, $2, clock_timestamp() + interval '5 minutes')`,
    [fixture.tokenHash, fixture.operatorId]
  );
}

/** @param {typeof query} runQuery @param {string} operatorId */
async function deleteP3RuntimeOperator(runQuery, operatorId) {
  await runQuery("DELETE FROM operators WHERE id = $1", [operatorId]);
}

/** @param {typeof fetch} fetchImpl @param {string} url @param {RequestInit} [init] */
async function fetchP3Json(fetchImpl, url, init = {}) {
  const response = await fetchImpl(url, init);
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("The Phase 3 endpoint smoke received a non-JSON response.");
  }
  return { status: Number(response.status), body: responseObject(body, "runtime smoke") };
}

/**
 * Prove that the production-shaped Phase 3 runtime is closed at environment
 * and database layers and that a representative operational command cannot
 * alter retained state.
 *
 * @param {object} [options]
 * @param {typeof query} [options.runQuery]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {Record<string, unknown>} [options.environment]
 */
export async function runMbtP3ProductionRuntimeSmoke({
  runQuery = query,
  fetchImpl = fetch,
  environment = process.env
} = {}) {
  assertP3RuntimeSmokeEnvironment(environment);
  const before = await p3OperationalState(runQuery);
  assertP3DatabaseFlagsClosed(before);
  const nonce = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString("base64url");
  const fixture = {
    operatorId: `mbt-p3-runtime-smoke-${nonce}`,
    username: `mbt-p3-runtime-smoke-${nonce}`,
    tokenHash: crypto.createHash("sha256").update(token).digest("hex")
  };
  try {
    await insertP3RuntimeOperator(runQuery, fixture);
    const headers = { Authorization: `Bearer ${token}` };
    const status = await fetchP3Json(fetchImpl, P3_RUNTIME_STATUS_ENDPOINT, { headers });
    const blocked = await fetchP3Json(fetchImpl, P3_RUNTIME_BLOCKED_ENDPOINT, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: "{}"
    });
    const after = await p3OperationalState(runQuery);
    const operationalStateUnchanged = sameOperationalState(before, after);
    if (status.status !== 200
      || status.body.operational !== false
      || blocked.status !== 409
      || blocked.body.code !== "MBT_CAPABILITY_DISABLED"
      || !operationalStateUnchanged) {
      throw new Error("The Phase 3 production runtime endpoint smoke did not fail closed.");
    }
    return {
      ready: true,
      statusStatus: status.status,
      operational: false,
      blockedStatus: blocked.status,
      blockedCode: String(blocked.body.code),
      operationalStateUnchanged
    };
  } finally {
    await deleteP3RuntimeOperator(runQuery, fixture.operatorId);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  try {
    const p2RuntimeSmoke = process.env.MBT_P2_RUNTIME_SMOKE === "1";
    const p3RuntimeSmoke = process.env.MBT_P3_RUNTIME_SMOKE === "1";
    if (p2RuntimeSmoke && p3RuntimeSmoke) {
      throw new Error("Select only one MBT production runtime smoke phase.");
    }
    const runtimeSmoke = p2RuntimeSmoke || p3RuntimeSmoke;
    if (!runtimeSmoke && process.env.MBT_PREDEPLOY_READ_ONLY !== "1") {
      throw new Error("Set MBT_PREDEPLOY_READ_ONLY=1 to run the read-only MBT deployment preflight.");
    }
    const phase = text(process.env.MBT_PREDEPLOY_PHASE || "P1").toUpperCase();
    if (!runtimeSmoke && phase !== "P1" && phase !== "P2" && phase !== "P3") {
      throw new Error("MBT_PREDEPLOY_PHASE must be P1, P2, or P3.");
    }
    const result = p3RuntimeSmoke
      ? await runMbtP3ProductionRuntimeSmoke()
      : p2RuntimeSmoke
        ? await runMbtP2ProductionRuntimeSmoke()
        : phase === "P3"
          ? await inspectMbtP3DeploymentReadiness()
          : phase === "P2"
        ? await inspectMbtP2DeploymentReadiness()
        : await inspectMbtP1DeploymentReadiness();
    console.log(JSON.stringify(result, null, 2));
    if (!result.ready) {
      process.exitCode = 1;
    }
  } finally {
    await closeDb();
  }
}
