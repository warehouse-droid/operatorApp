// @ts-check

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";

const { Client } = pg;
const BASE_DATABASE_NAME = "mbt_test";
const CLONE_DATABASE_PATTERN = /^mbt_test_file_[a-f0-9]{12}_[a-z0-9]+$/u;
const MAX_CLONE_ATTEMPTS = 5;

/**
 * @param {string} databaseUrl
 * @returns {URL}
 */
function parseDisposableDatabaseUrl(databaseUrl) {
  let parsed;
  try {
    parsed = new URL(String(databaseUrl || ""));
  } catch {
    throw new Error("Test-file isolation requires the isolated disposable mbt_test database.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)
      || parsed.hostname !== "db"
      || decodeURIComponent(parsed.username) !== "mbt_test"
      || databaseName !== BASE_DATABASE_NAME) {
    throw new Error("Test-file isolation requires the isolated disposable mbt_test database.");
  }
  return parsed;
}

/**
 * @param {string} databaseUrl
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [environment]
 * @returns {{baseDatabaseName: string, adminUrl: string}}
 */
export function describeIsolatedTestDatabase(databaseUrl, environment = process.env) {
  if (environment.MBT_TEST_ISOLATED !== "1") {
    throw new Error("Test-file isolation requires the isolated disposable mbt_test database.");
  }
  const parsed = parseDisposableDatabaseUrl(databaseUrl);
  const admin = new URL(parsed.href);
  admin.pathname = "/postgres";
  return {
    baseDatabaseName: BASE_DATABASE_NAME,
    adminUrl: admin.href
  };
}

/**
 * @param {string} runId
 * @param {number} index
 * @returns {string}
 */
export function isolatedTestDatabaseName(runId, index) {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error("The isolated database index must be a non-negative safe integer.");
  }
  const digest = createHash("sha256").update(String(runId || ""), "utf8").digest("hex").slice(0, 12);
  const databaseName = `mbt_test_file_${digest}_${index.toString(36)}`;
  if (!CLONE_DATABASE_PATTERN.test(databaseName) || databaseName.length > 63) {
    throw new Error("Unable to derive an approved isolated clone database name.");
  }
  return databaseName;
}

/**
 * @param {string} databaseUrl
 * @param {string} databaseName
 * @returns {string}
 */
export function isolatedTestDatabaseUrl(databaseUrl, databaseName) {
  const parsed = parseDisposableDatabaseUrl(databaseUrl);
  if (!CLONE_DATABASE_PATTERN.test(databaseName) || databaseName.length > 63) {
    throw new Error("The isolated clone database name is invalid.");
  }
  parsed.pathname = `/${databaseName}`;
  return parsed.href;
}

/** @param {string} databaseName @returns {string} */
function quoteCloneDatabase(databaseName) {
  if (!CLONE_DATABASE_PATTERN.test(databaseName)) {
    throw new Error("Refusing to operate on a non-isolated clone database.");
  }
  return `"${databaseName}"`;
}

/** @returns {string} */
function quoteBaseDatabase() {
  return `"${BASE_DATABASE_NAME}"`;
}

/** @param {unknown} error @param {string} code @returns {boolean} */
function hasDatabaseErrorCode(error, code) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

/**
 * @param {import("pg").Client} client
 * @param {string} databaseName
 */
async function dropCloneDatabase(client, databaseName) {
  await client.query(`DROP DATABASE IF EXISTS ${quoteCloneDatabase(databaseName)} WITH (FORCE)`);
}

/**
 * @param {import("pg").Client} client
 * @param {string} databaseName
 */
async function createCloneDatabase(client, databaseName) {
  await dropCloneDatabase(client, databaseName);
  for (let attempt = 1; attempt <= MAX_CLONE_ATTEMPTS; attempt += 1) {
    await client.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [BASE_DATABASE_NAME]
    );
    try {
      await client.query(
        `CREATE DATABASE ${quoteCloneDatabase(databaseName)} TEMPLATE ${quoteBaseDatabase()}`
      );
      return;
    } catch (error) {
      if (!hasDatabaseErrorCode(error, "55006") || attempt === MAX_CLONE_ATTEMPTS) {
        throw error;
      }
      await delay(attempt * 25);
    }
  }
  throw new Error("Unable to clone the isolated MBT test database.");
}

/**
 * @param {string} file
 * @param {NodeJS.ProcessEnv} environment
 * @returns {Promise<{exitCode: number, testCount: number}>}
 */
function runNodeTestFile(file, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--test",
      "--test-concurrency=1",
      "--test-reporter=spec",
      file
    ], {
      env: environment,
      stdio: ["inherit", "pipe", "inherit"]
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        process.stderr.write(`Isolated test file ${file} exited on signal ${signal}.\n`);
      }
      const counts = [...stdout.matchAll(/^ℹ tests (\d+)$/gmu)];
      const testCount = Number(counts.at(-1)?.[1] || 0);
      resolve({ exitCode: signal ? 1 : (code ?? 1), testCount });
    });
  });
}

/**
 * @param {string[]} files
 * @param {{environment?: NodeJS.ProcessEnv, label?: string}} [options]
 * @returns {Promise<number>}
 */
export async function runNodeTestFilesIsolated(files, {
  environment = process.env,
  label = "MBT"
} = {}) {
  if (!Array.isArray(files) || files.length === 0
      || files.some((file) => typeof file !== "string" || !file.trim())
      || new Set(files).size !== files.length) {
    throw new Error("Isolated Node execution requires a nonempty unique test-file list.");
  }
  const databaseUrl = String(environment.DATABASE_URL || "");
  const boundary = describeIsolatedTestDatabase(databaseUrl, environment);
  const runId = `${process.pid}-${randomBytes(12).toString("hex")}`;
  const admin = new Client({ connectionString: boundary.adminUrl });
  /** @type {string[]} */
  const failedFiles = [];
  let totalTests = 0;
  await admin.connect();
  try {
    for (const [index, file] of files.entries()) {
      const databaseName = isolatedTestDatabaseName(runId, index);
      process.stdout.write(`\n[isolation] ${label} ${index + 1}/${files.length} ${file}\n`);
      await createCloneDatabase(admin, databaseName);
      try {
        const result = await runNodeTestFile(file, {
          ...environment,
          DATABASE_URL: isolatedTestDatabaseUrl(databaseUrl, databaseName)
        });
        totalTests += result.testCount;
        if (result.exitCode !== 0) {
          failedFiles.push(file);
        }
      } finally {
        await dropCloneDatabase(admin, databaseName);
      }
    }
  } finally {
    await admin.end();
  }
  if (failedFiles.length > 0) {
    process.stderr.write(`Isolated ${label} run failed in ${failedFiles.length}/${files.length} file(s): ${failedFiles.join(", ")}\n`);
    return 1;
  }
  process.stdout.write(`Isolated ${label} run passed: ${files.length} file(s), ${totalTests} test(s).\n`);
  return 0;
}
