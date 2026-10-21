import fs from "node:fs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import coverageLibrary from "istanbul-lib-coverage";

const map = coverageLibrary.createCoverageMap(JSON.parse(fs.readFileSync("test-artifacts/coverage/coverage-final.json", "utf8")));
const report = [];
for (const name of ["src/delivery-repository.js", "src/operator-load-state.js"]) {
  const before = `/workspace/server/test-artifacts/local-vrma-final-qty-20261019/baseline/${name}`;
  const difference = spawnSync("diff", ["-U0", before, name], { encoding: "utf8" });
  assert.ok([0, 1].includes(difference.status));
  const added = new Set();
  let line = 0;
  for (const text of difference.stdout.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (header) { line = Number(header[1]); continue; }
    if (text.startsWith("+++")) { continue; }
    if (text.startsWith("+")) { added.add(line++); }
    else if (text.startsWith(" ")) { line += 1; }
  }
  const coverage = map.fileCoverageFor(`/app/${name}`).getLineCoverage();
  const sourceLines = fs.readFileSync(name, "utf8").split("\n");
  const measured = [...added].filter(number => coverage[number] !== undefined
    && !/^\s*(?:[{}]|\}\);)\s*$/.test(sourceLines[number - 1]));
  const missed = measured.filter(number => coverage[number] === 0);
  report.push({ name, measured: measured.length, covered: measured.length - missed.length, missed });
}
fs.writeFileSync("test-artifacts/changed-line-coverage.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
assert.equal(report.flatMap(row => row.missed).length, 0, "All changed executable backend lines must be exercised");
