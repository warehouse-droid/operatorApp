import {cpSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,rmSync} from "node:fs";
import {resolve,dirname} from "node:path";
import {spawnSync} from "node:child_process";
const integration="test/mbt/integration/bin-selection.test.js",property="test/mbt/property/bin-selection.property.test.js";
const mutations=[
  {name:"allow-started-selection",file:"src/mbt/bin-selection-service.js",from:"if (context.reason)",to:"if (false && context.reason)",test:integration,expected:"a real driver start locks"},
  {name:"ignore-stale-bin-state",file:"src/mbt/bin-selection-service.js",from:"if (Number(asset.state_revision)!==input.expectedStateRevision)",to:"if (false && Number(asset.state_revision)!==input.expectedStateRevision)",test:integration,expected:"start, stale source, missing lease"},
  {name:"publish-unrelated-drafts",file:"src/mbt/bin-selection-service.js",from:"const released=items.filter(i=>i.released).map(i=>i.visit.service_visit_id);",to:"const released=null;",test:integration,expected:"draft stays draft"},
  {name:"add-duplicate-truck-pickup",file:"src/mbt/bin-selection-snapshot.js",from:'if (source.kind==="truck")',to:'if (false && source.kind==="truck")',test:property,expected:"repeated bin selections preserve"},
  {name:"allow-route-overrun",file:"src/mbt/bin-selection-routing.js",from:"if (depart>load.plannedFinishMinute)",to:"if (false && depart>load.plannedFinishMinute)",test:integration,expected:"changed pickup source"}
];
const runs=mutations.flatMap(m=>[m,...(m.test!==property ? [{...m,name:`${m.name}-property-only`,test:property,propertyOnly:true}] : [])]);
const results=[];
for(const mutation of runs) {
  const root=mkdtempSync("test-artifacts/bin-selection-mutant-");
  try {
    for(const dir of ["src","public","contracts","test/support","test/mbt/support"]) cpSync(dir,`${root}/${dir}`,{recursive:true});
    for(const file of [integration,property]) {mkdirSync(dirname(`${root}/${file}`),{recursive:true});cpSync(file,`${root}/${file}`);}
    cpSync("package.json",`${root}/package.json`);symlinkSync("/app/node_modules",`${root}/node_modules`);
    const target=`${root}/${mutation.file}`,original=readFileSync(target,"utf8");
    if(original.split(mutation.from).length!==2) throw new Error(`Mutant no longer has one source location: ${mutation.name}`);
    writeFileSync(target,original.replace(mutation.from,mutation.to));
    const run=spawnSync(process.execPath,["tools/bin-planning-suites.mjs","selected",resolve(root,mutation.test)],
      {encoding:"utf8",maxBuffer:16*1024*1024,timeout:180000,env:process.env});
    const log=run.stdout+run.stderr;writeFileSync(`test-artifacts/${mutation.name}.log`,log);
    const assertionFailure=log.split("\n").some(line=>line.includes("✖") && line.includes(mutation.propertyOnly ? "route timing fits" : mutation.expected));
    const killed=run.status!==0 && assertionFailure && /✔/u.test(log);
    results.push({name:mutation.name,killed,exitCode:run.status,propertyOnly:mutation.propertyOnly===true});
    console.log(JSON.stringify(results.at(-1)));
    if(!mutation.propertyOnly && !killed) console.log(log.slice(-6000));
  } finally {rmSync(root,{recursive:true,force:true});}
}
writeFileSync("test-artifacts/bin-selection-mutations.json",JSON.stringify(results,null,2));
if(results.some(r=>!r.propertyOnly && !r.killed)) process.exitCode=1;
