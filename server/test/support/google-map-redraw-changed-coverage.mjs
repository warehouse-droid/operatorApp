import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const [artifactDirectory] = process.argv.slice(2);
assert.ok(artifactDirectory, "Pass the fresh map-redraw artifact directory");
const files = ["src/google-maps-gateway.js", "public/dispatch.js"];
const diff = fs.readFileSync(path.join(artifactDirectory, "source.diff"), "utf8");
const changed = new Map(files.map((file) => [file, new Set()]));
let current;
for (const line of diff.split("\n")) {
  const fileMatch = /^\+\+\+ b\/server\/(.*)$/u.exec(line);
  if (fileMatch) { current = changed.get(fileMatch[1]); }
  const hunk = /^@@ .* \+(\d+)(?:,(\d+))? @@/u.exec(line);
  if (!current || !hunk) { continue; }
  const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
  for (let index = 0; index < count; index += 1) { current.add(Number(hunk[1]) + index); }
}
const scripts = [];
const rawDirectory = path.join(artifactDirectory, "v8");
for (const file of fs.readdirSync(rawDirectory).filter((name) => name.endsWith(".json"))) {
  const raw = JSON.parse(fs.readFileSync(path.join(rawDirectory, file), "utf8"));
  scripts.push(...(raw.result || []).map((script) => ({ ...script, browser: false })));
}
function passedCoverageAttachments(suite) {
  return (suite.specs || [])
    .flatMap((spec) => spec.tests || [])
    .flatMap((test) => test.results || [])
    .filter((result) => result.status === "passed")
    .flatMap((result) => result.attachments || [])
    .filter((attachment) => attachment.name === "map-v8-coverage");
}
function collectAttachments(suite) {
  for (const child of suite.suites || []) { collectAttachments(child); }
  for (const attachment of passedCoverageAttachments(suite)) {
    const raw = attachment.body ? Buffer.from(attachment.body, "base64").toString("utf8") : fs.readFileSync(attachment.path, "utf8");
    scripts.push({ ...JSON.parse(raw), browser: true });
  }
}
collectAttachments(JSON.parse(fs.readFileSync(path.join(artifactDirectory, "browser-report.json"), "utf8")));

function executed(script, offset, sourceLength) {
  // Ignore vm.compileFunction's padded outer wrapper. Only a genuine function
  // body can prove Node coverage; top-level browser execution covers globals.
  const candidates = script.functions.filter((fn) => {
    const root = fn.ranges[0];
    return root && root.startOffset <= offset && root.endOffset > offset
      && (script.browser || !script.url.endsWith("/public/dispatch.js") || fn.functionName || root.endOffset - root.startOffset < sourceLength);
  }).sort((left, right) => (left.ranges[0].endOffset - left.ranges[0].startOffset) - (right.ranges[0].endOffset - right.ranges[0].startOffset));
  const fn = candidates[0];
  if (!fn) { return false; }
  const range = fn.ranges.filter((entry) => entry.startOffset <= offset && entry.endOffset > offset)
    .sort((left, right) => (left.endOffset - left.startOffset) - (right.endOffset - right.startOffset))[0];
  return range?.count > 0;
}

const results = files.map((file) => {
  const source = fs.readFileSync(file, "utf8");
  const candidates = scripts.filter((script) => script.url === `/app/${file}` || script.url === `file:///app/${file}`
    || (script.browser && file === "public/dispatch.js" && new URL(script.url).pathname === "/dispatch.js"));
  assert.ok(candidates.length, `Missing coverage for ${file}`);
  let offset = 0;
  const checked = [];
  for (const [index, line] of source.split("\n").entries()) {
    const text = line.trim();
    if (changed.get(file).has(index + 1) && text && !/^(\/\/|\/\*|\*)/u.test(text) && !/^[\s{}()[\],;]+$/u.test(text)) {
      checked.push({ line: index + 1, covered: candidates.some((script) => executed(script, offset + line.indexOf(text), source.length)) });
    }
    offset += line.length + 1;
  }
  return { file, changedExecutableLines: checked.length, covered: checked.filter((entry) => entry.covered).length, missed: checked.filter((entry) => !entry.covered).map((entry) => entry.line) };
});
process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
assert.ok(results.every((result) => result.missed.length === 0), "Unexecuted changed map lines; inspect the reported locations");
