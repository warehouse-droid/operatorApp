import {existsSync,readFileSync,writeFileSync} from "node:fs";
import {resolve} from "node:path";
import assert from "node:assert/strict";
import coverage from "istanbul-lib-coverage";
import v8ToIstanbul from "v8-to-istanbul";

const measured=coverage.createCoverageMap(JSON.parse(readFileSync("test-artifacts/workflow-coverage/coverage-final.json","utf8")));
const changed=JSON.parse(readFileSync("test-artifacts/workflow-changed-lines.json","utf8"));
if(existsSync("test-artifacts/workflow-browser-v8.json")) {
  for(const entry of JSON.parse(readFileSync("test-artifacts/workflow-browser-v8.json","utf8"))) {
    if(!entry.url.startsWith("http")) continue;
    const file=`public/${new URL(entry.url).pathname.split("/").pop()}`;
    if(!Object.hasOwn(changed,file) || !existsSync(file) || !file.endsWith(".js")) continue;
    const source=readFileSync(file,"utf8");
    assert.ok(entry.source===source,`Source changed or missing since the browser ran: ${file}`);
    const converter=v8ToIstanbul(resolve(file),0,{source});
    await converter.load();converter.applyCoverage(entry.functions);
    measured.merge(converter.toIstanbul());
  }
}
const report={covered:0,total:0,files:{},uncovered:[],unmeasured:[],branches:{covered:0,total:0}};
for(const [file,numbers] of Object.entries(changed)) {
  if(!file.endsWith(".js")) continue;
  if(!measured.files().includes(resolve(file))) {report.unmeasured.push(file);continue;}
  const entry=measured.fileCoverageFor(resolve(file)),lines=entry.getLineCoverage();
  const detail={covered:0,total:0,uncovered:[]};report.files[file]=detail;
  for(const number of numbers) {
    if(!Object.hasOwn(lines,number)) continue;
    report.total++;detail.total++;
    if(lines[number]) {report.covered++;detail.covered++;}
    else {detail.uncovered.push(number);report.uncovered.push(`${file}:${number}`);}
  }
  for(const [key,branch] of Object.entries(entry.branchMap)) {
    if(!numbers.includes(branch.line)) continue;
    for(const count of entry.b[key]) {report.branches.total++;if(count) report.branches.covered++;}
  }
}
writeFileSync("test-artifacts/workflow-changed-coverage.json",JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if(process.argv.includes("--require-complete")) {
  assert.deepEqual(report.unmeasured,[],"Changed JavaScript must be measured");
  assert.deepEqual(report.uncovered,[],"Changed executable lines need meaningful coverage");
}
