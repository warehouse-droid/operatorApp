import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildIsolatedTestEnvironment } from "../test/support/test-foundation.mjs";
import { runNodeTestFilesIsolated } from "../test/support/test-database-isolation.mjs";

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const name = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(name) : /test\.(?:js|mjs)$/u.test(name) ? [name] : [];
  });
}

const regression = "test/dispatch/unit/dispatch-po-line-destinations.test.js";
const files = filesUnder("test/dispatch").filter(name => name !== regression);
files.push("test/mbt/unit/driver-live-route-prefix-lock.red.test.js",
  "test/mbt/integration/driver-live-route-prefix-lock.integration.test.js",
  "test/mbt/concurrency/driver-live-route-prefix-lock.concurrency.test.js");
let seed = 1401728;
for (let index = files.length - 1; index > 0; index -= 1) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const chosen = seed % (index + 1); [files[index], files[chosen]] = [files[chosen], files[index]];
}
let output = "";
const original = process.stdout.write.bind(process.stdout);
process.stdout.write = chunk => { output += String(chunk); return true; };
let status;
try {status = await runNodeTestFilesIsolated([regression, ...files].map(name => path.resolve(name)), {
  environment: buildIsolatedTestEnvironment(process.env, { databaseUrl: process.env.DATABASE_URL }), label: "current-parallel"
});} finally {process.stdout.write = original;}
const artifact = "test-artifacts/dispatch-po-line-destinations";
mkdirSync(artifact, { recursive: true });
const count = key => [...output.matchAll(new RegExp(`^ℹ ${key} (\\d+)$`, "gmu"))].reduce((total, match) => total + Number(match[1]), 0);
const failures = [...new Set([...output.matchAll(/^✖ (.+) \([\d.]+ms\)$/gmu)].map(match => match[1]))].sort();
const report = { status, tests: count("tests"), passed: count("pass"), failed: count("fail"), failures };
assert.equal(status === 0, failures.length === 0);
writeFileSync(path.join(artifact, "current-parallel.log"), output);
writeFileSync(path.join(artifact, "current-parallel.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
