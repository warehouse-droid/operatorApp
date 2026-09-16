import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {runNode} from "./blanket-auto-resume-suite.mjs";

const artifact=path.resolve("test-artifacts/blanket-auto-resume");
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),"blanket-resume-mutants-"));
const target="src/smart-scm-planning-exclusion-repository.js";
const mutations=[
  ["skip-resumption",target,"const poolRows = await listSmartScmBlanketPoolRows", "return [];\n    const poolRows = await listSmartScmBlanketPoolRows"],
  ["accept-closed-lines",target,"AND NOT COALESCE(line.netsuite_closed, false)","AND true"],
  ["ignore-conversion",target,"AND ABS(source.to_plt - COALESCE(item.to_plt, policy.to_plt)) <= 0.000001","AND true"],
  ["reject-one-pallet",target,"AND source.remaining_pallets >= 1","AND source.remaining_pallets > 1"],
  ["omit-audit",target,"for (const details of results)","for (const details of [])"],
  ["return-stale-hold-status",target,"return publicExclusion(reconciled.rows[0]);","return result;"],
  ["omit-blanket-build-hook","src/smart-scm-blanket-repository.js","await resumeSmartScmBlanketCoveredPlanningExclusions({ operatorId });","// reconciliation omitted"],
  ["omit-ordinary-build-hook","src/smart-scm-planning-repository.js","await resumeSmartScmBlanketCoveredPlanningExclusions({ operatorId });","// reconciliation omitted"]
];
const results=[];
try {
  for(const folder of ["src","test","public"])fs.cpSync(folder,path.join(scratch,folder),{recursive:true});
  fs.copyFileSync("package.json",path.join(scratch,"package.json"));
  fs.symlinkSync(path.resolve("node_modules"),path.join(scratch,"node_modules"));
  for(const [name,file,from,to] of mutations) {
    const original=fs.readFileSync(file,"utf8");
    assert.equal(original.split(from).length,2,`${name}: unique mutation site`);
    const destination=path.join(scratch,file);
    fs.writeFileSync(destination,original.replace(from,to));
    const suite=runNode(["--test","test/mbt/integration/blanket-auto-resume.test.js"],{cwd:scratch,log:`${artifact}/mutant-${name}.log`});
    const property=runNode(["--test","--test-name-pattern=generated balances","test/mbt/integration/blanket-auto-resume.test.js"],{cwd:scratch,log:`${artifact}/mutant-${name}-property.log`});
    const killed=suite.status!==0&&/^not ok/m.test(suite.output);
    results.push({name,killed,propertyKilled:property.status!==0&&/^not ok/m.test(property.output)});
    fs.writeFileSync(destination,original);
    console.log(JSON.stringify(results.at(-1)));
  }
}finally{fs.rmSync(scratch,{recursive:true,force:true});}
fs.writeFileSync(`${artifact}/mutations.json`,JSON.stringify(results,null,2));
assert.ok(results.every(r=>r.killed),"Every selected fault must be detected.");
