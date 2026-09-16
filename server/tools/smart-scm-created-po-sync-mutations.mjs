import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

assert.equal(process.env.MBT_TEST_ISOLATED,"1");
const directory="test-artifacts/smart-scm-created-po-sync";
const projection="src/smart-scm-created-po.js";
const unit="test/mbt/unit/smart-scm-created-po.test.js";
const service="test/mbt/unit/smart-scm-created-po-service.test.js";
const mutants=[
  ["keep old proposal rows",projection,"if (!current?.header) return proposal;","return proposal;",unit,true],
  ["include deleted lines",projection,"line.netsuite_active !== false","true",unit,true],
  ["lose native quantities",projection,"salesQuantity: conversion.nativeQuantity","salesQuantity: 0",unit,true],
  ["allow same-day stale edits","src/scm-netsuite-po-history-service.js","|| !body.expectedVersion || body.expectedVersion !== scmNetSuitePoVersion(remote)","",service,false],
  ["lose refresh atomicity","src/scm-netsuite-po-history-service.js","return withTransaction(async () => {","return (async () => {",service,false],
  ["erase prices on partial webhook","src/scm-netsuite-po-history-repository.js","COALESCE($3, rate)","$3::numeric","test/mbt/integration/smart-scm-vendor-unit-price.test.js",false],
  ["skip transport version recheck","src/netsuite.js","if (expectedVersion) {","if (false) {",service,false]
];
const results=[];
for (const [index,[name,file,before,after,testFile,property]] of mutants.entries()) {
  const root=mkdtempSync(path.join(tmpdir(),"created-po-mutant-"));
  try {
    for (const folder of ["src","public","test"]) cpSync(folder,path.join(root,folder),{recursive:true});
    cpSync("package.json",path.join(root,"package.json"));
    symlinkSync(path.resolve("node_modules"),path.join(root,"node_modules"),"dir");
    const source=readFileSync(path.join(root,file),"utf8");
    assert.equal(source.split(before).length,2,`Unique mutant target: ${name}`);
    let modified=source.replace(before,after);
    if(name==="lose refresh atomicity") modified=modified.replace("requestedChanges });\n  });","requestedChanges });\n  })();");
    writeFileSync(path.join(root,file),modified);
    for(const layer of property ? ["focused","properties"] : ["focused"]) {
      const args=["--test"];
      if(layer==="properties") args.push("--test-name-pattern=projection is idempotent");
      if(testFile.includes("integration/")) args.push("--test-name-pattern=price-less webhook");
      args.push(testFile);
      const run=spawnSync(process.execPath,args,{cwd:root,encoding:"utf8",maxBuffer:5e6,env:{...process.env,NODE_V8_COVERAGE:""}});
      if(run.error) throw run.error;
      const output=`${run.stdout}${run.stderr}`;
      writeFileSync(`${directory}/mutant-${index+1}-${layer}.log`,output);
      const killed=run.status!==0 && /ERR_ASSERTION|Property failed after/.test(output);
      results.push({name,layer,killed});
      assert.ok(killed,`${name} survived ${layer}`);
    }
  } finally { rmSync(root,{recursive:true,force:true}); }
}
writeFileSync(`${directory}/mutations.json`,JSON.stringify(results,null,2));
console.log(JSON.stringify(results));
