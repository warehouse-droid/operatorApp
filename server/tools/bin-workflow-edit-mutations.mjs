import {cpSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
const unit='test/mbt/property/bin-workflow-edit.property.test.js',browser='test/mbt/integration/bin-workflow-edit-browser.test.js';
const integration='test/mbt/integration/bin-workflow-edit-locks.test.js';
const service='src/mbt/bin-order-workflow-editing.js';
const mutations=[
 {name:'edit-ignore-current-plan',file:service,from:'visit?.dispatch_plan_id ||',to:'false ||',test:unit,expected:'edit property:',propertyOnly:true},
 {name:'edit-unlock-busy-sequence',file:service,from:'parts.every(p=>!binWorkLocked(p) && !p.incoming_link)',to:'true',test:unit,expected:'edit property:',propertyOnly:true},
 {name:'edit-overlock-collection',file:service,from:"&& editable('collection')",to:"&& delivery && editable('collection')",test:unit,expected:'edit property:',propertyOnly:true},
 {name:'edit-allow-forged-collection',file:service,from:'{assertCollectionFields(configuration,input,parts);}',to:'{}',test:integration,expected:'planning collection locks its route'},
 {name:'edit-detach-started-delivery',file:'src/mbt/bin-order-workflow-unlink.js',from:'if (binWorkLocked(target))',to:'if (false)',test:integration,expected:'started onward delivery'},
 {name:'edit-ignore-stale-planning-revision',file:'src/mbt/bin-planning-repository.js',from:'if (revision !== undefined &&',to:'if (false &&',test:integration,expected:'simultaneous collection planning'},
 {name:'edit-overlock-browser',file:'public/bin-order-workflow-ui.js',from:'routeOnly=Boolean(data.configurationIssue)',to:'routeOnly=Boolean(data.configurationIssue || w.parts.some(p=>p.planId))',test:browser,expected:'browser edit locks:'}
];
const results=[];
for(const mutation of mutations) {
  const root=mkdtempSync('test-artifacts/bin-edit-mutant-');
  try {
    for(const dir of ['src','public','contracts','test/support','test/mbt/support']) cpSync(dir,`${root}/${dir}`,{recursive:true});
    for(const file of [unit,browser,integration]) {mkdirSync(dirname(`${root}/${file}`),{recursive:true});cpSync(file,`${root}/${file}`);}
    cpSync('package.json',`${root}/package.json`);symlinkSync('/app/node_modules',`${root}/node_modules`);
    const target=`${root}/${mutation.file}`,source=readFileSync(target,'utf8');
    if(source.split(mutation.from).length!==(mutation.matches||1)+1) throw new Error(`Mutation source mismatch: ${mutation.name}`);
    writeFileSync(target,source.replace(mutation.from,mutation.to));
    const run=spawnSync(process.execPath,['tools/bin-planning-suites.mjs','selected',resolve(root,mutation.test)],
      {encoding:'utf8',maxBuffer:16*1024*1024,timeout:90000,env:process.env});
    const output=run.stdout+run.stderr;writeFileSync(`test-artifacts/${mutation.name}.log`,output);
    const killed=run.status!==0 && output.split('\n').some(line=>line.includes('✖')&&line.includes(mutation.expected)) && /AssertionError|Property failed|expect\(locator\)/u.test(output);
    results.push({name:mutation.name,killed,exitCode:run.status,propertyOnly:Boolean(mutation.propertyOnly)});console.log(JSON.stringify(results.at(-1)));
    if(!killed) console.log(output.slice(-5000));
  } finally {rmSync(root,{recursive:true,force:true});}
}
writeFileSync('test-artifacts/bin-selection-mutations.json',JSON.stringify(results,null,2));
if(results.some(r=>!r.killed)) process.exitCode=1;
