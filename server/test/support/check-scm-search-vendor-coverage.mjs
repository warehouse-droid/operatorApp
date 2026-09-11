import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const folder="test-artifacts/scm-search-vendor/coverage";
const summary=JSON.parse(await readFile(`${folder}/coverage-summary.json`,"utf8"));
const service=Object.entries(summary).find(([name])=>name.endsWith("/src/scm-vendor-completion.js"))?.[1];
assert.ok(service,"Completion service coverage is required.");
assert.equal(service.lines.pct,100);
assert.equal(service.functions.pct,100);
const report=JSON.parse(await readFile(`${folder}/coverage-final.json`,"utf8"));
for(const [file,needle,endNeedle] of [
  ["src/dispatch-repository.js","const searchAllStatuses = Boolean(globalSearch)","const params = ["],
  ["src/server.js",'app.post("/api/scm/schedule/:id/complete-vendor"','app.get("/api/scm/schedule-formatting"']
]){
  const source=await readFile(file,"utf8");
  const start=source.indexOf(needle);const end=source.indexOf(endNeedle,start);
  assert.ok(start>=0&&end>start);
  const firstLine=source.slice(0,start).split("\n").length;
  const lastLine=source.slice(0,end).split("\n").length;
  const coverage=Object.entries(report).find(([name])=>name.endsWith(`/${file}`))?.[1];
  assert.ok(coverage);
  const selected=Object.entries(coverage.statementMap).filter(([,span])=>span.start.line>=firstLine&&span.start.line<lastLine);
  assert.ok(selected.length);
  for(const [id,span] of selected){assert.ok(coverage.s[id]>0,`${file}:${span.start.line} was not exercised.`);}
  console.log(`${file}: ${selected.length}/${selected.length} added-region statements exercised.`);
}
console.log(`Completion service: ${service.lines.covered}/${service.lines.total} lines, ${service.functions.covered}/${service.functions.total} functions; branches ${service.branches.pct}%.`);
