import { readdir } from "node:fs/promises";
import path from "node:path";

import { buildIsolatedTestEnvironment } from "./test-foundation.mjs";
import { runNodeTestFilesIsolated } from "./test-database-isolation.mjs";

const ALLOWED_GROUPS = new Set(["unit", "property", "adversarial", "frontend", "integration", "concurrency"]);

async function testFiles(directory) {
  const found = [];
  async function visit(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        return;
      }
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
      } else if (/\.test\.(?:js|mjs)$/u.test(entry.name)) {
        found.push(target);
      }
    }
  }
  await visit(directory);
  return found;
}

const groups = process.argv.slice(2);
if (!groups.length || groups.some((group) => !ALLOWED_GROUPS.has(group))) {
  throw new Error(`Specify Dispatch test groups from: ${[...ALLOWED_GROUPS].join(", ")}.`);
}
if (process.env.MBT_TEST_ISOLATED !== "1" || !/\/mbt_test(?:[?#]|$)/u.test(String(process.env.DATABASE_URL || ""))) {
  throw new Error("Dispatch performance tests require the isolated disposable mbt_test database.");
}

const files = [];
for (const group of [...new Set(groups)]) {
  files.push(...await testFiles(path.resolve("test/dispatch", group)));
}
if (!files.length) {
  throw new Error("No Dispatch performance tests matched the selected groups.");
}

const environment = buildIsolatedTestEnvironment(process.env, { databaseUrl: process.env.DATABASE_URL });
process.exitCode = await runNodeTestFilesIsolated(files, {
  environment,
  label: "Dispatch performance"
});
