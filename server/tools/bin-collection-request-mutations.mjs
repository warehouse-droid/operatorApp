import {cpSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,rmSync} from "node:fs";
import {resolve,dirname} from "node:path";
import {spawnSync} from "node:child_process";
const integration="test/mbt/integration/bin-collection-request.test.js";
const property="test/mbt/property/bin-collection-request.property.test.js";
const windowTest="test/mbt/integration/bin-order-window.test.js";
const dumpTest="test/mbt/integration/bin-dump-charge.test.js";
const seamTest="test/mbt/integration/frontdesk-bin-dispatch-seam.test.js";
const mutations=[
  {name:"charge-previous-price-again",file:"src/mbt/bin-order-change.js",from:"[k, -Number(l[k] || 0)]",to:"[k, Number(l[k] || 0)]",test:integration,expected:"garbage to soil adds fixed charge"},
  {name:"price-difference-property-only",file:"src/mbt/bin-order-change.js",from:"[k, -Number(l[k] || 0)]",to:"[k, Number(l[k] || 0)]",test:property,expected:"price differences",propertyOnly:true},
  {name:"drop-deposit-credit",file:"src/mbt/bin-order-change.js",from:"depositCreditMinor:Math.max(0,-depositDelta)",to:"depositCreditMinor:0",test:property,expected:"price differences",propertyOnly:true},
  {name:"remind-before-due",file:"src/mbt/frontdesk-bin-overdue.js",from:"getTime() < now.getTime()",to:"getTime() > now.getTime()",test:property,expected:"overdue requires",propertyOnly:true},
  {name:"price-garbage-without-tonne-conversion",file:"src/mbt/customer-charge-calculator.js",from:"roundedRatio(rate,microTonnes,1_000_000",to:"roundedRatio(rate,microTonnes,1_000",test:property,expected:"actual garbage tonnes",propertyOnly:true},
  {name:"change-started-window",file:"src/mbt/bin-order-window-service.js",from:"if (c.reason) { throw binWorkflowError(409, c.reason); }",to:"if (false) { throw binWorkflowError(409, c.reason); }",test:windowTest,expected:"started work leave all state unchanged"},
  {name:"price-before-collection-finishes",file:"src/mbt/bin-dump-charge.js",from:"if (!visitCompleted) { return null; }",to:"if (false) { return null; }",test:dumpTest,expected:"waits for completed collection"},
  {name:"ignore-missing-legacy-return",file:"src/mbt/bin-dispatch-service.js",from:"if ((!dependentVisitId && !deliverySnapshot.collectionOnRequest)",to:"if ((false)",test:seamTest,expected:"stale, wrong-yard, and changed dependent-return revisions"}
];
const results=[];
for(const mutation of mutations) {
  const root=mkdtempSync("test-artifacts/bin-collection-mutant-");
  try {
    for(const dir of ["src","public","contracts","test/support","test/mbt/support"]) cpSync(dir,`${root}/${dir}`,{recursive:true});
    for(const file of [integration,property,windowTest,dumpTest,seamTest]) {mkdirSync(dirname(`${root}/${file}`),{recursive:true});cpSync(file,`${root}/${file}`);}
    cpSync("package.json",`${root}/package.json`);
    mkdirSync(`${root}/tools`,{recursive:true});cpSync("tools/bin-withdraw-automatic-collection.mjs",`${root}/tools/bin-withdraw-automatic-collection.mjs`);symlinkSync("/app/node_modules",`${root}/node_modules`);
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
