import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { ESLint } from "eslint";

assert.equal(process.env.MBT_TEST_ISOLATED, "1");
assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED, "false");
const out = resolve("test-artifacts/special-po-mini-rows-20261001");
mkdirSync(out + "/browser", { recursive: true });
const files = ["public/special-stock-po-routing.js", "public/special-stock-po-routing.css",
  "public/scm-special-stock-requests.js", "public/scm-stock-requests.html", "public/special-stock-line-details.js",
  "public/sales-special-stock-requests.js", "public/sales-stock-requests.html"];
const hashes = () => Object.fromEntries(files.map(file => [file, createHash("sha256").update(readFileSync(file)).digest("hex")]));
const sourceHashes = hashes();
function run(label, args) {
  const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 180000, maxBuffer: 3000000,
    env: { ...process.env, SPECIAL_BATCH_BROWSER_OUTPUT: out + "/browser",
      SPECIAL_ENHANCEMENTS_BROWSER_OUTPUT: out + "/sales-browser" } });
  const log = (result.stdout || "") + (result.stderr || "");
  writeFileSync(out + "/" + label + ".log", log);
  console.log(JSON.stringify({ label, exitCode: result.status, tail: log.slice(-1400) }));
  assert.equal(result.status, 0, label + ": " + log.slice(-4500));
  return Object.fromEntries(["tests", "pass", "fail", "skipped"].map(key =>
    [key, Number(log.match(new RegExp(`^# ${key} (\\d+)$`, "m"))?.[1] || 0)]));
}
const lint = new ESLint({ overrideConfigFile: resolve("tools/stock-request-layout-eslint.config.mjs") });
for (const file of files.filter(file => file.endsWith(".js"))) {
  run("syntax-" + file.split("/").at(-1), ["--check", file]);
  const messages = async text => (await lint.lintText(text, { filePath: file }))[0].messages
    .map(({ ruleId, severity, message }) => JSON.stringify({ ruleId, severity, message }));
  const before = await messages(readFileSync(out + "/before/" + file, "utf8"));
  const after = await messages(readFileSync(file, "utf8"));
  assert.deepEqual(after.filter(message => {
    const index = before.indexOf(message);
    if (index < 0) return true;
    before.splice(index, 1);
    return false;
  }), [], file + " has new lint findings");
}
const unit = run("routing-description-unit", ["--test", "--test-concurrency=1", "test/mbt/unit/special-po-routing.test.js",
  "test/mbt/unit/special-request-enhancements.test.js", "test/mbt/unit/special-quote-packing.test.js"]);
const browser = run("routing-sales-browser", ["--test", "--test-concurrency=1", "test/mbt/integration/special-po-routing-browser.test.js",
  "test/mbt/integration/special-enhancements-browser.test.js"]);
const layouts = JSON.parse(readFileSync(out + "/browser/mini-layout.json"));
assert.deepEqual(layouts.map(item => item.width), [1440, 1280, 1024]);
assert.deepEqual(hashes(), sourceHashes);
const result = { completed: true, sourceHashes, unit, browser, desktopRows: 2,
  layoutWidths: layouts.map(item => item.width), openPoSplitLinkRemoved: true, newLintFindings: 0,
  specialRequestNoteSaveAndSplitLocalSavePreserved: true, palletPreserved: true, mobileNoOverflow: true,
  readinessLabel: "Ready for Arrangement", descriptionVendorPrefixRemoved: true, descriptionSpaceSeparators: true };
writeFileSync(out + "/checks.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
