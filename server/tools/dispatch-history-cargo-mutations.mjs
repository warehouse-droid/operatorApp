import assert from 'node:assert/strict';
import {cp,mkdtemp,readFile,writeFile,symlink,rm,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const root=process.env.DISPATCH_CARGO_GAUNTLET_DIRECTORY || 'test-artifacts/dispatch-all-history-20261002/cargo-route';
await mkdir(root,{recursive:true});
const directory=await mkdtemp('/tmp/dispatch-cargo-mutants-');
for(const name of ['src','public','test','tools','contracts','migrations']) {await cp(name,`${directory}/${name}`,{recursive:true});}
await cp('package.json',`${directory}/package.json`);await symlink('/app/node_modules',`${directory}/node_modules`);
const cases=[
  {name:'ignore direct TO subtraction',file:'src/driver-repository.js',from:'const direct = directAllocationForPlanItem(context.planOrder,item);',to:'const direct = {pallets:0,layers:0,sections:0,pieces:0,quantity:0};',property:true},
  {name:'show only first shared TO allocation',file:'src/driver-repository.js',from:'.filter((entry) => String(entry.transferOrderRef || "") === String(ref));',to:'.filter((entry) => String(entry.transferOrderRef || "") === String(ref)).slice(0,1);'},
  {name:'duplicate linked PO cargo',file:'src/driver-repository.js',from:'.filter(entry => !coveredPoRefs.has(String(entry.poOrderRef || \'\').toLowerCase()))',to:'.filter(()=>true)'},
  {name:'combine vendor allocations',file:'src/driver-repository.js',from:'.filter(entry => dispatchLocationsShareYard(entry.location,context.pickupLocation)) : [];',to:'.filter(()=>true) : [];'},
  {name:'erase physical CO pickup',file:'src/driver-repository.js',from:"['PO','CO'].includes(planOrder?.type)",to:"['PO'].includes(planOrder?.type)"},
  {name:'reject packed legacy TO dependency',file:'src/dispatch-retained-link-manifests.js',from:"dependency.status !== 'cancelled'",to:"dependency.status === 'active'"},
  {name:'subtract allocation repeatedly from duplicate lines',file:'src/dispatch-retained-link-manifests.js',from:'if (index < 0) {return total;}',to:'if (index >= 0) {return total;} ',property:true},
  {name:'include every group child at each yard',file:'public/dispatch.js',from:'.filter(child => sameDispatchLocation(child.transitCo?.toYard || child.sourceYard || order.sourceYard, location))',to:'.filter(()=>true)'},
  ...(process.env.DISPATCH_PACKING_MUTANTS==='1' ? [
    {name:'restore PO packing preview blocker',file:'src/scm-dependency-preview-service.js',
      from:'ignorePacking: ["link_to", "unlink_to", "change_mode", "link_po", "unlink_po"].includes(action)',
      to:'ignorePacking: ["link_to", "unlink_to", "change_mode"].includes(action)',tests:['test/dispatch/integration/to-dependency-packing-independent.test.js']},
    {name:'restore packed CO mode-change blocker',file:'src/co-direct-to-cargo.js',
      from:'const changed = FIELDS.some(field => quantity(line[field]) !== required[field]);',
      to:'const changed = FIELDS.some(field => quantity(line[field]) !== required[field]); if (changed && (line.confirmed_at || Number(line.packed_sales_qty)>0 || Number(line.packed_layer_qty)>0)) {throw conflict("Mutation: packed CO");}',
      tests:['test/dispatch/integration/co-direct-to.test.js']}
  ] : [])
];
const tests=['test/dispatch/unit/linked-stop-cargo.test.js','test/dispatch/integration/linked-driver-stop-content.test.js'];
const report={mutations:[],source:'disposable copy of frozen source',restoredSuiteExit:null};
try {
  for(const mutation of cases) {
    const path=`${directory}/${mutation.file}`,source=await readFile(path,'utf8');
    assert.equal(source.split(mutation.from).length,2,`Mutation must have exactly one target: ${mutation.name}`);
    await writeFile(path,source.replace(mutation.from,mutation.to));
    const run=spawnSync(process.execPath,['--test','--test-concurrency=1',...(mutation.tests || tests)],{cwd:directory,env:process.env,encoding:'utf8',timeout:120000});
    const row={name:mutation.name,killed:run.status!==0,exit:run.status,propertyOnly:null};
    await writeFile(`${root}/mutation-${report.mutations.length+1}.log`,run.stdout+run.stderr);
    if(mutation.property) {
      const property=spawnSync(process.execPath,['--test','--test-name-pattern=duplicate SO item lines',tests[0]],{cwd:directory,env:process.env,encoding:'utf8',timeout:120000});
      row.propertyOnly={killed:property.status!==0,exit:property.status};
    }
    report.mutations.push(row);await writeFile(path,source);
    assert.ok(row.killed,`Surviving mutation: ${mutation.name}`);
  }
  const restoredTests=[...new Set([...tests,...cases.flatMap(mutation=>mutation.tests || [])])];
  const restored=spawnSync(process.execPath,['--test','--test-concurrency=1',...restoredTests],{cwd:directory,env:process.env,encoding:'utf8',timeout:120000});
  report.restoredSuiteExit=restored.status;assert.equal(restored.status,0);
} finally {await writeFile(`${root}/mutations.json`,JSON.stringify(report,null,2)+'\n');await rm(directory,{recursive:true,force:true});}
console.log(JSON.stringify(report));
