import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";

const directory = "test-artifacts/scm-line-order/final";
const manifest = JSON.parse(fs.readFileSync(`${directory}/task-diff.json`, "utf8"));
const production = Object.keys(manifest);
const coverage = JSON.parse(fs.readFileSync(`${directory}/coverage/coverage-final.json`, "utf8"));
const results = [];
for (const file of production) {
  const entry = coverage[`/app/${file}`];
  const text = fs.readFileSync(file, "utf8");
  assert.equal(createHash("sha256").update(text).digest("hex"), manifest[file].sha256, `task diff matches ${file}`);
  const changed = manifest[file].lines;
  const hits = new Map();
  if (entry) for (const [id, location] of Object.entries(entry.statementMap)) {
    for (let line = location.start.line; line <= location.end.line; line++) hits.set(line, Math.max(hits.get(line) || 0, entry.s[id]));
  }
  const measured = changed.filter((line) => hits.has(line));
  const missing = measured.filter((line) => hits.get(line) === 0);
  results.push({ file, changed: changed.length, measured: measured.length, covered: measured.length - missing.length, missing,
    sha256: createHash("sha256").update(text).digest("hex") });
}
const sourceHash = createHash("sha256").update(JSON.stringify(results.map(({ file, sha256 }) => ({ file, sha256 })))).digest("hex");
fs.writeFileSync(`${directory}/source-coverage.json`, JSON.stringify({ sourceHash, results }, null, 2));
const testLog = fs.readFileSync(`${directory}/tests.log`, "utf8");
const nodeTests = [...testLog.matchAll(/(?:# |ℹ )tests (\d+)/g)].reduce((sum, match) => sum + Number(match[1]), 0);
const nodePassed = [...testLog.matchAll(/(?:# |ℹ )pass (\d+)/g)].reduce((sum, match) => sum + Number(match[1]), 0);
const nodeFailed = [...testLog.matchAll(/(?:# |ℹ )fail (\d+)/g)].reduce((sum, match) => sum + Number(match[1]), 0);
const browser = JSON.parse(fs.readFileSync(`${directory}/browser.log`, "utf8").trim().split("\n").at(-1));
const totals = { nodeTests, nodePassed, nodeFailed, browserChecks: browser.passed,
  measured: results.reduce((sum, row) => sum + row.measured, 0), covered: results.reduce((sum, row) => sum + row.covered, 0), sourceHash };
fs.writeFileSync(`${directory}/summary.json`, JSON.stringify(totals, null, 2));
assert.equal(nodeTests, nodePassed);
assert.equal(nodeFailed, 0);
assert.equal(browser.passed, 8);
assert.equal(browser.browserErrors, 0);
assert.equal(totals.covered, totals.measured, "every changed measured line must execute");
assert.ok(results.filter((row) => row.file.endsWith(".js")).every((row) => row.measured > 0), "all changed JavaScript files have coverage");
const secretPatterns = [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /AKIA[0-9A-Z]{16}/, /sk-proj-[A-Za-z0-9_-]{20,}/];
for (const file of production) {
  const text = manifest[file].additions;
  assert.ok(secretPatterns.every((pattern) => !pattern.test(text)), `no secrets added to ${file}`);
}
console.log(JSON.stringify(totals));
console.log(JSON.stringify(results.filter((row) => row.missing.length || !row.measured)));
