import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

import {
  buildIsolatedTestEnvironment,
  resolveHarnessProfile
} from "./test-foundation.mjs";
import { closeDb, query } from "../../src/db.js";

const BASELINE_OPERATOR_ID = "mbt-baseline-fixture-operator";
const BASELINE_OPERATOR_USERNAME = "mbt_baseline_fixture_operator";

async function seedFullBaselineFixtures() {
  await query("DELETE FROM operator_sessions WHERE operator_id = $1", [BASELINE_OPERATOR_ID]);
  await query("DELETE FROM operators WHERE id = $1 OR username = $2", [
    BASELINE_OPERATOR_ID,
    BASELINE_OPERATOR_USERNAME
  ]);
  await query(
    `INSERT INTO operators (
       id, username, display_name, password_hash, password_salt,
       role, roles, yard_location_ids, active
     ) VALUES (
       $1, $2, 'MBT isolated baseline fixture', 'not-a-login-hash',
       'not-a-login-salt', 'operator', ARRAY['operator']::text[],
       ARRAY[]::integer[], true
     )`,
    [BASELINE_OPERATOR_ID, BASELINE_OPERATOR_USERNAME]
  );
}

async function removeFullBaselineFixtures() {
  await query("DELETE FROM operator_sessions WHERE operator_id = $1", [BASELINE_OPERATOR_ID]);
  await query("DELETE FROM operators WHERE id = $1", [BASELINE_OPERATOR_ID]);
}

const profile = String(process.argv[2] || "smoke");
if (process.env.MBT_TEST_ISOLATED !== "1") {
  throw new Error("Legacy baselines must run inside the isolated MBT test environment.");
}
const databaseUrl = String(process.env.DATABASE_URL || "");
if (!/\/mbt_test(?:[?#]|$)/.test(databaseUrl)) {
  throw new Error("Legacy baselines require the dedicated mbt_test database.");
}

const [manifestSource, packageSource] = await Promise.all([
  readFile(new URL("../baseline-harnesses.json", import.meta.url), "utf8"),
  readFile(new URL("../../package.json", import.meta.url), "utf8")
]);
const manifest = JSON.parse(manifestSource);
const packageJson = JSON.parse(packageSource);
const harnesses = resolveHarnessProfile(manifest, packageJson.scripts || {}, profile);
const environment = buildIsolatedTestEnvironment(process.env, { databaseUrl });

const usesFullFixtures = profile === "full";
try {
  if (usesFullFixtures) {
    await seedFullBaselineFixtures();
  }
  for (const harness of harnesses) {
    console.log(`\n[legacy baseline] ${harness.name}`);
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [harness.file], {
        env: environment,
        stdio: "inherit"
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (signal) {
          reject(new Error(`${harness.name} exited on signal ${signal}.`));
        } else {
          resolve(code ?? 1);
        }
      });
    });
    if (exitCode !== 0) {
      throw new Error(`${harness.name} failed with exit code ${exitCode}.`);
    }
  }
} finally {
  if (usesFullFixtures) {
    await removeFullBaselineFixtures().catch(() => undefined);
  }
  await closeDb();
}

console.log(`\nLegacy ${profile} baseline passed: ${harnesses.length} harnesses.`);
