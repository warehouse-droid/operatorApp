import {cpSync,mkdtempSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
const mutations=[
  {name:'allow-ordinary-source-claim',file:'src/mbt/bin-transport-sources.js',from:'if (assigned.rowCount)',to:'if (false)',test:'bin-transport-ownership'},
  {name:'allow-independent-group',file:'src/mbt/bin-transport-sources.js',
    from:'if (order.isGrouped || order.globalGroupDefinition || (order.childOrders || []).length>1)',to:'if (false)',test:'bin-transport-ownership'},
  {name:'skip-linked-cargo-drop-evidence',file:'src/mbt/bin-transport-delivery.js',from:'if (!id) {return;}',to:'if (true) {return;}',test:'bin-transport-linked-delivery'}
];
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const before=Object.fromEntries(mutations.map(m=>[m.file,hash(m.file)])),results=[];
for(const mutation of mutations) {
  const root=mkdtempSync('/app/test-artifacts/mbr-aggregate-guard-mutant-');
  try {
    for(const name of ['src','test','package.json']) cpSync(name,`${root}/${name}`,{recursive:true});
    for(const name of ['node_modules','tools','public']) symlinkSync(`/app/${name}`,`${root}/${name}`);
    const path=`${root}/${mutation.file}`,source=readFileSync(path,'utf8');
    if(source.split(mutation.from).length!==2) throw new Error(`Mutation mismatch ${mutation.name}`);
    writeFileSync(path,source.replace(mutation.from,mutation.to));
    const run=spawnSync(process.execPath,['/app/tools/bin-planning-suites.mjs','selected',`test/mbt/integration/${mutation.test}.test.js`],
      {cwd:resolve(root),env:process.env,encoding:'utf8',timeout:90000,maxBuffer:8*1024*1024});
    const output=(run.stdout || '')+(run.stderr || '');
    const killed=run.status!==0 && /Missing expected rejection/u.test(output) && !/SyntaxError|ERR_MODULE_NOT_FOUND/u.test(output);
    results.push({name:mutation.name,killed});console.log(JSON.stringify(results.at(-1)));
    if(!killed) console.log(output.slice(-5000));
  } finally {rmSync(root,{recursive:true,force:true});}
}
if(Object.entries(before).some(([file,expected])=>hash(file)!==expected)) throw new Error('Mutation changed release sources');
writeFileSync('test-artifacts/mbr-aggregate-guard-mutations.json',JSON.stringify(results));
if(results.some(row=>!row.killed)) process.exitCode=1;
