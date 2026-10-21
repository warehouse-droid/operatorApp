import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const directory = "test-artifacts/scm-line-order/final";
fs.mkdirSync(`${directory}/v8`, { recursive: true });
const results = [];
function run(name, args, { environment = {}, baseline = false } = {}) {
  const result = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 40 * 1024 * 1024,
    env: { ...process.env, ...environment } });
  const output = `${result.stdout}${result.stderr}`;
  fs.writeFileSync(`${directory}/${name}.log`, output);
  const accepted = baseline ? result.status === 1 && output.includes("Smart SCM must load cache-busted asset scm-smart-exclusions.js?v=20260801-po-only-pauses-v1.") : result.status === 0;
  results.push({ name, exitCode: result.status, accepted, baseline });
  fs.writeFileSync(`${directory}/checks.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results.at(-1)));
  assert.ok(accepted, `${name} failed; see ${directory}/${name}.log`);
}
run("tests", ["tools/scm-line-order-tests.mjs"], { environment: { NODE_V8_COVERAGE: `/app/${directory}/v8` } });
// The isolated real TO function retains its original source offsets. Map only its
// native function ranges; the synthetic whitespace script root must add no hits.
let transferBoundaryMappings = 0;
for (const file of fs.readdirSync(`${directory}/v8`)) {
  if (!file.endsWith(".json")) continue;
  const path = `${directory}/v8/${file}`;
  const data = JSON.parse(fs.readFileSync(path, "utf8"));
  for (const script of data.result || []) {
    if (!script.url.endsWith("/server-transfer-boundary.vm.js")) continue;
    script.functions = script.functions.filter((fn) => fn.functionName === "executeSmartScmTransferProposal");
    assert.equal(script.functions.length, 1, "map only the real transfer execution function");
    assert.ok(script.functions[0].ranges[0].count > 0, "the real transfer execution function ran");
    script.url = "file:///app/src/server.js";
    transferBoundaryMappings++;
  }
  fs.writeFileSync(path, JSON.stringify(data));
}
assert.equal(transferBoundaryMappings, 1);
fs.writeFileSync(`${directory}/transfer-boundary-coverage.json`, JSON.stringify({ mappings: transferBoundaryMappings,
  source: "src/server.js", function: "executeSmartScmTransferProposal", offsetsPreserved: true, syntheticRootExcluded: true }, null, 2));
run("reverse-order", ["tools/scm-line-order-tests.mjs", "--reverse"]);
run("known-baseline", ["--test", "src/smart-scm-blanket-ui-harness.js"], { baseline: true });
run("types", ["node_modules/typescript/bin/tsc", "--allowJs", "--checkJs", "--noEmit", "--skipLibCheck", "--target", "es2022", "--module", "nodenext", "--moduleResolution", "nodenext",
  "tools/scm-line-order-types.d.ts", "public/scm-smart-line-order-core.js", "src/smart-scm-line-order.js"]);
run("lint", ["node_modules/eslint/bin/eslint.js", "--config", "tools/scm-line-order-eslint.config.mjs", "--max-warnings=0",
  "public/scm-smart-line-order-core.js", "public/scm-smart-line-order.js", "src/smart-scm-line-order.js", "src/smart-scm-line-order-repository.js",
  "src/smart-scm-created-po.js", "src/smart-scm-purchase-netsuite.js", "src/transfer-dependency-netsuite.js",
  "test/mbt/unit/smart-scm-line-order.test.js", "test/mbt/integration/smart-scm-line-order.test.js",
  "tools/scm-line-order-check.mjs", "tools/scm-line-order-tests.mjs", "tools/scm-line-order-browser.mjs", "tools/scm-line-order-mutations.mjs", "tools/scm-line-order-report.mjs"]);
run("mutations", ["tools/scm-line-order-mutations.mjs"]);
for (const file of ["src/server.js", "src/smart-scm-planning-repository.js", "src/smart-scm-vendor-repository.js", "public/scm-smart.js", "public/scm-smart-proposals.js", "public/scm-smart-vendor.js"]) run(`syntax-${file.replaceAll("/", "-")}`, ["--check", file]);
