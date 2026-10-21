import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile, symlink, rm } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const root=await mkdtemp(path.join(tmpdir(),"direct-ship-mutants-"));
const route="src/dispatch-to-route-projection.js";
const guard="src/dispatch-linked-cargo-repository.js";
const receipt="src/order-dependency-repository.js";
const sql="migrations/230_direct_ship_lifecycle.sql";
const properties="test/dispatch/property/direct-ship-quantities.test.js";
const tests=["test/dispatch/integration/direct-ship-po-planning.test.js","test/dispatch/integration/direct-ship-to-lifecycle.test.js",
  properties,"test/dispatch/unit/direct-ship-recorded-projection.test.js"];
const mutants=[
  ["linked TO cargo remains in the independent route",route,"Math.min(total, remaining.get(key) || 0)","0",true],
  ["duplicate item lines subtract the same allocation twice",route,"Math.max(0, (remaining.get(key) || 0) - allocated)","remaining.get(key) || 0",true],
  ["physical cargo ignores native allocation",route,"total > 0 ? quantity / total : 1","1",true],
  ["cancelled links still reserve cargo",route,' || dependency.status === "cancelled"','',true],
  ["mixed units ignore available conversion",route,"const display = hasConversion ? dependencyQuantityConversionDisplay(quantity, item) : null;","const display = null;",true],
  ["unknown native quantity hides known cargo",sql,"source.unknown_native_cargo OR ","",false],
  ["fully linked PO bypasses server guard",guard,"AND dispatch_po_link_fully_covers(po.netsuite_id)","AND false AND dispatch_po_link_fully_covers(po.netsuite_id)",false],
  ["partial TO completes at first SO drop",sql,"IF NOT dispatch_direct_to_has_residual(source_id) THEN RETURN true; END IF;","RETURN true;",false],
  ["PO remaining drop ignores its linked deliveries",sql,"ELSIF raw_kind='PO' THEN","ELSIF raw_kind='SKIP_PO' THEN",false],
  ["partial historical TO remains falsely completed",sql,"AND dispatch_direct_to_has_residual(dependency.transfer_order_id)","AND false AND dispatch_direct_to_has_residual(dependency.transfer_order_id)",false],
  ["direct receipt uses processing time",receipt,"SET status = 'received_local', local_completed_at = $3, direct_received_at = $3,","SET status = 'received_local', local_completed_at = $3, direct_received_at = now(),",false]
];

function run(files) {
  return spawnSync(process.execPath,["tools/dispatch-special-po-suites.mjs",...files],
    {cwd:root,env:process.env,encoding:"utf8",timeout:120000,maxBuffer:8*1024*1024});
}
function applyMigration() {
  const result=spawnSync(process.execPath,["--input-type=module","-e",
    "import{readFile}from'node:fs/promises';import{query,closeDb}from'./src/db.js';await query(await readFile('migrations/230_direct_ship_lifecycle.sql','utf8'));await closeDb();"],
  {cwd:root,env:process.env,encoding:"utf8",timeout:30000});
  assert.equal(result.status,0,result.stderr);
}
const results=[];
try {
  for (const directory of ["src","public","test","migrations","tools"]) {
    await cp(directory,path.join(root,directory),{recursive:true});
  }
  await cp("package.json",path.join(root,"package.json"));
  await symlink(path.resolve("node_modules"),path.join(root,"node_modules"));
  const originals=new Map(await Promise.all([route,guard,receipt,sql].map(async file=>[file,await readFile(path.join(root,file),"utf8")])));
  assert.equal(run(tests).status,0,"Unmutated suite must pass");
  for (const [name,file,from,to,propertyApplicable] of mutants) {
    const source=originals.get(file);
    assert.ok(source.includes(from),`Missing mutation target: ${name}`);
    await writeFile(path.join(root,file),source.replace(from,to));
    applyMigration();
    const mutated=run(tests);
    await writeFile(`test-artifacts/mutant-${results.length+1}.log`,mutated.stdout+mutated.stderr);
    const killed=mutated.status!==0 && /ERR_ASSERTION|Property failed/u.test(mutated.stdout+mutated.stderr);
    let propertyKilled=null;
    if (propertyApplicable) {
      const result=run([properties]);
      propertyKilled=result.status!==0 && /ERR_ASSERTION|Property failed/u.test(result.stdout+result.stderr);
    }
    await writeFile(path.join(root,file),source);
    applyMigration();
    results.push({name,killed,propertyKilled});
    await writeFile("test-artifacts/mutations.json",JSON.stringify(results,null,2)+"\n");
    assert.equal(killed,true,`Survived: ${name}`);
    if (propertyApplicable) {assert.equal(propertyKilled,true,`Property blind spot: ${name}`);}
  }
  assert.equal(run(tests).status,0,"Restored suite must pass");
  console.log(JSON.stringify({killed:results.length,total:mutants.length,propertyKilled:results.filter(row=>row.propertyKilled).length}));
} finally {await rm(root,{recursive:true,force:true});}
