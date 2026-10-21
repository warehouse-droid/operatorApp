import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const domain = "src/linked-direct-ship-sync-domain.js";
const repository = "src/linked-direct-ship-sync-repository.js";
const mutations = [
  {name:"ignore_transfer_supply",file:domain,from:"Math.min(demand(target,others), matching.reduce((sum,line) => sum + line.available,0))",to:"demand(target,others)",property:true},
  {name:"ignore_other_allocations",file:domain,from:"competing.reduce((sum, line) => sum + amount(line), 0)",to:"0",property:true},
  {name:"ignore_yard_loads",file:domain,from:"quantity(target.loadedQuantity)",to:"0",property:true},
  {name:"require_original_line_numbers",file:domain,from:"return old.item_id && String(old.dispatch_target_line_key || \"\").split(\"::\")[1] === target.sourceOrderRef;",to:"return false;"},
  {name:"use_inactive_source_lines",file:domain,from:"line.netsuite_active !== false && line.line_stage === \"outbound\"",to:"line.line_stage === \"outbound\""},
  {name:"ignore_unit_identity",file:domain,from:"`${line.itemId ?? line.item_id}:${String(line.unit || \"\").trim().toUpperCase()}`",to:"`${line.itemId ?? line.item_id}`"},
  {name:"omit_audit",file:repository,from:"await writeDispatchAudit({",to:"await Promise.resolve({",integration:true},
  {name:"allow_cancelled_link_race",file:repository,from:"current.status !== \"cancelled\"",to:"current.status !== \"never\"",integration:true}
];
const results=[];
for(const mutation of mutations){
  const temporary=await mkdtemp(path.join(tmpdir(),"direct-ship-mutant-"));
  try {
    await cp("src",path.join(temporary,"src"),{recursive:true});
    await mkdir(path.join(temporary,"test/mbt/unit"),{recursive:true});
    await mkdir(path.join(temporary,"test/mbt/integration"),{recursive:true});
    await cp("test/mbt/unit/linked-direct-ship-sync.test.js",path.join(temporary,"test/mbt/unit/linked-direct-ship-sync.test.js"));
    await cp("test/mbt/integration/linked-direct-ship-sync.test.js",path.join(temporary,"test/mbt/integration/linked-direct-ship-sync.test.js"));
    await symlink(path.resolve("node_modules"),path.join(temporary,"node_modules"));
    await cp("package.json",path.join(temporary,"package.json"));
    const file=path.join(temporary,mutation.file),original=await readFile(file,"utf8");
    assert.equal(original.split(mutation.from).length,2,`${mutation.name}: unique mutation site`);
    await writeFile(file,original.replace(mutation.from,mutation.to));
    const testFile=mutation.integration?"test/mbt/integration/linked-direct-ship-sync.test.js":"test/mbt/unit/linked-direct-ship-sync.test.js";
    const run=spawnSync(process.execPath,["--test","--test-concurrency=1",testFile],{cwd:temporary,encoding:"utf8",timeout:60000});
    await writeFile(`test-artifacts/linked-direct-ship-sync/mutant-${mutation.name}.log`,run.stdout+run.stderr);
    assert.notEqual(run.status,0,`${mutation.name} must be killed`);
    assert.match(run.stdout,/not ok/);
    let propertyKilled=null;
    if(mutation.property){
      const property=spawnSync(process.execPath,["--test","--test-name-pattern=generated quantities",testFile],{cwd:temporary,encoding:"utf8",timeout:60000});
      assert.notEqual(property.status,0,`${mutation.name} must also be killed by properties alone`);
      propertyKilled=true;
    }
    results.push({name:mutation.name,killed:true,propertyKilled});
  } finally {await rm(temporary,{recursive:true,force:true});}
}
await writeFile("test-artifacts/linked-direct-ship-sync/mutations.json",JSON.stringify(results,null,2)+"\n");
console.log(JSON.stringify({killed:results.length,total:mutations.length,propertiesKilled:results.filter(row=>row.propertyKilled).length}));
