import {cpSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,rmSync} from "node:fs";
import {spawnSync} from "node:child_process";
const unit="test/mbt/unit/bin-order-workflow-domain.test.js",integration="test/mbt/integration/bin-order-workflow.test.js";
const property="test/mbt/property/bin-order-workflow.property.test.js";
const mutations=[
  {name:"wrong-delivery-suffix",file:"src/mbt/bin-order-workflow-domain.js",from:'return `${base}D`;',to:'return `${base}C`;',test:unit,expected:"BIN references use"},
  {name:"allow-overnight-exchange",file:"src/mbt/bin-order-workflow-domain.js",
    from:"binLocalDate(input.collectionWindow.startAt) !== binLocalDate(input.deliveryWindow.endAt)",
    to:"binLocalDate(input.collectionWindow.startAt) === binLocalDate(input.deliveryWindow.endAt)",test:unit,expected:"collection-first compares local"},
  {name:"skip-cross-driver-prerequisite",file:"src/mbt/bin-order-workflow-execution.js",
    from:"if (!visit.service_snapshot?.binWorkflow) {return [];}",to:"if (true) {return [];}",test:integration,expected:"a same-bin exchange can reserve both"},
  {name:"lose-truck-custody-at-dump",file:"src/mbt/driver-bin-execution-service.js",
    from:'? "to_truck" : movementKind(actionCode)',to:'? "to_dump" : movementKind(actionCode)',test:integration,expected:"same-bin pickup, dump and redelivery"},
  {name:"allow-unrelated-double-booking",file:"src/mbt/bin-order-workflow-planning.js",
    from:"if (claims.rows.some(",to:"if (false && claims.rows.some(",test:integration,expected:"simultaneous configuration commits once"},
  {name:"retarget-assigned-final-collection",file:"src/mbt/bin-order-workflow-service.js",
    from:"if (final.dispatch_plan_id || final.actual_started_at || issued.rowCount)",
    to:"if (false && (final.dispatch_plan_id || final.actual_started_at || issued.rowCount))",
    test:integration,expected:"linking a different source cannot silently retarget"},
  {name:"retarget-assigned-onward-delivery",file:"src/mbt/bin-order-workflow-service.js",
    from:'if (target.dispatch_plan_id || target.actual_started_at || ["completed","cancelled"].includes(target.status) || issued.rowCount)',
    to:'if (false && (target.dispatch_plan_id || target.actual_started_at || ["completed","cancelled"].includes(target.status) || issued.rowCount))',
    test:integration,expected:"a new exchange cannot redirect the bin"},
  {name:"reschedule-started-collection",file:"src/mbt/frontdesk-service.js",
    from:"if (!isUnassignedReturnEditable(result.rows[0]))",to:"if (false && !isUnassignedReturnEditable(result.rows[0]))",
    test:integration,expected:"parent extensions update draft final collection"},
  {name:"allow-reversed-linked-route",file:"src/mbt/bin-order-workflow-planning.js",
    from:"if (sameLoad ? from.index >= to.index : new Date(from.at)>new Date(to.at))",
    to:"if (false && (sameLoad ? from.index >= to.index : new Date(from.at)>new Date(to.at)))",
    test:integration,expected:"linked plan validation rejects reverse timing"}
];
const runs=mutations.flatMap(mutation=>[mutation,...(mutation.file.endsWith("bin-order-workflow-domain.js") ? [{
  ...mutation,name:`${mutation.name}-properties`,test:property,
  expected:mutation.name==="wrong-delivery-suffix" ? "rental and exchange references remain unique"
    : "different-bin collection-first releases only delivery"
}] : [])]);
const results=[];
for(const mutation of runs) {
  const root=mkdtempSync("/tmp/bin-workflow-mutant-");
  try {
    for(const directory of ["src","public","contracts","test/support","test/mbt/support"]) cpSync(directory,`${root}/${directory}`,{recursive:true});
    for(const file of [unit,integration,property]) {mkdirSync(`${root}/${file.slice(0,file.lastIndexOf("/"))}`,{recursive:true});cpSync(file,`${root}/${file}`);}
    cpSync("package.json",`${root}/package.json`);symlinkSync("/app/node_modules",`${root}/node_modules`);
    const path=`${root}/${mutation.file}`,before=readFileSync(path,"utf8");
    if (before.split(mutation.from).length!==2) throw new Error(`Mutation location is not unique: ${mutation.name}`);
    writeFileSync(path,before.replace(mutation.from,mutation.to));
    const result=spawnSync(process.execPath,["tools/bin-planning-suites.mjs","selected",`${root}/${mutation.test}`],
      {encoding:"utf8",maxBuffer:16*1024*1024,env:process.env});
    const log=result.stdout+result.stderr;
    writeFileSync(`test-artifacts/mutation-${mutation.name}.log`,log);
    const killed=result.status!==0 && log.split("\n").some(line=>line.includes("✖") && line.includes(mutation.expected))
      && /✔/u.test(log);
    results.push({name:mutation.name,killed,status:result.status,test:mutation.test});
    console.log(JSON.stringify(results.at(-1)));
  } finally {rmSync(root,{recursive:true,force:true});}
}
writeFileSync("test-artifacts/workflow-mutations.json",JSON.stringify(results,null,2));
if(results.some(r=>!r.killed)) process.exitCode=1;
