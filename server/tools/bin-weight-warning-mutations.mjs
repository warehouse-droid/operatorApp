import {cpSync,mkdtempSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
const domain='src/mbt/bin-planning-domain.js',planning='src/mbt/bin-transport-planning.js',read='src/mbt/bin-planning-read.js';
const ui='public/mbt-planning.js';
const files=[domain,planning,read,ui],hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const before=Object.fromEntries(files.map(file=>[file,hash(file)])),results=[];
const cases=[
  {name:'block-overweight',file:domain,from:'if (weightLbs > route.capacityLbs) {warnings.push(',to:"if (weightLbs > route.capacityLbs) {throw conflict('MBT_BIN_CAPACITY_EXCEEDED','Weight blocked');warnings.push(",property:true},
  {name:'suppress-weight-warning',file:domain,from:'if (weightLbs > route.capacityLbs)',to:'if (false)',property:true},
  {name:'warn-at-capacity',file:domain,from:'if (weightLbs > route.capacityLbs)',to:'if (weightLbs >= route.capacityLbs)',property:true},
  {name:'allow-excess-physical-slots',file:domain,from:'if (aboard.size > route.slotCapacity)',to:'if (false)'},
  {name:'restore-transport-weight-block',file:planning,from:"AND t.truck_type='bin' AND t.bin_service_enabled",to:"AND t.capacity_lbs>=${Number(trip.weight_lbs)+Number(trip.tare_weight_kg || 0)*2.2046226218} AND t.truck_type='bin' AND t.bin_service_enabled",integration:true},
  {name:'lose-warning-after-reload',file:read,from:'capacityWarnings:await planningCapacityWarnings(plan)',to:'capacityWarnings:[]',integration:true},
  {name:'retain-removed-visit-warning',file:ui,from:' && visits.has(warning.visitId)',to:'',browser:true}
];
for(const item of cases) for(const propertyOnly of item.property?[false,true]:[false]) {
  const root=mkdtempSync('/app/test-artifacts/bin-weight-warning-mutant-');
  try {
    for(const name of ['src','test','package.json']) cpSync(name,`${root}/${name}`,{recursive:true});
    for(const name of ['node_modules','tools']) symlinkSync(`/app/${name}`,`${root}/${name}`);
    if(item.browser) cpSync('public',`${root}/public`,{recursive:true});
    else symlinkSync('/app/public',`${root}/public`);
    const source=readFileSync(item.file,'utf8');
    if(source.split(item.from).length!==2) throw new Error(`Mutation mismatch: ${item.name}`);
    writeFileSync(`${root}/${item.file}`,source.replace(item.from,item.to));
    const args=propertyOnly?['--test','test/mbt/property/bin-planning-properties.test.js']:
      ['/app/tools/bin-planning-suites.mjs','selected',item.browser?'test/mbt/integration/bin-weight-warning-browser.test.js':item.integration?'test/mbt/integration/bin-weight-warning.test.js':'test/mbt/unit/bin-planning-domain.test.js',
        ...(item.property?['test/mbt/property/bin-planning-properties.test.js']:[])];
    const run=spawnSync(process.execPath,args,{cwd:resolve(root),env:process.env,encoding:'utf8',timeout:90000,maxBuffer:8*1024*1024});
    const output=(run.stdout || '')+(run.stderr || '');
    const killed=run.status!==0 && (propertyOnly?/Property failed/u:/AssertionError|Weight blocked|Choose an active BIN truck/u).test(output) && !/SyntaxError|ERR_MODULE_NOT_FOUND/u.test(output);
    results.push({name:item.name,propertyOnly,killed});console.log(JSON.stringify(results.at(-1)));
    if(!killed) console.log(output.slice(-5000));
  } finally {rmSync(root,{recursive:true,force:true});}
}
if(files.some(file=>hash(file)!==before[file])) throw new Error('Mutation changed release source');
writeFileSync('test-artifacts/bin-weight-warning-mutations.json',JSON.stringify(results));
if(results.some(row=>!row.killed)) process.exitCode=1;
