import {cpSync,mkdtempSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
const file='src/mbt/bin-transport-domain.js',source=readFileSync(file,'utf8');
const hash=()=>createHash('sha256').update(readFileSync(file)).digest('hex'),before=hash(),results=[];
const cases=[
  {name:'hide-validation-error',from:'return new MbtError({status:409,code,message})',to:"return new MbtError({status:500,code:'MBT_INTERNAL_ERROR',message:'An unexpected error occurred.'})"},
  {name:'hide-missing-capacity',from:'if (!Number.isFinite(maximum) || maximum<=0)',to:'if (false)'},
  {name:'allow-understated-weight',from:'if (weight<estimated)',to:'if (false)',property:true},
  {name:'allow-excess-weight',from:'if (weight>maximum)',to:'if (false)',property:true}
];
for(const item of cases) for(const propertyOnly of item.property?[false,true]:[false]) {
  const root=mkdtempSync('/app/test-artifacts/transport-errors-mutant-');
  try {
    for(const name of ['src','test','package.json']) cpSync(name,`${root}/${name}`,{recursive:true});
    for(const name of ['node_modules','tools','public']) symlinkSync(`/app/${name}`,`${root}/${name}`);
    if(source.split(item.from).length!==2) throw new Error(`Mutation mismatch: ${item.name}`);
    writeFileSync(`${root}/${file}`,source.replace(item.from,item.to));
    const args=propertyOnly?['--test','test/mbt/property/bin-transport.property.test.js']:
      ['/app/tools/bin-planning-suites.mjs','selected','test/mbt/integration/bin-transport-errors.test.js'];
    const run=spawnSync(process.execPath,args,{cwd:resolve(root),env:process.env,encoding:'utf8',timeout:90000,maxBuffer:8*1024*1024});
    const output=(run.stdout || '')+(run.stderr || '');
    const killed=run.status!==0 && (propertyOnly?/Property failed/u:/AssertionError/u).test(output) && !/SyntaxError|ERR_MODULE_NOT_FOUND/u.test(output);
    results.push({name:item.name,propertyOnly,killed});console.log(JSON.stringify(results.at(-1)));
    if(!killed) console.log(output.slice(-5000));
  } finally {rmSync(root,{recursive:true,force:true});}
}
if(hash()!==before) throw new Error('Mutation changed release source');
writeFileSync('test-artifacts/transport-errors-mutations.json',JSON.stringify(results));
if(results.some(row=>!row.killed)) process.exitCode=1;
