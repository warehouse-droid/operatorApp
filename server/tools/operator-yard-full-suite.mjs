import { readdir } from "node:fs/promises";
import path from "node:path";
import { buildIsolatedTestEnvironment } from "../test/support/test-foundation.mjs";
import { runNodeTestFilesIsolated } from "../test/support/test-database-isolation.mjs";

async function collect(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {result.push(...await collect(file));}
    else if (/\.test\.(?:js|mjs)$/.test(entry.name)) {result.push(file);}
  }
  return result;
}

let seed = 20260915;
const files = [];
for (const group of ["infrastructure", "unit", "contracts", "property", "integration", "adversarial", "concurrency"]) {
  files.push(...await collect(path.resolve("test/mbt", group)));
}
files.sort();
for (let index = files.length - 1; index > 0; index -= 1) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const selected = seed % (index + 1);
  [files[index], files[selected]] = [files[selected], files[index]];
}
const environment = buildIsolatedTestEnvironment(process.env, { databaseUrl: process.env.DATABASE_URL });
console.log(JSON.stringify({ orderSeed: 20260915, files: files.length }));
process.exitCode = await runNodeTestFilesIsolated(files, { environment, label: "Operator yard randomized regression" });
