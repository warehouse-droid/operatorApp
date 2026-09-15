import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const directory = process.argv[2];
assert.ok(directory, "Pass the fresh evidence directory");
const changed = JSON.parse(fs.readFileSync(path.join(directory, "changed-lines.json"), "utf8"));
const scripts = [];
for (const file of fs.readdirSync(path.join(directory, "v8")).filter((name) => name.endsWith(".json"))) {
  scripts.push(...JSON.parse(fs.readFileSync(path.join(directory, "v8", file), "utf8")).result);
}
function passedCoverageAttachments(suite) {
  return (suite.specs || []).flatMap((spec) => spec.tests || [])
    .flatMap((test) => test.results || [])
    .filter((result) => result.status === "passed")
    .flatMap((result) => result.attachments || [])
    .filter((attachment) => attachment.name === "cargo-v8-coverage");
}
function browserCoverage(suite) {
  for (const child of suite.suites || []) { browserCoverage(child); }
  for (const attachment of passedCoverageAttachments(suite)) {
    const raw = attachment.body ? Buffer.from(attachment.body, "base64").toString("utf8") : fs.readFileSync(attachment.path, "utf8");
    scripts.push({ ...JSON.parse(raw), browser: true });
  }
}
browserCoverage(JSON.parse(fs.readFileSync(path.join(directory, "browser-report.json"), "utf8")));
function executed(script, offset, sourceLength) {
  const functions = script.functions.filter((fn) => {
    const root = fn.ranges[0];
    return root && root.startOffset <= offset && root.endOffset > offset
      && (script.browser || fn.functionName || root.endOffset - root.startOffset <= sourceLength);
  }).sort((a, b) => (a.ranges[0].endOffset - a.ranges[0].startOffset) - (b.ranges[0].endOffset - b.ranges[0].startOffset));
  const range = functions[0]?.ranges.filter((entry) => entry.startOffset <= offset && entry.endOffset > offset)
    .sort((a, b) => (a.endOffset - a.startOffset) - (b.endOffset - b.startOffset))[0];
  return range?.count > 0;
}
const results = Object.entries(changed).map(([file, lines]) => {
  const source = fs.readFileSync(file, "utf8");
  const candidates = scripts.filter((script) => script.url === `/app/${file}` || script.url === `file:///app/${file}`
    || (script.browser && file === "public/dispatch.js" && new URL(script.url).pathname === "/dispatch.js"));
  const checked = [];
  let offset = 0;
  for (const [index, line] of source.split("\n").entries()) {
    const trimmed = line.trim();
    if (lines.includes(index + 1) && trimmed && !/^(\/\/|\/\*|\*|import )/u.test(trimmed) && !/^[\s{}()[\],;]+$/u.test(trimmed)) {
      checked.push({ line: index + 1, covered: candidates.some((script) => executed(script, offset + line.indexOf(trimmed), source.length)) });
    }
    offset += line.length + 1;
  }
  return { file, executable: checked.length, covered: checked.filter((entry) => entry.covered).length, missed: checked.filter((entry) => !entry.covered).map((entry) => entry.line) };
});
console.log(JSON.stringify(results, null, 2));
assert.ok(results.every((result) => result.missed.length === 0), "Changed executable lines need coverage");
