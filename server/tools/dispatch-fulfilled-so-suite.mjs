import { readdir } from "node:fs/promises";
import path from "node:path";
import { buildIsolatedTestEnvironment } from "../test/support/test-foundation.mjs";
import { runNodeTestFilesIsolated } from "../test/support/test-database-isolation.mjs";

async function collect(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { result.push(...await collect(file)); }
    else if (/\.test\.(?:js|mjs)$/u.test(entry.name)) { result.push(file); }
  }
  return result;
}
const files = [];
for (const group of ["unit", "integration", "property", "adversarial", "concurrency"]) {
  files.push(...await collect(path.resolve("test/dispatch", group)));
}
files.sort();
console.log(JSON.stringify({ files: files.length }));
process.exitCode = await runNodeTestFilesIsolated(files, {
  environment: buildIsolatedTestEnvironment(process.env, { databaseUrl: process.env.DATABASE_URL }),
  label: "Fulfilled SO Dispatch regression"
});
