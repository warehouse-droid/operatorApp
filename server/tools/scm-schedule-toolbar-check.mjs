import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { ESLint } from "eslint";

assert.equal(process.env.MBT_TEST_ISOLATED, "1");
assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED, "false");
const out = resolve("test-artifacts/scm-schedule-toolbar-20261001");
const files = ["public/scm-schedule.js", "public/dispatch.css", "public/scm-schedule.html"];
const hashes = () => Object.fromEntries(files.map(file => [file, createHash("sha256").update(readFileSync(file)).digest("hex")]));
const sourceHashes = hashes();
function run(label, args) {
  const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 180000, maxBuffer: 2000000,
    env: { ...process.env, SCHEDULE_SCREENSHOT_DIR: out + "/browser" } });
  const log = (result.stdout || "") + (result.stderr || "");
  writeFileSync(out + "/" + label + ".log", log);
  console.log(JSON.stringify({ label, exitCode: result.status, tail: log.slice(-1400) }));
  assert.equal(result.status, 0, label + ": " + log.slice(-4000));
  return Object.fromEntries(["tests", "pass", "fail", "skipped"].map(key =>
    [key, Number(log.match(new RegExp(`^# ${key} (\\d+)$`, "m"))?.[1] || 0)]));
}
run("syntax", ["--check", "public/scm-schedule.js"]);
const lint = new ESLint({ overrideConfigFile: resolve("tools/stock-request-layout-eslint.config.mjs") });
const messages = async text => (await lint.lintText(text, { filePath: "public/scm-schedule.js" }))[0].messages
  .map(({ ruleId, severity, message }) => JSON.stringify({ ruleId, severity, message }));
const before = await messages(readFileSync(out + "/before/public/scm-schedule.js", "utf8"));
const after = await messages(readFileSync("public/scm-schedule.js", "utf8"));
assert.deepEqual(after.filter(message => {
  const index = before.indexOf(message);
  if (index < 0) return true;
  before.splice(index, 1);
  return false;
}), [], "New lint findings");
const unit = run("schedule-unit", ["--test", "--test-concurrency=1", "test/dispatch/frontend/scm-schedule-multi-sort.test.js",
  "test/dispatch/frontend/scm-schedule-column-preferences.test.js", "test/dispatch/frontend/scm-schedule-status-save.test.js"]);
const browser = run("schedule-browser", ["--test", "--test-concurrency=1", "test/dispatch/frontend/scm-schedule-columns.browser.test.mjs"]);
run("toolbar-preview", ["tools/scm-schedule-toolbar-preview.mjs"]);
const layout = JSON.parse(readFileSync(out + "/layout.json"));
assert.deepEqual(layout.errors, []);
assert.equal(layout.results.length, 3);
assert.deepEqual(hashes(), sourceHashes);
const result = { completed: true, sourceHashes, unit, browser, toolbarWidths: layout.results.map(item => item.width),
  oneRow: true, allControlsFit: true, columnsMenuUsable: true, summaryRemoved: true, newLintFindings: 0 };
writeFileSync(out + "/checks.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
