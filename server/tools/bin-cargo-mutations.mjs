import {cpSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
const property='test/mbt/property/bin-cargo.property.test.js';
const mutations=[
  {name:'cargo-ignore-purchased-weight',file:'src/mbt/bin-cargo-domain.js',from:'weight(purchased ? purchased.derivedWeightLbs : item.weightLbs)',to:'weight(item.weightLbs)',test:'test/mbt/unit/bin-cargo-domain.test.js',expected:'purchased Gravel'},
  {name:'cargo-release-custom-guard',file:'src/mbt/bin-cargo-repository.js',from:'if (claim) {throw cargoError',to:'if (false) {throw cargoError',test:'test/mbt/integration/bin-cargo-routing.test.js',expected:'custom claims exclude'},
  {name:'cargo-lose-bin-custody',file:'src/mbt/driver-bin-execution-service.js',from:'if (/^cargo_(pickup|dropoff)_\\d+$/u.test(actionCode)) {return "to_truck";}',to:'if (/^cargo_(pickup|dropoff)_\\d+$/u.test(actionCode)) {return "to_customer";}',test:'test/mbt/integration/bin-cargo-driver.test.js',expected:'Gravel pickup follows'},
  {name:'cargo-never-complete-custom',file:'src/mbt/bin-cargo-repository.js',from:"i?.source==='existing'",to:'false',test:'test/mbt/integration/bin-cargo-driver.test.js',expected:'Custom Order completes'},
  {name:'cargo-weight-property-only',file:'src/mbt/bin-cargo-domain.js',from:'aboard+=item.weightLbs;',to:'aboard=0;',test:property,expected:'cargo property:',propertyOnly:true},
  {name:'cargo-order-property-only',file:'src/mbt/bin-cargo-domain.js',from:'...base.slice(0,-1),...pickups,...drops,',to:'...base.slice(0,-1),...drops,...pickups,',test:property,expected:'cargo property:',propertyOnly:true}
];
const results=[];
for(const mutation of mutations) {
  const root=mkdtempSync('test-artifacts/bin-cargo-mutant-');
  try {
    for(const dir of ['src','public','contracts','test/support','test/mbt/support']) cpSync(dir,`${root}/${dir}`,{recursive:true});
    for(const file of [...new Set(mutations.map(m=>m.test))]) {mkdirSync(dirname(`${root}/${file}`),{recursive:true});cpSync(file,`${root}/${file}`);}
    cpSync('package.json',`${root}/package.json`);symlinkSync('/app/node_modules',`${root}/node_modules`);
    const target=`${root}/${mutation.file}`,source=readFileSync(target,'utf8');
    if(source.split(mutation.from).length!==2) throw new Error(`Mutation source must match once: ${mutation.name}`);
    writeFileSync(target,source.replace(mutation.from,mutation.to));
    const run=spawnSync(process.execPath,['tools/bin-planning-suites.mjs','selected',resolve(root,mutation.test)],{encoding:'utf8',maxBuffer:16*1024*1024,timeout:180000,env:process.env});
    const output=run.stdout+run.stderr;writeFileSync(`test-artifacts/${mutation.name}.log`,output);
    const killed=run.status!==0 && output.split('\n').some(line=>line.includes('✖') && line.includes(mutation.expected)) && /AssertionError|Property failed/u.test(output);
    results.push({name:mutation.name,killed,exitCode:run.status,propertyOnly:Boolean(mutation.propertyOnly)});
    console.log(JSON.stringify(results.at(-1)));if(!killed) console.log(output.slice(-5000));
  } finally {rmSync(root,{recursive:true,force:true});}
}
writeFileSync('test-artifacts/bin-selection-mutations.json',JSON.stringify(results,null,2));
if(results.some(r=>!r.killed)) process.exitCode=1;
