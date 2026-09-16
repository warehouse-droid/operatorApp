import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const directory=path.resolve("test-artifacts/so-delivery-cleanup-apply-20260915/mutations");
mkdirSync(directory,{recursive:true});
const original=readFileSync("tools/so-delivery-cleanup-domain.mjs","utf8");
const tests=readFileSync("test/dispatch/unit/so-delivery-cleanup.test.js","utf8");
const mutations=[
  ["wrong_loaded_bound","Math.max(Number(line.loaded_qty || 0)","Math.min(Number(line.loaded_qty || 0)"],
  ["ignore_linked_supply","allocations[String(line.id)] || {}","{}"],
  ["trust_stale_status_label","![\"F\", \"G\"].includes(verified.status)","false"],
  ["allow_duplicate_identity","options.identityCount !== 1","false"],
  ["block_every_eligible_order","const eligible = qualifies && reasons.length === 0","const eligible = false"]
];
const results=[];
for(const [name,needle,replacement] of mutations) {
  assert(original.includes(needle),name);
  const root=path.join(directory,name);
  mkdirSync(path.join(root,"tools"),{recursive:true});
  symlinkSync(path.resolve("src"),path.join(root,"src"));
  writeFileSync(path.join(root,"tools/domain.mjs"),original.replace(needle,replacement));
  writeFileSync(path.join(root,"test.mjs"),tests.replace("../../../tools/so-delivery-cleanup-domain.mjs","./tools/domain.mjs"));
  for(const propertyOnly of [false,true]) {
    const run=spawnSync(process.execPath,["--test",...(propertyOnly?["--test-name-pattern=property"]:[]),path.join(root,"test.mjs")],{encoding:"utf8"});
    writeFileSync(path.join(directory,`${name}-${propertyOnly?"properties":"suite"}.log`),`${run.stdout}${run.stderr}`);
    assert.match(run.stdout,/# fail [1-9]/,`${name} must fail behavior assertions`);
    assert.notEqual(run.status,0,`${name} survived`);
    results.push({name,propertyOnly,killed:true});
  }
  rmSync(root,{recursive:true});
}
writeFileSync(path.join(directory,"results.json"),JSON.stringify(results,null,2)+"\n");
console.log(JSON.stringify({mutants:mutations.length,suiteKills:results.filter(row=>!row.propertyOnly).length,propertyKills:results.filter(row=>row.propertyOnly).length}));
