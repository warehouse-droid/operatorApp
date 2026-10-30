import {cpSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,rmSync} from "node:fs";
import {resolve,dirname} from "node:path";
import {spawnSync} from "node:child_process";
const integration="test/mbt/integration/bin-order-workflow-material.test.js";
const unit="test/mbt/unit/bin-order-workflow-domain.test.js",property="test/mbt/property/bin-order-workflow.property.test.js";
const browser="test/mbt/integration/bin-order-workflow-browser.test.js";
const sizeMutation={name:"allow-collection-first-size-change",file:"src/mbt/bin-order-workflow-domain.js",
  from:"if (input.collectionBinTypeId && input.collectionBinTypeId!==input.binTypeId",
  to:"if (false && input.collectionBinTypeId && input.collectionBinTypeId!==input.binTypeId",
  test:unit,expected:"a different-size exchange requires"};
const mutations=[
  {name:"allow-material-override",file:"src/mbt/bin-order-workflow-service.js",
    from:"if (input.materialId && String(input.materialId)!==materialId)",
    to:"if (false && input.materialId && String(input.materialId)!==materialId)",test:integration,expected:"a stale or hostile client"},
  {name:"offer-unordered-materials",file:"src/mbt/bin-order-workflow-service.js",
    from:"AND a.material_id=$1 ORDER BY d.display_name",to:"AND ($1::uuid IS NULL OR true) ORDER BY d.display_name",
    test:integration,expected:"options expose the fixed material"},
  {name:"dump-replacement-contents",file:"src/mbt/bin-order-material.js",
    from:"return {contentCode:charge.calculator.outgoingContentCode}",to:"return {contentCode:charge.calculator.incomingContentCode}",
    test:integration,expected:"charged outgoing contents override"},
  sizeMutation,
  {...sizeMutation,name:"size-change-property-only",test:property,expected:"size changes allow only",propertyOnly:true},
  {name:"allow-size-change-ui-options",file:"public/bin-order-workflow-ui.js",
    from:"const differentType=exchange && collectionAsset",to:"const differentType=false && exchange && collectionAsset",
    test:browser,expected:"browser: dispatcher configures"},
  {name:"use-original-return-charge",file:"src/mbt/bin-order-material.js",
    from:"{...root.service_snapshot,...line.pricing_snapshot}",to:"{...line.pricing_snapshot,...root.service_snapshot}",
    test:integration,expected:"final collection uses current charged contents"}
];
const results=[];
for(const mutation of mutations) {
  const root=mkdtempSync("test-artifacts/bin-material-mutant-");
  try {
    for(const dir of ["src","public","contracts","test/support","test/mbt/support"]) cpSync(dir,`${root}/${dir}`,{recursive:true});
    for(const file of [integration,unit,property,browser]) {mkdirSync(dirname(`${root}/${file}`),{recursive:true});cpSync(file,`${root}/${file}`);}
    cpSync("package.json",`${root}/package.json`);symlinkSync("/app/node_modules",`${root}/node_modules`);
    const target=`${root}/${mutation.file}`,original=readFileSync(target,"utf8");
    if(original.split(mutation.from).length!==2) throw new Error(`Mutant requires one source location: ${mutation.name}`);
    writeFileSync(target,original.replace(mutation.from,mutation.to));
    const selected=[resolve(root,mutation.test),...(mutation.test===browser ? [resolve(root,unit)] : [])];
    const run=spawnSync(process.execPath,["tools/bin-planning-suites.mjs","selected",...selected],
      {encoding:"utf8",maxBuffer:16*1024*1024,timeout:180000,env:process.env});
    const log=run.stdout+run.stderr;writeFileSync(`test-artifacts/${mutation.name}.log`,log);
    const assertionFailure=log.split("\n").some(line=>line.includes("✖") && line.includes(mutation.expected));
    const killed=run.status!==0 && assertionFailure && /✔/u.test(log) && /AssertionError|expect\(/u.test(log);
    results.push({name:mutation.name,killed,exitCode:run.status,propertyOnly:mutation.propertyOnly===true});
    console.log(JSON.stringify(results.at(-1)));if(!killed) console.log(log.slice(-7000));
  } finally {rmSync(root,{recursive:true,force:true});}
}
writeFileSync("test-artifacts/bin-selection-mutations.json",JSON.stringify(results,null,2));
if(results.some(r=>!r.killed)) process.exitCode=1;
