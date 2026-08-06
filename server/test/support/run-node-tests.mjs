import { readdir } from "node:fs/promises";
import path from "node:path";

import { buildIsolatedTestEnvironment } from "./test-foundation.mjs";
import { runNodeTestFilesIsolated } from "./test-database-isolation.mjs";

const ALLOWED_GROUPS = new Set([
  "infrastructure",
  "unit",
  "contracts",
  "property",
  "integration",
  "adversarial",
  "concurrency"
]);

/**
 * @param {string} directory
 * @returns {Promise<string[]>}
 */
async function testFiles(directory) {
  /** @type {string[]} */
  const found = [];
  /** @param {string} current */
  async function visit(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
      } else if (/\.test\.(?:js|mjs)$/.test(entry.name)) {
        found.push(target);
      }
    }
  }
  await visit(directory);
  return found;
}

const groups = process.argv.slice(2);
if (groups.length === 0) {
  throw new Error("Specify at least one MBT test group.");
}
for (const group of groups) {
  if (!ALLOWED_GROUPS.has(group)) {
    throw new Error(`Unknown MBT test group: ${group}.`);
  }
}
if (process.env.MBT_TEST_ISOLATED !== "1") {
  throw new Error("MBT tests must run inside the isolated test environment.");
}
const databaseUrl = String(process.env.DATABASE_URL || "");
if (!/\/mbt_test(?:[?#]|$)/.test(databaseUrl)) {
  throw new Error("MBT tests require the dedicated mbt_test database.");
}

const files = [];
for (const group of [...new Set(groups)]) {
  const matches = await testFiles(path.resolve("test/mbt", group));
  if (matches.length === 0) {
    console.log(`SKIP ${group}: no test files declared.`);
  }
  files.push(...matches);
}
if (files.length === 0) {
  throw new Error("No MBT tests matched the requested groups.");
}

const environment = buildIsolatedTestEnvironment(process.env, { databaseUrl });
const exitCode = await runNodeTestFilesIsolated(files, { environment, label: "MBT main" });
process.exitCode = exitCode;
