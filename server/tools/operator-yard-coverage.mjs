import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const directory = "test-artifacts/operator-yard-access";
const changed = JSON.parse(readFileSync(`${directory}/changed-lines.json`, "utf8"));
const scripts = readdirSync(`${directory}/coverage-tmp`).filter((name) => name.endsWith(".json"))
  .flatMap((name) => JSON.parse(readFileSync(`${directory}/coverage-tmp/${name}`, "utf8")).result || []);

function executed(script, offset) {
  const containing = script.functions.filter((fn) => fn.ranges[0]?.startOffset <= offset && fn.ranges[0]?.endOffset > offset)
    .sort((a, b) => (a.ranges[0].endOffset - a.ranges[0].startOffset) - (b.ranges[0].endOffset - b.ranges[0].startOffset));
  const range = containing[0]?.ranges.filter((entry) => entry.startOffset <= offset && entry.endOffset > offset)
    .sort((a, b) => (a.endOffset - a.startOffset) - (b.endOffset - b.startOffset))[0];
  return range?.count > 0;
}

const report = Object.entries(changed).map(([file, lines]) => {
  const source = readFileSync(file, "utf8");
  const candidates = scripts.filter((script) => script.url === `file:///app/${file}` || script.url === `/app/${file}`);
  const checked = [];
  let offset = 0;
  for (const [index, line] of source.split("\n").entries()) {
    const trimmed = line.trim();
    if (lines.includes(index + 1) && trimmed && !/^(\/\/|\/\*|\*|import )/u.test(trimmed) && !/^[\s{}()[\],;]+$/u.test(trimmed)) {
      // A leading closing brace belongs to the previous branch in V8's ranges.
      // Measure the following executable token (for example `else if`) instead.
      const executable = trimmed.replace(/^(?:}\s*)+/, "");
      checked.push({ line: index + 1, covered: candidates.some((script) => executed(script, offset + line.indexOf(executable))) });
    }
    offset += line.length + 1;
  }
  return { file, executable: checked.length, covered: checked.filter((entry) => entry.covered).length, missed: checked.filter((entry) => !entry.covered).map((entry) => entry.line) };
});
writeFileSync(`${directory}/changed-coverage.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
assert.ok(report.every((entry) => entry.missed.length === 0), "Changed executable lines need coverage");
