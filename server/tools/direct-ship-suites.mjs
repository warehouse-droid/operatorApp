import path from "node:path";
import { readFile } from "node:fs/promises";
import { buildIsolatedTestEnvironment } from "../test/support/test-foundation.mjs";
import { runNodeTestFilesIsolated } from "../test/support/test-database-isolation.mjs";
const pkg=JSON.parse(await readFile("package.json","utf8"));
let files=[...new Set([
  ...["test:dispatch-po-route-residual","test:scm-dependency-management"].flatMap(key=>pkg.scripts[key].split(" ").filter(part=>/\.(js|mjs)$/.test(part))),
  "test/dispatch/integration/direct-ship-po-planning.test.js",
  "test/dispatch/integration/direct-ship-to-lifecycle.test.js",
  "test/dispatch/property/direct-ship-quantities.test.js",
  "test/dispatch/unit/direct-ship-recorded-projection.test.js",
  "test/dispatch/frontend/direct-ship-quantities.test.js",
  "test/dispatch/integration/dispatch-special-po-lifecycle.test.js",
  "test/mbt/integration/driver-direct-pickup-online-offline.test.js",
  "test/mbt/concurrency/dispatch-completion-races.test.js"
])];
if (process.argv.includes("offline")) {
  process.env.DIRECT_PICKUP_REPRO_MODE="offline";
  files=["test/mbt/integration/driver-direct-pickup-online-offline.test.js"];
}
if (process.argv.includes("random")) {
  let seed=23035925;
  for (let index=files.length-1;index>0;index--) {
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    const other=seed%(index+1);[files[index],files[other]]=[files[other],files[index]];
  }
}
process.exitCode=await runNodeTestFilesIsolated(files.map(file=>path.resolve(file)),{
  environment:buildIsolatedTestEnvironment(process.env,{databaseUrl:process.env.DATABASE_URL}),label:"Direct shipment lifecycle"
});
