import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildIsolatedTestEnvironment } from "../test/support/test-foundation.mjs";
import { runNodeTestFilesIsolated } from "../test/support/test-database-isolation.mjs";

const files = [];
const standalone = path.resolve("test/dispatch/integration/dispatch-retired-confirm-repair.test.js");
for (const group of ["unit", "integration", "property", "adversarial", "concurrency", "frontend"]) {
  for (const entry of await readdir(path.join("test/dispatch", group))) {
    const file = path.resolve("test/dispatch", group, entry);
    if (entry.endsWith(".test.js") && file !== standalone) {files.push(file);}
  }
}
files.sort();
console.log(JSON.stringify({ files: files.length }));
process.exitCode = await runNodeTestFilesIsolated(files, {
  environment: buildIsolatedTestEnvironment(process.env, { databaseUrl: process.env.DATABASE_URL }),
  label: "Split address Dispatch regression"
});
// This existing concurrency fixture requires the exact disposable mbt_test name.
const direct = spawnSync(process.execPath, ["--test", standalone], { stdio: "inherit" });
if (direct.status !== 0) {process.exitCode = direct.status || 1;}
