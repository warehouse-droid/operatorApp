import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const directory = "test-artifacts/scm-ultimate-packing-20261005";
const changed = JSON.parse(readFileSync(`${directory}/changed-lines.json`, "utf8"));
const scripts = readdirSync(`${directory}/final/coverage`).filter((name) => name.endsWith(".json"))
  .flatMap((name) => JSON.parse(readFileSync(`${directory}/final/coverage/${name}`, "utf8")).result || []);
function executed(script, offset) {
  const functions = script.functions.filter((fn) => fn.ranges[0]?.startOffset <= offset && fn.ranges[0]?.endOffset > offset)
    .sort((left, right) => left.ranges[0].endOffset - left.ranges[0].startOffset - (right.ranges[0].endOffset - right.ranges[0].startOffset));
  const ranges = functions[0]?.ranges.filter((range) => range.startOffset <= offset && range.endOffset > offset)
    .sort((left, right) => left.endOffset - left.startOffset - (right.endOffset - right.startOffset));
  return ranges?.[0]?.count > 0;
}
const reports = [];
for (const [file, changedLines] of Object.entries(changed).filter(([file]) => file.endsWith(".js"))) {
  const source = readFileSync(file, "utf8");
  const candidates = scripts.filter((script) => script.url === `file:///app/${file}` || script.url === `/app/${file}`);
  const checked = [];
  let offset = 0;
  for (const [index, line] of source.split("\n").entries()) {
    const trimmed = line.trim();
    if (changedLines.includes(index + 1) && trimmed && !/^(\/\/|\/\*|\*|import )/u.test(trimmed) && !/^[\s{}()[\],;]+$/u.test(trimmed)) {
      const token = trimmed.replace(/^(?:}\s*)+/, "");
      checked.push({ line: index + 1, covered: candidates.some((script) => executed(script, offset + line.indexOf(token))) });
    }
    offset += line.length + 1;
  }
  reports.push({ file, executable: checked.length, covered: checked.filter((line) => line.covered).length,
    missed: checked.filter((line) => !line.covered).map((line) => line.line) });
}
writeFileSync(`${directory}/final/changed-coverage.json`, `${JSON.stringify(reports, null, 2)}\n`);
console.log(JSON.stringify(reports));
assert.ok(reports.every((report) => report.missed.length === 0), "Changed executable lines need coverage");
