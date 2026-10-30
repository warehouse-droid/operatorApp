import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,cpSync,symlinkSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const file='public/backorder-add-items.js',source=readFileSync(file,'utf8');
const suite='test/mbt/property/backorder-add-items.property.test.js';
const mutants=[
  ['allow-other-workflow','isBackorder(request)','true'],
  ['allow-order-operation','canAddSpecialItems(request)','true'],
  ['allow-cancelled',"['submitted','active'].includes(request.status)",'true'],
  ['allow-manual-SO','!request.alreadyOrderedSalesOrderRef','true'],
  ['allow-101st-material','request.lines.length < 100','request.lines.length <= 100']
];
const root=resolve(mkdtempSync('test-artifacts/backorder-add-mutants-')),results=[];
try {
  cpSync('public',`${root}/public`,{recursive:true});mkdirSync(`${root}/test/mbt/property`,{recursive:true});
  cpSync('package.json',`${root}/package.json`);cpSync(suite,`${root}/${suite}`);symlinkSync('/app/node_modules',`${root}/node_modules`);
  for(const [name,from,to] of mutants) {
    if(source.split(from).length!==2)throw new Error(`Mutation anchor mismatch: ${name}`);
    writeFileSync(`${root}/${file}`,source.replace(from,to));
    const run=spawnSync(process.execPath,['--test',suite],{cwd:root,encoding:'utf8',timeout:30000});
    const output=run.stdout+run.stderr,killed=run.status!==0 && /AssertionError|Property failed/.test(output) && !/SyntaxError|ERR_MODULE_NOT_FOUND/.test(output);
    results.push({name,killed});if(!killed)console.log(output);
  }
}finally {rmSync(root,{recursive:true,force:true});}
if(readFileSync(file,'utf8')!==source)throw new Error('Mutation changed application source');
writeFileSync('test-artifacts/backorder-add-items-mutations.json',JSON.stringify(results));console.log(JSON.stringify(results));
if(results.some(row=>!row.killed))process.exitCode=1;
