// @ts-check

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { buildIsolatedTestEnvironment } from "./test-foundation.mjs";

const { Client } = pg;
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MIGRATIONS_DIRECTORY = path.join(SERVER_ROOT, "migrations");
const TEMPORARY_DATABASE_PATTERN = /^mbt_upgrade_[a-f0-9]{32}$/;
const ROOT_MIGRATION_PATTERN = /^(\d{3})_[a-z0-9_]+\.sql$/;

/**
 * @typedef {{
 *   databaseName: string,
 *   databaseUrl: string,
 *   adminDatabaseUrl: string
 * }} TemporaryMigrationDatabase
 */

/**
 * @param {string} identifier
 * @returns {string}
 */
function quoteIdentifier(identifier) {
  if (!TEMPORARY_DATABASE_PATTERN.test(identifier)) {
    throw new Error("The migration test database name is not an approved temporary identifier.");
  }
  return `"${identifier}"`;
}

/**
 * @param {string} databaseUrl
 * @param {{temporaryTarget?: boolean}} [options]
 * @returns {URL}
 */
function assertIsolatedDatabaseUrl(databaseUrl, { temporaryTarget = false } = {}) {
  if (process.env.NODE_ENV !== "test" || process.env.MBT_TEST_ISOLATED !== "1") {
    throw new Error("Migration upgrade tests require the isolated test environment.");
  }

  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("Migration upgrade tests require an explicit PostgreSQL URL.");
  }
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)) {
    throw new Error("Migration upgrade tests require PostgreSQL.");
  }
  if (!new Set(["db", "localhost", "127.0.0.1", "::1"]).has(parsed.hostname)) {
    throw new Error("Migration upgrade tests may connect only to an isolated local test host.");
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const validName = temporaryTarget
    ? TEMPORARY_DATABASE_PATTERN.test(databaseName)
    : /^mbt_test(?:_[a-z0-9_]+)?$/.test(databaseName);
  if (!validName) {
    throw new Error("Migration upgrade tests may use only the dedicated MBT test database namespace.");
  }
  return parsed;
}

/**
 * @param {URL} source
 * @param {string} databaseName
 * @returns {string}
 */
function databaseUrlFor(source, databaseName) {
  const target = new URL(source.href);
  target.pathname = `/${databaseName}`;
  target.search = "";
  target.hash = "";
  return target.href;
}

/**
 * @param {{databaseUrl: string}} options
 * @returns {Promise<TemporaryMigrationDatabase>}
 */
export async function createTemporaryMigrationDatabase({ databaseUrl }) {
  const adminUrl = assertIsolatedDatabaseUrl(String(databaseUrl || ""));
  const databaseName = `mbt_upgrade_${randomUUID().replaceAll("-", "")}`;
  const client = new Client({ connectionString: adminUrl.href });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${quoteIdentifier(databaseName)} TEMPLATE template0 ENCODING 'UTF8'`);
  } finally {
    await client.end();
  }
  return {
    databaseName,
    databaseUrl: databaseUrlFor(adminUrl, databaseName),
    adminDatabaseUrl: adminUrl.href
  };
}

/**
 * @returns {Promise<{filename: string, sequence: number}[]>}
 */
async function rootMigrationFiles() {
  const entries = await readdir(MIGRATIONS_DIRECTORY, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const match = ROOT_MIGRATION_PATTERN.exec(entry.name);
      return match ? { filename: entry.name, sequence: Number(match[1]) } : null;
    })
    .filter((entry) => entry !== null)
    .sort((left, right) => left.filename.localeCompare(right.filename));
}

/**
 * @param {import("pg").Client} client
 * @param {{through: number}} options
 * @returns {Promise<string[]>}
 */
export async function applyRootMigrationsThrough(client, { through }) {
  if (!Number.isInteger(through) || through !== 101) {
    throw new Error("The upgrade fixture must stop at the approved pre-MBT migration 101 boundary.");
  }
  const migrations = (await rootMigrationFiles()).filter((migration) => migration.sequence <= through);
  if (
    migrations.length !== 101
    || migrations[0]?.filename !== "001_baseline_current_schema.sql"
    || migrations.at(-1)?.filename !== "101_smart_scm_vendor_reply_destinations.sql"
  ) {
    throw new Error("The root schema-101 migration set is incomplete or ambiguous.");
  }

  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  for (const migration of migrations) {
    const applied = await client.query(
      "SELECT 1 FROM schema_migrations WHERE filename = $1",
      [migration.filename]
    );
    if (applied.rowCount) {
      continue;
    }
    const sql = await readFile(path.join(MIGRATIONS_DIRECTORY, migration.filename), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (filename) VALUES ($1)",
        [migration.filename]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }
  return migrations.map((migration) => migration.filename);
}

/**
 * @param {{databaseUrl: string}} options
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string}>}
 */
export async function runOfficialMigrationRunner({ databaseUrl }) {
  const targetUrl = assertIsolatedDatabaseUrl(String(databaseUrl || ""), { temporaryTarget: true });
  const environment = buildIsolatedTestEnvironment(process.env, { databaseUrl: targetUrl.href });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["src/migrate.js"], {
      cwd: SERVER_ROOT,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`The official migration runner exited on signal ${signal}.`));
        return;
      }
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * @param {TemporaryMigrationDatabase} temporaryDatabase
 * @returns {Promise<void>}
 */
export async function dropTemporaryMigrationDatabase(temporaryDatabase) {
  if (
    !temporaryDatabase
    || typeof temporaryDatabase !== "object"
    || !TEMPORARY_DATABASE_PATTERN.test(String(temporaryDatabase.databaseName || ""))
  ) {
    throw new Error("Refusing to drop a database without an explicit migration-test identifier.");
  }
  const adminUrl = assertIsolatedDatabaseUrl(String(temporaryDatabase.adminDatabaseUrl || ""));
  const databaseName = String(temporaryDatabase.databaseName);
  const client = new Client({ connectionString: adminUrl.href });
  await client.connect();
  try {
    await client.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1
          AND pid <> pg_backend_pid()`,
      [databaseName]
    );
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
  } finally {
    await client.end();
  }
}
