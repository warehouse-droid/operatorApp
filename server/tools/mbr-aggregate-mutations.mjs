import {cpSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const domain='src/mbt/bin-transport-domain.js',availability='src/mbt/bin-availability-domain.js';
const properties='test/mbt/property/bin-transport.property.test.js';
const units=['test/mbt/unit/bin-transport-domain.test.js','test/mbt/unit/bin-availability.test.js'];
const mutations=[
  {name:'allow-extra-quantity',file:domain,from:'if (remaining<0n)',to:'if (remaining< -1000000n)'},
  {name:'reject-full-allocation',file:domain,from:'if (remaining<0n)',to:'if (remaining<=0n)'},
  {name:'ignore-known-cargo-weight',file:domain,from:'weight<estimated || ',to:''},
  {name:'allow-future-overlap',file:availability,from:'if (job.begin<finish)',to:'if (false)'},
  {name:'require-evidence-after-return',file:availability,from:'available:Boolean(job.release)',to:'available:false'},
];
const files=[domain,availability,properties,...units],hash=()=>createHash('sha256').update(files.map(f=>readFileSync(f)).join('')).digest('hex'),before=hash(),results=[];
for(const propertyOnly of [false,true]) for(const mutation of mutations) {
  const root=mkdtempSync('test-artifacts/mbr-aggregate-mutant-');
  try {
    for(const file of [...files,'package.json']) {mkdirSync(dirname(`${root}/${file}`),{recursive:true});cpSync(file,`${root}/${file}`);}
    symlinkSync('/app/node_modules',`${root}/node_modules`);
    const path=`${root}/${mutation.file}`,source=readFileSync(path,'utf8');
    if(source.split(mutation.from).length!==2) throw new Error(`Mutation mismatch ${mutation.name}`);
    writeFileSync(path,source.replace(mutation.from,mutation.to));
    const run=spawnSync(process.execPath,['--test',...[properties,...(propertyOnly?[]:units)].map(f=>resolve(root,f))],{encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
    const output=run.stdout+run.stderr;
    const killed=run.status!==0 && /Property failed/u.test(output) && !/SyntaxError|ERR_MODULE_NOT_FOUND/u.test(output);
    results.push({name:mutation.name,propertyOnly,killed});console.log(JSON.stringify(results.at(-1)));
    if(!killed) console.log(output.slice(-3000));
  } finally {rmSync(root,{recursive:true,force:true});}
}
if(before!==hash()) throw new Error('Source files changed during mutation checks');
writeFileSync('test-artifacts/mbr-aggregate-mutations.json',JSON.stringify(results));
if(results.some(row=>!row.killed)) process.exitCode=1;
