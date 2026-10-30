import {cpSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,rmSync} from "node:fs";
import {resolve,dirname} from "node:path";
import {spawnSync} from "node:child_process";
const integration="test/mbt/integration/bin-planning-corrections.test.js";
const deposit="test/mbt/integration/bin-garbage-deposit.test.js";
const property="test/mbt/property/bin-collection-request.property.test.js";
const mutations=[
  {name:"use-old-contract-deposit",file:"src/mbt/customer-charge-request-service.js",from:"new Set([rentalVersionId || contractVersionId, contractVersionId])",to:"new Set([contractVersionId, rentalVersionId])",test:deposit,expected:"uses the incoming item deposit"},
  {name:"ignore-ambiguous-deposits",file:"src/mbt/customer-charge-request-service.js",from:"selected.rows.length>1 && selected.rows[0].specificity===selected.rows[1].specificity",to:"false",test:deposit,expected:"ambiguous incoming deposit"},
  {name:"trust-dispatch-window",file:"src/mbt/bin-order-workflow-service.js",from:'await requested("delivery") : null',to:'input.deliveryWindow || await requested("delivery") : null',test:integration,expected:"route setup uses order windows"},
  {name:"hide-assigned-search",file:"src/mbt/bin-planning-read.js",from:"search ? searchable : available",to:"available",test:integration,expected:"BIN search finds"},
  {name:"invent-missing-load-assignment",file:"src/mbt/bin-planning-read.js",from:"\n  return result;\n}",to:"\n  return {...result,dispatchPlanned:true,dispatchLoadId:visit.dispatch_load_id};\n}",test:integration,expected:"load missing from the current plan"},
  {name:"price-difference-property-only",file:"src/mbt/bin-order-change.js",from:"[k, -Number(l[k] || 0)]",to:"[k, Number(l[k] || 0)]",test:property,expected:"price differences",propertyOnly:true},
  {name:"drop-deposit-credit-property-only",file:"src/mbt/bin-order-change.js",from:"depositCreditMinor:Math.max(0,-depositDelta)",to:"depositCreditMinor:0",test:property,expected:"price differences",propertyOnly:true}
];
const results=[];
for(const mutation of mutations) {
  const root=mkdtempSync("test-artifacts/bin-corrections-mutant-");
  try {
    for(const dir of ["src","public","contracts","test/support","test/mbt/support"]) cpSync(dir,`${root}/${dir}`,{recursive:true});
    for(const file of [integration,property,deposit]) {mkdirSync(dirname(`${root}/${file}`),{recursive:true});cpSync(file,`${root}/${file}`);}
    cpSync("package.json",`${root}/package.json`);
    mkdirSync(`${root}/tools`,{recursive:true});cpSync("tools/bin-garbage-deposit-rates.mjs",`${root}/tools/bin-garbage-deposit-rates.mjs`);symlinkSync("/app/node_modules",`${root}/node_modules`);
    const target=`${root}/${mutation.file}`,original=readFileSync(target,"utf8");
    if(original.split(mutation.from).length!==2) throw new Error(`Mutant requires one source location: ${mutation.name}`);
    writeFileSync(target,original.replace(mutation.from,mutation.to));
    const selected=[resolve(root,mutation.test)];
    const run=spawnSync(process.execPath,["tools/bin-planning-suites.mjs","selected",...selected],
      {encoding:"utf8",maxBuffer:16*1024*1024,timeout:180000,env:process.env});
    const log=run.stdout+run.stderr;writeFileSync(`test-artifacts/${mutation.name}.log`,log);
    const assertionFailure=log.split("\n").some(line=>line.includes("✖") && line.includes(mutation.expected));
    const killed=run.status!==0 && assertionFailure && /ℹ tests [1-9]\d*/u.test(log) && /AssertionError|expect\(/u.test(log);
    results.push({name:mutation.name,killed,exitCode:run.status,propertyOnly:mutation.propertyOnly===true});
    console.log(JSON.stringify(results.at(-1)));if(!killed) console.log(log.slice(-7000));
  } finally {rmSync(root,{recursive:true,force:true});}
}
writeFileSync("test-artifacts/bin-selection-mutations.json",JSON.stringify(results,null,2));
if(results.some(r=>!r.killed)) process.exitCode=1;
