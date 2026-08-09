// @ts-check

import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { closeDb } from "../../../src/db.js";
import {
  REQUIRED_MBT_P2_MIGRATIONS,
  REQUIRED_MBT_P3_FLAGS,
  REQUIRED_MBT_P3_MIGRATIONS,
  evaluateMbtP3DeploymentReadiness,
  runMbtP3ProductionRuntimeSmoke
} from "../../../tools/mbt-predeploy-readiness.mjs";

const CLOSED_ENVIRONMENT = Object.freeze({
  NODE_ENV: "production",
  MBT_TEST_ISOLATED: "1",
  MBT_ENABLED: "false",
  MBT_CUSTOMER_SYNC_ENABLED: "false",
  MBT_MASTER_DATA_ENABLED: "false",
  MBT_ASSET_MANAGEMENT_ENABLED: "false",
  MBT_FRONTDESK_OPERATIONS_ENABLED: "false",
  MBT_BIN_DISPATCH_ENABLED: "false",
  MBT_DRIVER_EXECUTION_ENABLED: "false",
  MBT_BILLING_OPERATIONS_ENABLED: "false",
  MBT_NETSUITE_WRITES_ENABLED: "false",
  NETSUITE_DIRECT_ACCESS_ENABLED: "false",
  SMART_SCM_LIVE_EXECUTION_ENABLED: "false",
  SAMSARA_WRITES_ENABLED: "false"
});
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationDirectory = path.resolve(testDirectory, "../../../migrations");

const EXPECTED_FLAGS = Object.freeze([
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

const CLOSED_ENVIRONMENT_MUTATIONS = Object.freeze([
  ["NODE_ENV", "test"],
  ["MBT_TEST_ISOLATED", "0"],
  ...Object.keys(CLOSED_ENVIRONMENT)
    .filter((key) => key !== "NODE_ENV" && key !== "MBT_TEST_ISOLATED")
    .map((key) => [key, "true"])
]);

function featureFlags() {
  return EXPECTED_FLAGS.map((flagKey) => ({ flagKey, enabled: false }));
}

function operationalState(overrides = {}) {
  return {
    preflight_runs: 0,
    contracts: 0,
    visits: 0,
    reservations: 0,
    movements: 0,
    billing_versions: 0,
    deposits: 0,
    outbox: 0,
    command_receipts: 0,
    audit_events: 0,
    feature_flags: featureFlags(),
    ...overrides
  };
}

function response(status, body) {
  return { status, async json() { return body; } };
}

after(async () => {
  await closeDb();
});

test("P3.12: deployment readiness requires every Phase 3 migration and exactly nine false flags", () => {
  assert.deepEqual(REQUIRED_MBT_P3_MIGRATIONS, [
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
    "142_mbt_frontdesk_customer_charge_requests.sql"
  ]);
  assert.deepEqual(REQUIRED_MBT_P3_FLAGS, EXPECTED_FLAGS);
  const rows = EXPECTED_FLAGS.map((flag_key) => ({ flag_key, enabled: false }));
  assert.equal(evaluateMbtP3DeploymentReadiness({
    appliedMigrations: REQUIRED_MBT_P3_MIGRATIONS,
    flags: rows,
    snapshotRows: []
  }).ready, true);

  for (const [label, appliedMigrations, flags] of [
    ["migration", REQUIRED_MBT_P2_MIGRATIONS, rows],
    ["missing flag", REQUIRED_MBT_P3_MIGRATIONS, rows.slice(1)],
    ["enabled flag", REQUIRED_MBT_P3_MIGRATIONS, rows.map((row, index) =>
      index === 0 ? { ...row, enabled: true } : row)],
    ["unexpected flag", REQUIRED_MBT_P3_MIGRATIONS, [
      ...rows,
      { flag_key: "mbt_unapproved", enabled: false }
    ]]
  ]) {
    assert.equal(evaluateMbtP3DeploymentReadiness({
      appliedMigrations,
      flags,
      snapshotRows: []
    }).ready, false, label);
  }
});

test("P3.11: the deployment inventory exactly covers every on-disk MBT-era migration", async () => {
  const onDisk = (await readdir(migrationDirectory))
    .filter((filename) => {
      const sequence = /^(\d{3})_/u.exec(filename)?.[1];
      return sequence && Number(sequence) >= 102 && filename.endsWith(".sql");
    })
    .sort();
  assert.deepEqual(REQUIRED_MBT_P3_MIGRATIONS, onDisk);
});

test("P3.1: production smoke refuses every open or ambiguous environment gate before access", async () => {
  for (const [key, value] of CLOSED_ENVIRONMENT_MUTATIONS) {
    let accesses = 0;
    await assert.rejects(runMbtP3ProductionRuntimeSmoke({
      environment: { ...CLOSED_ENVIRONMENT, [key]: value },
      runQuery: async () => {
        accesses += 1;
        return { rows: [] };
      },
      fetchImpl: async () => {
        accesses += 1;
        return response(500, {});
      }
    }), /isolated production runtime|remain closed/i, `${key}=${value}`);
    assert.equal(accesses, 0, `${key}=${value}`);
  }
});

test("P3.1: database flags are validated before authentication setup or fetch", async () => {
  for (const invalidFlags of [
    featureFlags().slice(1),
    featureFlags().map((flag, index) => index === 0 ? { ...flag, enabled: true } : flag),
    [...featureFlags(), { flagKey: "mbt_unapproved", enabled: false }]
  ]) {
    const events = [];
    await assert.rejects(runMbtP3ProductionRuntimeSmoke({
      environment: CLOSED_ENVIRONMENT,
      runQuery: async (sql) => {
        events.push(String(sql));
        return { rows: [operationalState({ feature_flags: invalidFlags })] };
      },
      fetchImpl: async () => {
        events.push("fetch");
        return response(500, {});
      }
    }), /exactly nine closed database flags/i);
    assert.equal(events.length, 1);
    assert.match(events[0], /FROM mbt_feature_flags/);
  }
});

test("P3.1: authenticated runtime GET and blocked POST leave operational state unchanged and clean up", async () => {
  const events = [];
  const requests = [];
  const state = operationalState();
  const result = await runMbtP3ProductionRuntimeSmoke({
    environment: CLOSED_ENVIRONMENT,
    runQuery: async (sql) => {
      if (/AS preflight_runs/.test(sql)) {
        events.push("state");
        return { rows: [structuredClone(state)] };
      }
      if (/INSERT INTO operators/.test(sql)) {
        events.push("insert-operator");
      } else if (/INSERT INTO operator_sessions/.test(sql)) {
        events.push("insert-session");
      } else if (/DELETE FROM operators/.test(sql)) {
        events.push("delete-operator");
      }
      return { rows: [], rowCount: 1 };
    },
    fetchImpl: async (url, init = {}) => {
      const request = {
        path: new URL(String(url)).pathname,
        method: init.method || "GET",
        authorization: String(init.headers?.Authorization || "")
      };
      requests.push(request);
      events.push(`${request.method} ${request.path}`);
      assert.match(request.authorization, /^Bearer \S+$/);
      return request.method === "POST"
        ? response(409, { code: "MBT_CAPABILITY_DISABLED" })
        : response(200, { operational: false });
    }
  });

  assert.deepEqual(result, {
    ready: true,
    statusStatus: 200,
    operational: false,
    blockedStatus: 409,
    blockedCode: "MBT_CAPABILITY_DISABLED",
    operationalStateUnchanged: true
  });
  assert.equal(requests[0].authorization, requests[1].authorization);
  assert.deepEqual(events, [
    "state",
    "insert-operator",
    "insert-session",
    "GET /api/mbt/status",
    "POST /api/mbt/bin-assets/00000000-0000-4000-8000-000000000014/reservations",
    "state",
    "delete-operator"
  ]);
});

test("P3.1: runtime smoke cleans up its temporary Admin after endpoint or state failure", async () => {
  for (const failure of ["endpoint", "state_changed"]) {
    let stateReads = 0;
    let cleaned = false;
    await assert.rejects(runMbtP3ProductionRuntimeSmoke({
      environment: CLOSED_ENVIRONMENT,
      runQuery: async (sql) => {
        if (/AS preflight_runs/.test(sql)) {
          stateReads += 1;
          return { rows: [operationalState(
            failure === "state_changed" && stateReads === 2 ? { movements: 1 } : {}
          )] };
        }
        if (/DELETE FROM operators/.test(sql)) {
          cleaned = true;
        }
        return { rows: [], rowCount: 1 };
      },
      fetchImpl: async (url, init = {}) => {
        if (failure === "endpoint") {
          throw new Error("synthetic endpoint failure");
        }
        return init.method === "POST"
          ? response(409, { code: "MBT_CAPABILITY_DISABLED" })
          : response(200, { operational: false });
      }
    }), failure === "endpoint" ? /synthetic endpoint failure/ : /did not fail closed/);
    assert.equal(cleaned, true, failure);
  }
});
