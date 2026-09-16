import assert from "node:assert/strict";
import {readFileSync,writeFileSync,mkdirSync,rmSync} from "node:fs";
import {spawnSync} from "node:child_process";
import path from "node:path";

const directory=path.resolve("test-artifacts/so-delivery-cleanup-apply-20260915/co-mutations");
mkdirSync(directory,{recursive:true});
const repository="tools/co-source-cleanup-repository.mjs",policy="src/local-co-loaded-policy.js";
const cases=[
  ["partly_complete_group",repository,"co-source-cleanup","children.every(Boolean)","children.some(Boolean)"],
  ["retired_group",repository,"co-source-cleanup","!group.active||!group.members.length","!group.members.length"],
  ["skip_ignored",repository,"co-source-cleanup","skipped.has(ref)||seen.has(ref)","seen.has(ref)"],
  ["zero_loaded_quantity",policy,"local-co-loaded","loaded_qty: requiredQuantity","loaded_qty: 0"],
  ["receipt_changed",policy,"local-co-loaded","{ ...line, loaded_qty:","{ ...line, received_sales_qty: 0, loaded_qty:"]
];
const results=[];
for(const [name,file,test,needle,replacement] of cases) {
  const original=readFileSync(file,"utf8");assert(original.includes(needle),name);
  const root=path.join(directory,name);mkdirSync(root,{recursive:true});
  const mutated=original.replace(needle,replacement)
    .replaceAll('"../src/',`"${path.resolve("src")}/`)
    .replaceAll('"./so-delivery-cleanup-',`"${path.resolve("tools")}/so-delivery-cleanup-`);
  writeFileSync(path.join(root,"mutant.mjs"),mutated);
  writeFileSync(path.join(root,"test.mjs"),readFileSync(`test/dispatch/unit/${test}.test.js`,"utf8")
    .replace(`../../../${file}`,"./mutant.mjs"));
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
