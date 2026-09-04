// @ts-check

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const serverRoot = fileURLToPath(new URL("../..", import.meta.url));
const target = "test/dispatch/integration/dispatch-v2-command-flow.red.test.js";
const knownFailure = "history search reveals reconciliation-complete PO/SO orders but never Driver PWA-completed orders";

const baseline = spawnSync(process.execPath, [
  "--test",
  "--test-concurrency=1",
  target
], {
  cwd: serverRoot,
  env: process.env,
  encoding: "utf8",
  timeout: 240_000
});
if (baseline.error) {
  throw baseline.error;
}
const output = `${baseline.stdout || ""}\n${baseline.stderr || ""}`;
assert.equal(baseline.status, 1, "The recorded history-search baseline unexpectedly changed status.");
assert.match(output, new RegExp(`not ok \\d+ - ${knownFailure.replaceAll("/", "\\/")}`));
assert.match(output, /Current Dispatch order visibility must remain unchanged outside History Edit Mode\./u);
assert.match(output, /true !== false/u);
assert.match(output, /# pass 11/u);
assert.match(output, /# fail 1/u);
assert.doesNotMatch(output, /# fail [2-9]/u);

console.log(
  "Dispatch V2 command-flow baseline held: 11 non-baseline tests passed; "
  + "the one pre-existing history-visibility failure reproduced unchanged."
);
