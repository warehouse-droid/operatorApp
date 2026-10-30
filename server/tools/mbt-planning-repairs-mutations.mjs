import {cpSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const target='src/mbt/frontdesk-service.js',original=readFileSync(target,'utf8');
const mutations=[
  ['edit-issued',"if (before.status !== 'draft')",'if (false)'],
  ['ignore-revision','  if (before.revision !== expectedRevision) {\n    throw failure','  if (false) {\n    throw failure'],
  ['change-customer','if (before.customerNetsuiteId !== customerId)','if (false)'],
  ['retain-old-draft-charge',"SET status='cancelled',revision=revision+1", "SET status='draft',revision=revision+1"]
];
const root=resolve(mkdtempSync('test-artifacts/quote-mutants-')),results=[];
try {
  for(const folder of ['src','test/mbt/support']) cpSync(folder,`${root}/${folder}`,{recursive:true});
  cpSync('package.json',`${root}/package.json`);symlinkSync('/app/node_modules',`${root}/node_modules`);
  symlinkSync('/app/public',`${root}/public`);
  for(const suite of ['integration/frontdesk-quote-edit.test.js','property/frontdesk-quote-edit.property.test.js']) {
    const file=`test/mbt/${suite}`;mkdirSync(`${root}/test/mbt/${suite.split('/')[0]}`,{recursive:true});cpSync(file,`${root}/${file}`);
  }
  for(const propertyOnly of [false,true]) for(const [name,from,to] of mutations) {
    if(original.split(from).length!==2) throw new Error(`Mutation anchor mismatch: ${name}`);
    writeFileSync(`${root}/${target}`,original.replace(from,to));
    const files=[...(propertyOnly?[]:['test/mbt/integration/frontdesk-quote-edit.test.js']),'test/mbt/property/frontdesk-quote-edit.property.test.js'];
    const code=`import {runNodeTestFilesIsolated} from '/app/test/support/test-database-isolation.mjs'; process.exitCode=await runNodeTestFilesIsolated(${JSON.stringify(files)},{label:'quote-mutant'});`;
    const run=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:root,encoding:'utf8',timeout:90000,maxBuffer:8*1024*1024});
    const output=run.stdout+run.stderr,killed=run.status!==0 && /AssertionError|Property failed/.test(output) && !/SyntaxError|ERR_MODULE_NOT_FOUND/.test(output);
    results.push({name,propertyOnly,killed});console.log(JSON.stringify(results.at(-1)));
    if(!killed) console.log(output.slice(-4000));
  }
} finally {rmSync(root,{recursive:true,force:true});}
if(readFileSync(target,'utf8')!==original) throw new Error('Mutation modified the release source');
writeFileSync('test-artifacts/mbt-planning-repairs-mutations.json',JSON.stringify(results));
if(results.some(result=>!result.killed)) process.exitCode=1;
