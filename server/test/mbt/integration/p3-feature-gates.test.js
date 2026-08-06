import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { closeDb, query } from "../../../src/db.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(testDirectory, "../../..");
const configSourcePath = path.join(serverRoot, "src/config.js");
const nodeModulesPath = path.join(serverRoot, "node_modules");

const PHASE3_CAPABILITIES = Object.freeze({
  customerSync: Object.freeze({
    databaseFlag: "mbt_customer_sync",
    environmentProperty: "customerSyncEnabled",
    environmentVariable: "MBT_CUSTOMER_SYNC_ENABLED"
  }),
  masterData: Object.freeze({
    databaseFlag: "mbt_master_data",
    environmentProperty: "masterDataEnabled",
    environmentVariable: "MBT_MASTER_DATA_ENABLED"
  }),
  assetManagement: Object.freeze({
    databaseFlag: "mbt_asset_management",
    environmentProperty: "assetManagementEnabled",
    environmentVariable: "MBT_ASSET_MANAGEMENT_ENABLED"
  }),
  frontdeskOperations: Object.freeze({
    databaseFlag: "mbt_frontdesk_operations",
    environmentProperty: "frontdeskOperationsEnabled",
    environmentVariable: "MBT_FRONTDESK_OPERATIONS_ENABLED"
  }),
  binDispatch: Object.freeze({
    databaseFlag: "mbt_bin_dispatch",
    environmentProperty: "binDispatchEnabled",
    environmentVariable: "MBT_BIN_DISPATCH_ENABLED"
  }),
  driverExecution: Object.freeze({
    databaseFlag: "mbt_driver_execution",
    environmentProperty: "driverExecutionEnabled",
    environmentVariable: "MBT_DRIVER_EXECUTION_ENABLED"
  }),
  billingOperations: Object.freeze({
    databaseFlag: "mbt_billing_operations",
    environmentProperty: "billingOperationsEnabled",
    environmentVariable: "MBT_BILLING_OPERATIONS_ENABLED"
  })
});

const EXPECTED_DATABASE_FLAGS = Object.freeze([
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

const PHASE3_ENVIRONMENT_KEYS = Object.freeze(
  Object.values(PHASE3_CAPABILITIES).map(({ environmentVariable }) => environmentVariable)
);

const MANAGED_ENVIRONMENT_KEYS = Object.freeze([
  "MBBS_ENV_FILE",
  "DATABASE_URL",
  "MBT_ENABLED",
  "MBT_NETSUITE_WRITES_ENABLED",
  ...PHASE3_ENVIRONMENT_KEYS
]);

function futurePhase3Capabilities() {
  return import("../../../src/mbt/phase3-capabilities.js");
}

function databaseFlags(enabled = []) {
  const enabledSet = new Set(enabled);
  return Object.fromEntries(EXPECTED_DATABASE_FLAGS.map((flagKey) => [
    flagKey,
    enabledSet.has(flagKey)
  ]));
}

function environmentFor(capability, overrides = {}) {
  const definition = PHASE3_CAPABILITIES[capability];
  assert.ok(definition, `Unknown test capability ${capability}`);
  return {
    enabled: true,
    netSuiteWritesEnabled: false,
    ...Object.fromEntries(Object.values(PHASE3_CAPABILITIES).map(({ environmentProperty }) => [
      environmentProperty,
      false
    ])),
    [definition.environmentProperty]: true,
    ...overrides
  };
}

function snapshotManagedEnvironment() {
  return new Map(MANAGED_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]));
}

function restoreManagedEnvironment(snapshot) {
  for (const [key, value] of snapshot) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function withIsolatedConfig(envFiles, activeEnvFile, operation) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "mbt-p3-gates-"));
  const environmentSnapshot = snapshotManagedEnvironment();
  try {
    await mkdir(path.join(fixtureRoot, "src"), { recursive: true });
    await writeFile(
      path.join(fixtureRoot, "package.json"),
      JSON.stringify({ private: true, type: "module" })
    );
    await writeFile(
      path.join(fixtureRoot, "src/config.js"),
      await readFile(configSourcePath, "utf8")
    );
    await symlink(nodeModulesPath, path.join(fixtureRoot, "node_modules"), "dir");
    for (const [filename, contents] of Object.entries(envFiles)) {
      await writeFile(path.join(fixtureRoot, filename), contents);
    }

    for (const key of MANAGED_ENVIRONMENT_KEYS) {
      delete process.env[key];
    }
    process.env.MBBS_ENV_FILE = activeEnvFile;
    const moduleUrl = pathToFileURL(path.join(fixtureRoot, "src/config.js"));
    moduleUrl.searchParams.set("fixture", path.basename(fixtureRoot));
    await operation(await import(moduleUrl.href));
  } finally {
    restoreManagedEnvironment(environmentSnapshot);
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

function envFile(gateValues = {}) {
  return [
    "DATABASE_URL=postgres://localhost/mbt_test",
    "MBT_ENABLED=false",
    "MBT_NETSUITE_WRITES_ENABLED=false",
    ...Object.entries(gateValues).map(([key, value]) => `${key}=${value}`),
    ""
  ].join("\n");
}

function phase3EnvironmentSnapshot(config) {
  return Object.fromEntries(Object.values(PHASE3_CAPABILITIES).map(({ environmentProperty }) => [
    environmentProperty,
    config.mbtPhase3?.[environmentProperty]
  ]));
}

after(async () => {
  await closeDb();
});

test("P3-F29: the database exposes exactly nine Phase 3 flags and every one defaults false", async () => {
  const result = await query(
    `SELECT flag_key, enabled
       FROM mbt_feature_flags
      WHERE left(flag_key, 4) = 'mbt_'
      ORDER BY flag_key`
  );
  assert.deepEqual(
    result.rows,
    EXPECTED_DATABASE_FLAGS.map((flagKey) => ({ flag_key: flagKey, enabled: false }))
  );
});

test("P3-F29: the Phase 3 capability catalog binds each specific DB and environment gate", async () => {
  const { MBT_PHASE3_CAPABILITY_DEFINITIONS } = await futurePhase3Capabilities();
  assert.deepEqual(MBT_PHASE3_CAPABILITY_DEFINITIONS, {
    ...PHASE3_CAPABILITIES,
    netSuiteWrites: {
      databaseFlag: "mbt_netsuite_writes",
      environmentProperty: "netSuiteWritesEnabled",
      environmentVariable: "MBT_NETSUITE_WRITES_ENABLED",
      phase3Forbidden: true
    }
  });
});

test("P3-F29: root, specific environment, database, and pilot gates fail independently", async () => {
  const { evaluateMbtPhase3Capability } = await futurePhase3Capabilities();
  const completeDatabase = databaseFlags(["mbt_enabled", "mbt_customer_sync"]);
  const completeEnvironment = environmentFor("customerSync");
  const common = {
    capability: "customerSync",
    environment: completeEnvironment,
    databaseFlags: completeDatabase,
    pilotAuthorized: true
  };

  assert.deepEqual(evaluateMbtPhase3Capability(common), {
    enabled: true,
    code: null,
    reason: null
  });

  for (const [label, input, reason] of [
    ["environment root", {
      ...common,
      environment: { ...completeEnvironment, enabled: false }
    }, "environment_root_disabled"],
    ["specific environment", {
      ...common,
      environment: { ...completeEnvironment, customerSyncEnabled: false }
    }, "environment_capability_disabled"],
    ["database root", {
      ...common,
      databaseFlags: { ...completeDatabase, mbt_enabled: false }
    }, "database_root_disabled"],
    ["specific database", {
      ...common,
      databaseFlags: { ...completeDatabase, mbt_customer_sync: false }
    }, "database_capability_disabled"],
    ["pilot scope", {
      ...common,
      pilotAuthorized: false
    }, "pilot_scope_denied"]
  ]) {
    assert.deepEqual(evaluateMbtPhase3Capability(input), {
      enabled: false,
      code: "MBT_CAPABILITY_DISABLED",
      reason
    }, label);
  }
});

test("P3-F29: a missing database root or capability row fails closed distinctly", async () => {
  const { evaluateMbtPhase3Capability } = await futurePhase3Capabilities();
  const environment = environmentFor("assetManagement");
  const complete = databaseFlags(["mbt_enabled", "mbt_asset_management"]);
  const missingRoot = { ...complete };
  const missingCapability = { ...complete };
  delete missingRoot.mbt_enabled;
  delete missingCapability.mbt_asset_management;

  assert.deepEqual(evaluateMbtPhase3Capability({
    capability: "assetManagement",
    environment,
    databaseFlags: missingRoot,
    pilotAuthorized: true
  }), {
    enabled: false,
    code: "MBT_CAPABILITY_DISABLED",
    reason: "database_root_missing"
  });
  assert.deepEqual(evaluateMbtPhase3Capability({
    capability: "assetManagement",
    environment,
    databaseFlags: missingCapability,
    pilotAuthorized: true
  }), {
    enabled: false,
    code: "MBT_CAPABILITY_DISABLED",
    reason: "database_capability_missing"
  });
});

test("P3-F29: enabling customer sync cannot enable any other Phase 3 capability", async () => {
  const { evaluateMbtPhase3Capabilities } = await futurePhase3Capabilities();
  const result = evaluateMbtPhase3Capabilities({
    environment: environmentFor("customerSync"),
    databaseFlags: databaseFlags(["mbt_enabled", "mbt_customer_sync"]),
    pilotAuthorized: true
  });

  assert.equal(result.customerSync.enabled, true);
  for (const [capability, state] of Object.entries(result)) {
    if (capability !== "customerSync") {
      assert.equal(state.enabled, false, capability);
      assert.equal(state.code, "MBT_CAPABILITY_DISABLED", capability);
    }
  }
});

test("P3-F29: NetSuite writes remain forbidden throughout Phase 3 even when every gate is true", async () => {
  const { evaluateMbtPhase3Capability } = await futurePhase3Capabilities();
  assert.deepEqual(evaluateMbtPhase3Capability({
    capability: "netSuiteWrites",
    environment: {
      ...environmentFor("customerSync"),
      netSuiteWritesEnabled: true
    },
    databaseFlags: databaseFlags(["mbt_enabled", "mbt_netsuite_writes"]),
    pilotAuthorized: true
  }), {
    enabled: false,
    code: "MBT_CAPABILITY_DISABLED",
    reason: "phase3_netsuite_writes_forbidden"
  });
});

test("P3-F29: all seven Phase 3 environment gates default false when absent", async () => {
  await withIsolatedConfig(
    { ".env.initial": envFile() },
    ".env.initial",
    async ({ config }) => {
      assert.deepEqual(phase3EnvironmentSnapshot(config), Object.fromEntries(
        Object.values(PHASE3_CAPABILITIES).map(({ environmentProperty }) => [
          environmentProperty,
          false
        ])
      ));
    }
  );
});

test("P3-F29: all seven Phase 3 environment gates parse only explicit truthy values", async () => {
  const truthyValues = ["1", "true", "YES", "on", "TRUE", "yes", "ON"];
  const falseValues = ["0", "false", "no", "off", "unexpected", "FALSE", "disabled"];
  const truthyFile = Object.fromEntries(PHASE3_ENVIRONMENT_KEYS.map((key, index) => [
    key,
    truthyValues[index]
  ]));
  const falseFile = Object.fromEntries(PHASE3_ENVIRONMENT_KEYS.map((key, index) => [
    key,
    falseValues[index]
  ]));

  await withIsolatedConfig(
    {
      ".env.initial": envFile(truthyFile),
      ".env.false": envFile(falseFile)
    },
    ".env.initial",
    async (configModule) => {
      assert.ok(Object.values(phase3EnvironmentSnapshot(configModule.config)).every(Boolean));
      await configModule.applyEnvFile(".env.false");
      assert.ok(Object.values(phase3EnvironmentSnapshot(configModule.config)).every((value) => value === false));
    }
  );
});

test("P3-F29: env reload clears omitted Phase 3 gates instead of retaining prior activation", async () => {
  const enabledFile = Object.fromEntries(PHASE3_ENVIRONMENT_KEYS.map((key) => [key, "true"]));
  await withIsolatedConfig(
    {
      ".env.initial": envFile(enabledFile),
      ".env.closed": envFile()
    },
    ".env.initial",
    async (configModule) => {
      assert.ok(Object.values(phase3EnvironmentSnapshot(configModule.config)).every(Boolean));
      await configModule.applyEnvFile(".env.closed");
      assert.ok(Object.values(phase3EnvironmentSnapshot(configModule.config)).every((value) => value === false));
      assert.deepEqual(
        Object.fromEntries(PHASE3_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]])),
        Object.fromEntries(PHASE3_ENVIRONMENT_KEYS.map((key) => [key, undefined]))
      );
    }
  );
});
