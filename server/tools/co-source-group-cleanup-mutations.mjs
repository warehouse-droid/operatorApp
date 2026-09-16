import assert from "node:assert/strict";
import {readFileSync,writeFileSync,mkdirSync,rmSync} from "node:fs";
import {spawnSync} from "node:child_process";
import path from "node:path";

const directory=path.resolve("test-artifacts/so-delivery-cleanup-grouped-co-20260915/mutations");
mkdirSync(directory,{recursive:true});
const original=readFileSync("tools/co-source-cleanup-repository.mjs","utf8");
const tests=readFileSync("test/dispatch/unit/co-source-group-cleanup.test.js","utf8");
const cases=[
  ["lose_recorded_members","const members=recordedCoGroupMembers(co)","const members=undefined"],
  ["partly_complete_group",'return children.every(Boolean)?{kind:"recorded_co_group"','return children.some(Boolean)?{kind:"recorded_co_group"'],
  ["skip_ignored","skipped.has(ref)||seen.has(ref)","seen.has(ref)"],
  ["source_identity_ignored","normalizeRef(details.sourceOrderId)!==normalizeRef(co.source_order_ref)","false"],
  ["child_identity_ignored","childRefs.some(ref=>!refs.includes(ref))","false"]
];
const results=[];
for(const [name,needle,replacement] of cases) {
  assert(original.includes(needle),name);
  const root=path.join(directory,name);mkdirSync(root,{recursive:true});
  writeFileSync(path.join(root,"mutant.mjs"),original.replace(needle,replacement)
    .replaceAll('"../src/',`"${path.resolve("src")}/`)
    .replaceAll('"./so-delivery-cleanup-',`"${path.resolve("tools")}/so-delivery-cleanup-`));
  writeFileSync(path.join(root,"test.mjs"),tests.replace("../../../tools/co-source-cleanup-repository.mjs","./mutant.mjs"));
  for(const propertyOnly of [false,true]) {
    const run=spawnSync(process.execPath,["--test",...(propertyOnly?["--test-name-pattern=property"]:[]),path.join(root,"test.mjs")],{encoding:"utf8"});
    writeFileSync(path.join(directory,`${name}-${propertyOnly?"properties":"suite"}.log`),run.stdout+run.stderr);
    assert.match(run.stdout,/# fail [1-9]/,`${name} must fail behavior assertions`);
    assert.notEqual(run.status,0,`${name} survived`);
    results.push({name,propertyOnly,killed:true});
  }
  rmSync(root,{recursive:true});
}
writeFileSync(path.join(directory,"results.json"),JSON.stringify(results,null,2)+"\n");
console.log(JSON.stringify({mutants:cases.length,suiteKills:results.filter(row=>!row.propertyOnly).length,propertyKills:results.filter(row=>row.propertyOnly).length}));
