import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const directory="test-artifacts/smart-scm-created-po-sync";
const coverage=JSON.parse(readFileSync(`${directory}/coverage/coverage-final.json`,"utf8"));
const manifest=JSON.parse(readFileSync(`${directory}/changed-lines.json`,"utf8"));
const results=[];
for(const [file,entry] of Object.entries(coverage)) {
  const relative=file.replace(/^\/app\//,"");
  assert.equal(createHash("sha256").update(readFileSync(relative)).digest("hex"),manifest[relative].sha256,"Coverage must match the captured source");
  const hits=new Map();
  for(const [id,location] of Object.entries(entry.statementMap)) {
    for(let n=location.start.line;n<=location.end.line;n++) hits.set(n,Math.max(hits.get(n)||0,entry.s[id]));
  }
  const changed=manifest[relative].lines;
  const measured=changed.filter(line=>hits.has(line));
  const missing=measured.filter(line=>!hits.get(line));
  results.push({file:relative,changed:measured.length,covered:measured.length-missing.length,missing});
}
writeFileSync(`${directory}/changed-coverage.json`,JSON.stringify(results,null,2));
console.log(JSON.stringify(results));
assert.ok(results.length>=6,"All changed backend modules must be measured");
assert.ok(results.every(result=>result.changed>0&&result.missing.length===0),"Every changed backend line must execute in the tests");
