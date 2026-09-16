import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

assert.equal(process.env.MBT_TEST_ISOLATED, "1");
const tests = JSON.parse(readFileSync("test/operator-receiving-identity-focused-tests.json", "utf8"));
const results = [];
let output = "";
// Node sorts a multi-file --test argument list. Separate invocations enforce
// the intended order while retaining the same fresh database between files.
for (const file of tests.toReversed()) {
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", file],
    { encoding: "utf8", maxBuffer: 45e6 });
  if (result.error) { throw result.error; }
  output += `\n[reversed] ${file}\n${result.stdout}${result.stderr}`;
  results.push({ file, exitCode: result.status });
}
writeFileSync("test-artifacts/operator-receiving-identity/reversed.log", output);
writeFileSync("test-artifacts/operator-receiving-identity/reversed.json", JSON.stringify({
  passed: results.every(result => result.exitCode === 0), freshDatabase: true, results,
  runnerSha256: createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex")
}, null, 2));
assert.ok(results.every(result => result.exitCode === 0), "Reversed suite failed; see reversed.log");
console.log("Reversed receiving checks passed in a fresh database.");
