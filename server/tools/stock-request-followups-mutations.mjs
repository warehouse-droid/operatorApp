import {cpSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const service='src/regular-stock-request-service.js',quantity='src/stock-check/request-checks.js',yard='src/regular-stock-resolution.js',backorder='src/backorder-request-service.js';
const originals=Object.fromEntries([service,quantity,yard,backorder].map(file=>[file,readFileSync(file,'utf8')]));
const mutations=[
 ['reject-expired-blocked',service,"const expiredReject=decision==='reject'","const expiredReject=false && decision==='reject'"],
 ['one-pallet-default',quantity,"{kind:'stock_test',productId,quantity},actor","{kind:'stock_test',productId,quantity:1},actor"],
 ['skip-yard-completion',yard,"for(const line of selected){","for(const line of []){"],
 ['leave-customer-pending',backorder,"SET sales_decision='accepted',","SET sales_decision='pending',"]
];
const suites=['integration/stock-request-followups.test.js','property/stock-request-followups.property.test.js'];
const root=resolve(mkdtempSync('test-artifacts/current-action-mutants-')),results=[];
try {
  for(const folder of ['src','public','migrations']) cpSync(folder,`${root}/${folder}`,{recursive:true});
  cpSync('package.json',`${root}/package.json`);
  cpSync('test/mbt/helpers',`${root}/test/mbt/helpers`,{recursive:true});symlinkSync('/app/node_modules',`${root}/node_modules`);
  for(const suite of suites) {
    const file=`test/mbt/${suite}`;mkdirSync(`${root}/test/mbt/${suite.split('/')[0]}`,{recursive:true});cpSync(file,`${root}/${file}`);
  }
  for(const propertyOnly of [false,true]) for(const [name,target,from,to] of mutations) {
    for(const [file,source] of Object.entries(originals)) writeFileSync(`${root}/${file}`,source);
    if(originals[target].split(from).length!==2) throw new Error(`Mutation anchor mismatch: ${name}`);
    writeFileSync(`${root}/${target}`,originals[target].replace(from,to));
    const files=suites.filter(file=>!propertyOnly || file.startsWith('property/')).map(file=>`test/mbt/${file}`);
    const code=`import {runNodeTestFilesIsolated} from '/app/test/support/test-database-isolation.mjs'; process.exitCode=await runNodeTestFilesIsolated(${JSON.stringify(files)},{label:'current-action-mutant'});`;
    const run=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:root,encoding:'utf8',timeout:90000,maxBuffer:8*1024*1024});
    const output=run.stdout+run.stderr,killed=run.status!==0 && /AssertionError|Property failed/.test(output) && !/SyntaxError|ERR_MODULE_NOT_FOUND/.test(output);
    results.push({name,propertyOnly,killed});console.log(JSON.stringify(results.at(-1)));
    if(!killed) console.log(output.slice(-4000));
  }
} finally {rmSync(root,{recursive:true,force:true});}
for(const [file,source] of Object.entries(originals)) if(readFileSync(file,'utf8')!==source) throw new Error('Mutation modified release source');
writeFileSync('test-artifacts/stock-request-followups-mutations.json',JSON.stringify(results));
if(results.some(result=>!result.killed)) process.exitCode=1;
