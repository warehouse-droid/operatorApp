import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(testDirectory, "../../..");
const configSourcePath = path.join(serverRoot, "src/config.js");
const nodeModulesPath = path.join(serverRoot, "node_modules");
const MANAGED_ENV_KEYS = Object.freeze([
  "MBBS_ENV_FILE",
  "DATABASE_URL",
  "MBT_ENABLED",
  "MBT_NETSUITE_WRITES_ENABLED",
  "NETSUITE_ACCOUNT_ID",
  "NETSUITE_REST_BASE_URL",
  "NETSUITE_DIRECT_ACCESS_ENABLED",
  "MBT_NETSUITE_SANDBOX_ACCOUNT_ALLOWLIST",
  "MBT_NETSUITE_READ_TIMEOUT_MS",
  "MBT_NETSUITE_PREFLIGHT_LEASE_SECONDS",
  "P2_R7_UNRELATED_PROCESS_ENV"
]);

function snapshotManagedEnvironment() {
  return new Map(MANAGED_ENV_KEYS.map((key) => [key, process.env[key]]));
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
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "mbt-config-seam-"));
  const snapshot = snapshotManagedEnvironment();
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
    for (const [file, contents] of Object.entries(envFiles)) {
      await writeFile(path.join(fixtureRoot, file), contents);
    }

    for (const key of MANAGED_ENV_KEYS) {
      delete process.env[key];
    }
    process.env.MBBS_ENV_FILE = activeEnvFile;
    const configModuleUrl = pathToFileURL(path.join(fixtureRoot, "src/config.js"));
    configModuleUrl.searchParams.set("fixture", path.basename(fixtureRoot));
    const configModule = await import(configModuleUrl.href);
    await operation(configModule);
  } finally {
    restoreManagedEnvironment(snapshot);
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

function mbtEnv({ enabled, writes }) {
  return [
    "DATABASE_URL=postgres://localhost/mbt_test",
    ...(enabled === undefined ? [] : [`MBT_ENABLED=${enabled}`]),
    ...(writes === undefined ? [] : [`MBT_NETSUITE_WRITES_ENABLED=${writes}`]),
    ""
  ].join("\n");
}

test("F01 legacy seam: MBT environment gates default false when absent", async () => {
  await withIsolatedConfig(
    { ".env.initial": mbtEnv({}) },
    ".env.initial",
    async ({ config }) => {
      assert.deepEqual(config.mbt, {
        enabled: false,
        netSuiteWritesEnabled: false
      });
    }
  );
});

test("F01 legacy seam: MBT environment gates parse only explicit truthy values", async () => {
  const cases = [
    ["1", true],
    ["true", true],
    ["TRUE", true],
    ["yes", true],
    ["YeS", true],
    ["on", true],
    ["ON", true],
    ["0", false],
    ["false", false],
    ["no", false],
    ["off", false],
    ["unexpected", false]
  ];

  for (const [value, expected] of cases) {
    await withIsolatedConfig(
      { ".env.initial": mbtEnv({ enabled: value, writes: value }) },
      ".env.initial",
      async ({ config }) => {
        assert.equal(config.mbt.enabled, expected, `MBT_ENABLED=${value}`);
        assert.equal(
          config.mbt.netSuiteWritesEnabled,
          expected,
          `MBT_NETSUITE_WRITES_ENABLED=${value}`
        );
      }
    );
  }
});

test("F01 legacy seam: applyEnvFile replaces the live MBT config without process pollution", async () => {
  await withIsolatedConfig(
    {
      ".env.initial": mbtEnv({ enabled: "false", writes: "false" }),
      ".env.next": mbtEnv({ enabled: "yes", writes: "ON" })
    },
    ".env.initial",
    async (configModule) => {
      const liveConfig = configModule.config;
      const initialMbtConfig = liveConfig.mbt;
      assert.deepEqual(initialMbtConfig, {
        enabled: false,
        netSuiteWritesEnabled: false
      });

      const applied = await configModule.applyEnvFile(".env.next");

      assert.strictEqual(configModule.config, liveConfig);
      assert.notStrictEqual(liveConfig.mbt, initialMbtConfig);
      assert.deepEqual(liveConfig.mbt, {
        enabled: true,
        netSuiteWritesEnabled: true
      });
      assert.equal(configModule.activeEnvFile, ".env.next");
      assert.equal(applied.activeEnvFile, ".env.next");
      assert.equal(
        applied.files.find(({ file }) => file === ".env.next")?.active,
        true
      );
    }
  );
});

test("P2-R7 env replacement clears omitted file-owned NetSuite runtime keys only", async () => {
  const initialRuntime = [
    "DATABASE_URL=postgres://localhost/mbt_test",
    "NETSUITE_ACCOUNT_ID=1234567_SB1",
    "NETSUITE_REST_BASE_URL=https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1",
    "NETSUITE_DIRECT_ACCESS_ENABLED=false",
    "MBT_NETSUITE_SANDBOX_ACCOUNT_ALLOWLIST=1234567_SB1,7654321_SB2",
    "MBT_NETSUITE_READ_TIMEOUT_MS=47000",
    "MBT_NETSUITE_PREFLIGHT_LEASE_SECONDS=333",
    ""
  ].join("\n");
  const replacement = [
    "DATABASE_URL=postgres://localhost/mbt_test",
    "MBT_ENABLED=false",
    ""
  ].join("\n");

  await withIsolatedConfig(
    {
      ".env.initial": initialRuntime,
      ".env.replacement": replacement
    },
    ".env.initial",
    async (configModule) => {
      assert.deepEqual({
        accountId: configModule.config.netsuite.accountId,
        restBaseUrl: configModule.config.netsuite.restBaseUrl,
        directAccessEnabled: configModule.config.netsuite.directAccessEnabled,
        sandboxAccountAllowlist: configModule.config.netsuite.mbtSandboxAccountAllowlist,
        readTimeoutMs: configModule.config.netsuite.mbtReadTimeoutMs,
        preflightLeaseSeconds: configModule.config.netsuite.mbtPreflightLeaseSeconds
      }, {
        accountId: "1234567_SB1",
        restBaseUrl: "https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1",
        directAccessEnabled: false,
        sandboxAccountAllowlist: ["1234567_SB1", "7654321_SB2"],
        readTimeoutMs: 47_000,
        preflightLeaseSeconds: 333
      });

      process.env.P2_R7_UNRELATED_PROCESS_ENV = "keep-process-owned-value";
      await configModule.applyEnvFile(".env.replacement");

      assert.deepEqual({
        processRuntime: {
          accountId: process.env.NETSUITE_ACCOUNT_ID,
          restBaseUrl: process.env.NETSUITE_REST_BASE_URL,
          directAccessEnabled: process.env.NETSUITE_DIRECT_ACCESS_ENABLED,
          sandboxAccountAllowlist: process.env.MBT_NETSUITE_SANDBOX_ACCOUNT_ALLOWLIST,
          readTimeoutMs: process.env.MBT_NETSUITE_READ_TIMEOUT_MS,
          preflightLeaseSeconds: process.env.MBT_NETSUITE_PREFLIGHT_LEASE_SECONDS
        },
        configRuntime: {
          accountId: configModule.config.netsuite.accountId,
          restBaseUrl: configModule.config.netsuite.restBaseUrl,
          directAccessEnabled: configModule.config.netsuite.directAccessEnabled,
          sandboxAccountAllowlist: configModule.config.netsuite.mbtSandboxAccountAllowlist,
          readTimeoutMs: configModule.config.netsuite.mbtReadTimeoutMs,
          preflightLeaseSeconds: configModule.config.netsuite.mbtPreflightLeaseSeconds
        },
        unrelatedProcessValue: process.env.P2_R7_UNRELATED_PROCESS_ENV
      }, {
        processRuntime: {
          accountId: undefined,
          restBaseUrl: undefined,
          directAccessEnabled: undefined,
          sandboxAccountAllowlist: undefined,
          readTimeoutMs: undefined,
          preflightLeaseSeconds: undefined
        },
        configRuntime: {
          accountId: undefined,
          restBaseUrl: undefined,
          directAccessEnabled: true,
          sandboxAccountAllowlist: [],
          readTimeoutMs: 10_000,
          preflightLeaseSeconds: 120
        },
        unrelatedProcessValue: "keep-process-owned-value"
      });
    }
  );
});
