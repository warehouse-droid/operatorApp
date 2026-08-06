import assert from "node:assert/strict";
import test, { after } from "node:test";

import { closeDb } from "../../../src/db.js";
import {
  REQUIRED_MBT_P2_MIGRATIONS,
  evaluateMbtP1DeploymentReadiness,
  evaluateMbtP2DeploymentReadiness,
  inspectMbtP1DeploymentReadiness,
  runMbtP2ProductionRuntimeSmoke
} from "../../../tools/mbt-predeploy-readiness.mjs";

const SNAPSHOT_SCAN_PAGE_SIZE = 1;

const REQUIRED_MIGRATIONS = Object.freeze([
  "102_mbt_authorities_flags_audit.sql",
  "103_netsuite_customer_master_foundation.sql",
  "104_mbt_assets_templates_fleet.sql",
  "105_mbt_rates_contracts_visits.sql",
  "106_mbt_billing_outbox.sql",
  "107_mbt_netsuite_mappings_preflight.sql"
]);

const REQUIRED_P2_MIGRATIONS = Object.freeze([
  ...REQUIRED_MIGRATIONS,
  "108_mbt_netsuite_sandbox_readiness.sql",
  "109_mbt_local_first_configuration.sql"
]);

after(async () => {
  await closeDb();
});

test("F14/F16: predeployment evaluation fails closed for migration, flag, and legacy-key collisions", () => {
  const result = evaluateMbtP1DeploymentReadiness({
    appliedMigrations: REQUIRED_MIGRATIONS.slice(0, -1),
    flags: [
      { flag_key: "mbt_enabled", enabled: true },
      { flag_key: "mbt_bin_dispatch", enabled: false }
    ],
    snapshotRows: [
      {
        source: "current",
        record_id: "55",
        plan_id: "12",
        orders: [{ id: "SO-ORDINARY", type: "SO" }],
        trucks: [{
          loads: [{
            stops: [{ id: "LEGACY-RESERVED-KEY", type: "drop", mbt: { legacy: true } }]
          }]
        }]
      }
    ]
  });

  assert.deepEqual(result, {
    ready: false,
    missingMigrations: ["107_mbt_netsuite_mappings_preflight.sql"],
    enabledFlags: ["mbt_enabled"],
    dispatchCollisions: [{
      source: "current",
      recordId: "55",
      planId: "12",
      identities: [{ id: "LEGACY-RESERVED-KEY", type: "drop" }]
    }]
  });
});

test("F14/F16: the freshly migrated isolated database is safe for a migration-first P1 rollout", async () => {
  assert.deepEqual(await inspectMbtP1DeploymentReadiness(), {
    ready: true,
    missingMigrations: [],
    enabledFlags: [],
    dispatchCollisions: []
  });
});

test("LC01/P2-F07: P2 requires migrations 108-109 without changing the P1 deployment contract", () => {
  const p1 = evaluateMbtP1DeploymentReadiness({
    appliedMigrations: REQUIRED_MIGRATIONS,
    flags: [],
    snapshotRows: []
  });
  const missing108 = evaluateMbtP2DeploymentReadiness({
    appliedMigrations: REQUIRED_MIGRATIONS,
    flags: [],
    snapshotRows: []
  });
  const p2 = evaluateMbtP2DeploymentReadiness({
    appliedMigrations: REQUIRED_P2_MIGRATIONS,
    flags: [],
    snapshotRows: []
  });

  assert.equal(p1.ready, true);
  assert.deepEqual(REQUIRED_MBT_P2_MIGRATIONS, REQUIRED_P2_MIGRATIONS);
  assert.deepEqual(missing108, {
    ready: false,
    missingMigrations: [
      "108_mbt_netsuite_sandbox_readiness.sql",
      "109_mbt_local_first_configuration.sql"
    ],
    enabledFlags: [],
    dispatchCollisions: []
  });
  assert.deepEqual(p2, {
    ready: true,
    missingMigrations: [],
    enabledFlags: [],
    dispatchCollisions: []
  });
});

function smokeResponse(status, payload) {
  return {
    status,
    async json() {
      return payload;
    }
  };
}

const CLOSED_P2_RUNTIME = Object.freeze({
  NODE_ENV: "production",
  MBT_TEST_ISOLATED: "1",
  MBT_ENABLED: "false",
  MBT_NETSUITE_WRITES_ENABLED: "false",
  NETSUITE_DIRECT_ACCESS_ENABLED: "false"
});

test("P2-F07: production runtime smoke proves auth and fails closed without operational effects", async () => {
  const calls = [];
  const queries = [];
  const operationalState = {
    preflight_runs: 0,
    contracts: 0,
    visits: 0,
    reservations: 0,
    movements: 0,
    billing_versions: 0,
    deposits: 0,
    outbox: 0,
    enabled_flags: []
  };
  const result = await runMbtP2ProductionRuntimeSmoke({
    environment: CLOSED_P2_RUNTIME,
    runQuery: async (sql, params = []) => {
      queries.push({ sql, params });
      if (/AS preflight_runs/.test(sql)) {
        return { rows: [{ ...operationalState }] };
      }
      return { rows: [], rowCount: 1 };
    },
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      const authorization = init.headers?.Authorization;
      if (!authorization) {
        return smokeResponse(401, { error: "Login required" });
      }
      if (init.method === "POST") {
        return smokeResponse(409, {
          code: "MBT_NETSUITE_DIRECT_ACCESS_REQUIRED",
          message: "Direct NetSuite access must be enabled for sandbox readiness."
        });
      }
      return smokeResponse(200, { phase: 2, run: null });
    }
  });

  assert.deepEqual(result, {
    ready: true,
    anonymousStatus: 401,
    authenticatedStatus: 200,
    preflightStatus: 409,
    preflightCode: "MBT_NETSUITE_DIRECT_ACCESS_REQUIRED",
    operationalStateUnchanged: true
  });
  assert.deepEqual(calls.map(({ url, init }) => ({
    path: new URL(url).pathname,
    method: init.method || "GET",
    authenticated: Boolean(init.headers?.Authorization)
  })), [
    {
      path: "/api/mbt/config/netsuite/preflight/latest",
      method: "GET",
      authenticated: false
    },
    {
      path: "/api/mbt/config/netsuite/preflight/latest",
      method: "GET",
      authenticated: true
    },
    {
      path: "/api/mbt/config/netsuite/preflight",
      method: "POST",
      authenticated: true
    }
  ]);
  assert.equal(queries.filter(({ sql }) => /AS preflight_runs/.test(sql)).length, 2);
  assert.ok(queries.some(({ sql }) => /INSERT INTO operators/.test(sql)));
  assert.ok(queries.some(({ sql }) => /INSERT INTO operator_sessions/.test(sql)));
  assert.ok(queries.some(({ sql }) => /DELETE FROM operators/.test(sql)));
});

test("P2-F07: production runtime smoke refuses every open or ambiguous gate before access", async () => {
  for (const [key, value] of [
    ["NODE_ENV", "test"],
    ["MBT_TEST_ISOLATED", "0"],
    ["MBT_ENABLED", "true"],
    ["MBT_NETSUITE_WRITES_ENABLED", "true"],
    ["NETSUITE_DIRECT_ACCESS_ENABLED", "true"]
  ]) {
    let accesses = 0;
    await assert.rejects(
      runMbtP2ProductionRuntimeSmoke({
        environment: { ...CLOSED_P2_RUNTIME, [key]: value },
        runQuery: async () => {
          accesses += 1;
          return { rows: [] };
        },
        fetchImpl: async () => {
          accesses += 1;
          return smokeResponse(500, {});
        }
      }),
      /isolated production runtime|closed/i,
      `${key}=${value}`
    );
    assert.equal(accesses, 0, `${key}=${value}`);
  }
});

test("P2-F07: production runtime smoke refuses enabled database posting flags before auth setup", async () => {
  const queries = [];
  let fetches = 0;
  await assert.rejects(
    runMbtP2ProductionRuntimeSmoke({
      environment: CLOSED_P2_RUNTIME,
      runQuery: async (sql, params = []) => {
        queries.push({ sql, params });
        return {
          rows: [{
            preflight_runs: 0,
            contracts: 0,
            visits: 0,
            reservations: 0,
            movements: 0,
            billing_versions: 0,
            deposits: 0,
            outbox: 0,
            enabled_flags: ["mbt_netsuite_posting"]
          }]
        };
      },
      fetchImpl: async () => {
        fetches += 1;
        return smokeResponse(500, {});
      }
    }),
    /database posting flags.*closed/i
  );
  assert.equal(queries.length, 1);
  assert.equal(fetches, 0);
  assert.doesNotMatch(queries[0].sql, /\b(?:INSERT|UPDATE|DELETE)\b/i);
});

test("P1-R3: production-scale snapshot history is fully inspected through bounded keyset pages", async () => {
  const currentSize = SNAPSHOT_SCAN_PAGE_SIZE + 3;
  const historySize = (SNAPSHOT_SCAN_PAGE_SIZE * 200) + 7;
  const collisionId = historySize - SNAPSHOT_SCAN_PAGE_SIZE - 1;
  const inspected = { current: 0, history: 0 };
  let maximumPageLength = 0;
  let snapshotQueryCount = 0;

  const result = await inspectMbtP1DeploymentReadiness({
    runQuery: async (sql, params = []) => {
      if (/FROM schema_migrations/.test(sql)) {
        return { rows: REQUIRED_MIGRATIONS.map((filename) => ({ filename })) };
      }
      if (/FROM mbt_feature_flags/.test(sql)) {
        return { rows: [] };
      }

      const source = /FROM dispatch_plan_snapshot_history/.test(sql) ? "history" : "current";
      const size = source === "history" ? historySize : currentSize;
      const [cursor, requestedPageSize] = params;
      const keysetColumn = source === "history" ? "history.id" : "snapshot.plan_id";
      assert.ok(sql.includes(`OR ${keysetColumn} > $1::bigint`));
      assert.ok(sql.includes(`ORDER BY ${keysetColumn} ASC`));
      assert.match(sql, /LIMIT \$2::integer/);
      assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/i);
      assert.equal(requestedPageSize, SNAPSHOT_SCAN_PAGE_SIZE);
      snapshotQueryCount += 1;

      const firstId = cursor === null ? 1 : Number(cursor) + 1;
      const lastId = Math.min(size, firstId + requestedPageSize - 1);
      const rows = firstId > size
        ? []
        : Array.from({ length: lastId - firstId + 1 }, (_, offset) => {
          const id = firstId + offset;
          return {
            scan_id: String(id),
            source,
            record_id: String(id),
            plan_id: String(source === "history" ? Math.ceil(id / 3) : id),
            orders: source === "history" && id === collisionId
              ? [{ id: "BIN-LATE-HISTORY", type: "BIN" }]
              : [{ id: `${source.toUpperCase()}-${id}`, type: "SO" }],
            trucks: []
          };
        });
      maximumPageLength = Math.max(maximumPageLength, rows.length);
      inspected[source] += rows.length;
      return { rows };
    }
  });

  assert.equal(inspected.current, currentSize);
  assert.equal(inspected.history, historySize);
  assert.ok(snapshotQueryCount > 200);
  assert.ok(maximumPageLength <= SNAPSHOT_SCAN_PAGE_SIZE);
  assert.deepEqual(result, {
    ready: false,
    missingMigrations: [],
    enabledFlags: [],
    dispatchCollisions: [{
      source: "history",
      recordId: String(collisionId),
      planId: String(Math.ceil(collisionId / 3)),
      identities: [{ id: "BIN-LATE-HISTORY", type: "BIN" }]
    }]
  });
});

test("P1-R3: bigint keyset order scans sparse IDs 1, 2, and 10 without lexicographic skips", async () => {
  const historyIds = [1, 2, 10];
  const historyCursors = [];

  const result = await inspectMbtP1DeploymentReadiness({
    runQuery: async (sql, params = []) => {
      if (/FROM schema_migrations/.test(sql)) {
        return { rows: REQUIRED_MIGRATIONS.map((filename) => ({ filename })) };
      }
      if (/FROM mbt_feature_flags/.test(sql)) {
        return { rows: [] };
      }
      if (/FROM dispatch_plan_snapshots/.test(sql)) {
        assert.ok(sql.includes("OR snapshot.plan_id > $1::bigint"));
        assert.ok(sql.includes("ORDER BY snapshot.plan_id ASC"));
        return { rows: [] };
      }

      assert.ok(sql.includes("OR history.id > $1::bigint"));
      assert.ok(sql.includes("ORDER BY history.id ASC"));
      const [cursor, requestedPageSize] = params;
      assert.equal(requestedPageSize, 1);
      historyCursors.push(cursor);
      const nextId = historyIds.find((id) => cursor === null || id > Number(cursor));
      return {
        rows: nextId === undefined ? [] : [{
          scan_id: String(nextId),
          source: "history",
          record_id: String(nextId),
          plan_id: "8",
          orders: nextId === 10 ? [{ id: "BIN-SPARSE-10", type: "BIN" }] : [],
          trucks: []
        }]
      };
    }
  });

  assert.deepEqual(historyCursors, [null, "1", "2", "10"]);
  assert.deepEqual(result.dispatchCollisions, [{
    source: "history",
    recordId: "10",
    planId: "8",
    identities: [{ id: "BIN-SPARSE-10", type: "BIN" }]
  }]);
});

test("P1-R3: snapshot keyset pagination fails closed when a page cannot advance", async () => {
  await assert.rejects(
    inspectMbtP1DeploymentReadiness({
      runQuery: async (sql) => {
        if (/FROM schema_migrations/.test(sql)) {
          return { rows: REQUIRED_MIGRATIONS.map((filename) => ({ filename })) };
        }
        if (/FROM mbt_feature_flags/.test(sql)) {
          return { rows: [] };
        }
        return {
          rows: Array.from({ length: SNAPSHOT_SCAN_PAGE_SIZE }, () => ({
            scan_id: "1",
            source: "current",
            record_id: "1",
            plan_id: "1",
            orders: [],
            trucks: []
          }))
        };
      }
    }),
    /strictly increasing keyset/
  );
});
