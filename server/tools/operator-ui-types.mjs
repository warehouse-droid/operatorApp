import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const baseline = JSON.parse(readFileSync("test/support/operator-ui-types-baseline.json", "utf8"));
const result = spawnSync("node_modules/.bin/tsc", ["--project", "tsconfig.mbt.json", "--noEmit", "--pretty", "false"], { encoding: "utf8" });
if (result.error) {
  throw result.error;
}
const output = `${result.stdout}${result.stderr}`;
writeFileSync("test-artifacts/operator-ui-enhancements/types.log", output);
const diagnostics = output.split("\n").filter((line) => /: error TS\d+:/u.test(line));
const expected = new Set(baseline.diagnostics);
const unexpected = diagnostics.filter((line) => !expected.has(line));
assert.ok(result.status === 0 || diagnostics.length > 0, output);
assert.deepEqual(unexpected, [], `New TypeScript diagnostics:\n${unexpected.join("\n")}`);
console.log(JSON.stringify({ existingDiagnostics: diagnostics.length, newDiagnostics: unexpected.length, typecheckExitCode: result.status }));
