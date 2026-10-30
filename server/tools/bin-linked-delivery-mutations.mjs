import {cpSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
const unit='test/mbt/property/bin-linked-delivery.property.test.js',browser='test/mbt/integration/bin-linked-delivery-browser.test.js';
const integration='test/mbt/integration/bin-linked-delivery.test.js';
const service='src/mbt/bin-linked-delivery-planning.js';
const mutations=[
 {name:'linked-skip-auto-delivery',file:service,from:'if (!target) {',to:'if (false) {',test:unit,expected:'linked property:',propertyOnly:true},
 {name:'linked-reverse-auto-delivery',file:service,from:'source.visits.splice(index+1,0,',to:'source.visits.splice(index,0,',test:unit,expected:'linked property:',propertyOnly:true},
 {name:'linked-allow-split-loads',file:service,from:'if (target && (',to:'if (target && source===target && (',test:unit,expected:'linked property:',propertyOnly:true},
 {name:'linked-omit-direct-pair',file:service,from:'linkedBinRoutes([input.visitId])',to:'linkedBinRoutes([])',test:integration,expected:'delivery cannot be planned alone'},
 {name:'linked-omit-browser-pair',file:'public/mbt-planning.js',from:'const route=linkedRouteCards(card);',to:'const route=[card];',test:browser,expected:'browser: dragging collection'}
];
const results=[];
for(const mutation of mutations) {
  const root=mkdtempSync('test-artifacts/bin-linked-mutant-');
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
