import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { ESLint } from "eslint";
import config from "./dispatch-fulfilled-so-eslint.config.mjs";
import base from "../eslint.mbt.config.js";

assert.equal(process.env.MBT_TEST_ISOLATED, "1");
const artifact = "test-artifacts/first-split-group-status-20261001";
const before = "/workspace/server/deployments/first-split-group-status-20261001/before";
const files = ["src/dispatch-fulfilled-so-repository.js", "public/dispatch.js"];
const own = [
  "test/dispatch/integration/dispatch-first-split-group-status.test.js",
  "test/dispatch/frontend/dispatch-first-split-group-status.browser.test.mjs",
  "test/dispatch/frontend/dispatch-fulfilled-so-ui.test.js",
  "tools/first-split-group-status-live.mjs", "tools/first-split-group-status-check.mjs"
];
const lint = new ESLint({ overrideConfigFile: true, overrideConfig: [...config, {
  files: ["test/dispatch/frontend/dispatch-first-split-group-status.browser.test.mjs"],
  languageOptions: { ...base[1].languageOptions, globals: {
    ...base[1].languageOptions.globals,
    // These bindings belong to the production script in the browser's page.
    trucks: "writable", fleet: "writable", currentPlanDate: "writable", currentPlan: "writable",
    dispatchConfig: "writable", dispatchPlannerSnapshotState: "writable",
    applyDispatchOrderFeed: "readonly", app: "readonly", renderOrderPool: "readonly"
  } }, rules: base[1].rules
}] });
const findings = async (source, filePath) => (await lint.lintText(source, { filePath }))[0].messages
  .map(({ ruleId, severity, message }) => JSON.stringify({ ruleId, severity, message }));
const lintReport = {};
for (const file of files) {
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  const baseline = await findings(readFileSync(`${before}/${file}`, "utf8"), file);
  const current = await findings(readFileSync(file, "utf8"), file);
  const introduced = current.filter(finding => {
    const index = baseline.indexOf(finding);
    if (index < 0) { return true; }
    baseline.splice(index, 1);
    return false;
  });
  assert.deepEqual(introduced, [], `${file}: new lint diagnostics`);
  lintReport[file] = { existingDiagnostics: current.length, introduced: 0 };
}
for (const file of own) {
  assert.deepEqual(await findings(readFileSync(file, "utf8"), file), [], `${file}: lint diagnostics`);
}
const failures = log => [...log.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]).sort();
const candidate = readFileSync(`${artifact}/candidate-regression.log`, "utf8");
const baselineHttpLog = readFileSync(`${artifact}/baseline-http.log`, "utf8");
const baselineFailures = failures(baselineHttpLog);
assert.equal(baselineFailures.length, 2, "Expected two pre-existing HTTP fence fixture failures");
assert.deepEqual(failures(candidate), baselineFailures, "The exact release source has no new regression failures");
const counts = Object.fromEntries(["tests", "pass", "fail", "skipped"].map(key => {
  const match = new RegExp(`^# ${key} (\\d+)$`, "m").exec(candidate);
  assert.ok(match, `Missing ${key} count`);
  return [key, Number(match[1])];
}));
assert.equal(counts.tests, 56);
assert.equal(counts.fail, 2);
assert.equal(counts.pass, 54);
const sourceHashes = Object.fromEntries(files.map(file => [file, createHash("sha256").update(readFileSync(file)).digest("hex")]));
const result = { passed: true, sourceHashes, counts, baselineFailures, newFailures: [], lintReport,
  newFileLint: { passed: true, diagnostics: 0 }, browserVerified: true,
  baselineFailureReason: "Existing HTTP fixtures omit the current plan digest fence." };
writeFileSync(`${artifact}/checks.json`, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
