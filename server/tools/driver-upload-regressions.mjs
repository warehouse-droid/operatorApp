import fs from "node:fs";
import path from "node:path";
import {buildIsolatedTestEnvironment} from "../test/support/test-foundation.mjs";
import {runNodeTestFilesIsolated} from "../test/support/test-database-isolation.mjs";

const files = [];
for (const group of ["unit", "property", "integration", "adversarial", "concurrency"]) {
  const directory = `test/mbt/${group}`;
  for (const name of fs.readdirSync(directory).sort()) {
    if (/^driver.*\.test\.(?:js|mjs)$/u.test(name) && !name.startsWith("driver-upload-")) files.push(path.join(directory, name));
  }
}
const environment = buildIsolatedTestEnvironment(process.env, {databaseUrl: process.env.DATABASE_URL});
process.exitCode = await runNodeTestFilesIsolated(files, {environment, label: "Driver PWA regressions"});
