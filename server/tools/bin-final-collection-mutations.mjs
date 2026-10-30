import {cpSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
const unit='test/mbt/property/bin-final-collection.property.test.js',browser='test/mbt/integration/bin-final-collection-browser.test.js';
const integration='test/mbt/integration/bin-final-collection.test.js';
const service='src/mbt/bin-final-collection.js';
const mutations=[
 {name:'collection-ignore-cancelled-parent',file:service,from:"row.order_status!=='cancelled'",to:'true',test:unit,expected:'collection property:',propertyOnly:true},
 {name:'collection-ignore-planned-work',file:service,from:"!['completed','cancelled'].includes(row.status)",to:"row.status==='ready'",test:unit,expected:'collection property:',propertyOnly:true},
 {name:'collection-block-exchange-legs',file:service,from:"if (kind!=='collection')",to:'if (false)',test:unit,expected:'collection property:',propertyOnly:true},
 {name:'collection-omit-planner-guard',file:'src/mbt/bin-planning-service.js',from:'await assertFinalCollectionReady(prior);',to:'',test:integration,expected:'direct and board planning'},
 {name:'collection-trust-client-history',file:'src/mbt/bin-planning-service.js',from:'await assertFinalCollectionReady(prior);',to:'await assertFinalCollectionReady(input.previousAssignment || prior);',test:integration,expected:'direct and board planning'},
 {name:'collection-omit-drag-lock',file:'public/mbt-planning.js',from:' || Boolean(collectionHold)',to:'',test:browser,expected:'final collection browser:'},
 {name:'collection-omit-red-background',file:'public/bin-order-workflow.css',from:'background: #fff1f2;',to:'background: #ffffff;',test:browser,expected:'final collection browser:'}
];
const results=[];
for(const mutation of mutations) {
  const root=mkdtempSync('test-artifacts/bin-final-collection-mutant-');
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
