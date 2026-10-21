import {cpSync,symlinkSync,readFileSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

if(process.env.MBT_TEST_ISOLATED!=='1') {throw new Error('Mutation checks require disposable infrastructure.');}
const scratch='/tmp/delivery-transfer-mutations',artifact=process.cwd()+'/test-artifacts/mutations';
mkdirSync(artifact,{recursive:true});rmSync(scratch,{recursive:true,force:true});mkdirSync(scratch,{recursive:true});
for(const dir of ['src','public','test']) {cpSync(dir,`${scratch}/${dir}`,{recursive:true});}
for(const name of ['package.json','package-lock.json']) {cpSync(name,`${scratch}/${name}`);}
for(const name of ['node_modules','migrations','test-artifacts']) {symlinkSync(process.cwd()+'/'+name,`${scratch}/${name}`);}
const unit='test/mbt/unit/delivery-request-transfer-orders.test.js';
const integration='test/mbt/integration/delivery-request-transfer-orders.test.js';
const browser='test/mbt/integration/delivery-request-enhancements-browser.test.js';
const mutants=[
  ['Reject valid Transfer Order references','src/delivery-request-domain.js','/^(?:SO|TO)[A-Z0-9]','/^SO[A-Z0-9]',unit,true],
  ['Skip Transfer Order yard access','src/delivery-request-orders.js','if(![Number(row.from_location_id),Number(row.to_location_id)].includes(Number(yard)))','if(false)',integration,false],
  ['Admit inactive Transfer Orders','src/delivery-request-orders.js',' AND t.netsuite_active=true','',integration,false],
  ['Include duplicate receiving lines','src/delivery-request-orders.js'," AND line_stage='outbound'",'',integration,false],
  ['Load Sales Order instructions for Transfer Orders','public/delivery-requests.js',"return row.salesOrderRefs.filter(ref=>ref.startsWith('SO'));",'return row.salesOrderRefs;',browser,false],
  ['Disclose previews after an order is unlinked','src/delivery-request-repository.js','if(!current.salesOrderRefs.includes(ref))','if(false)',integration,false]
];
const results=[],hash=value=>createHash('sha256').update(value).digest('hex');
const run=(args,log)=>{
  const result=spawnSync(process.execPath,args,{cwd:scratch,encoding:'utf8',timeout:90000,maxBuffer:8*1024*1024,
    env:{...process.env,DELIVERY_UI_COVERAGE:'0',NODE_V8_COVERAGE:''}});
  const output=result.stdout+result.stderr;writeFileSync(`${artifact}/${log}.log`,output);
  return {killed:result.status===1 && !result.signal && /✖|not ok/u.test(output) && !/ERR_MODULE_NOT_FOUND|SyntaxError/u.test(output),exitCode:result.status};
};
try {
  for(const [index,[name,file,from,to,suite,property]] of mutants.entries()) {
    const target=`${scratch}/${file}`,original=readFileSync(target,'utf8');
    if(original.split(from).length!==2) {throw new Error('Mutation anchor is not unique: '+name);}
    try {
      writeFileSync(target,original.replace(from,to));
      const args=suite===integration?['--input-type=module','-e',`import {runNodeTestFilesIsolated} from './test/support/test-database-isolation.mjs';
        process.exitCode=await runNodeTestFilesIsolated([${JSON.stringify(suite)}],{label:'TO mutation'});`]
        :['--test','--test-reporter=spec',...(suite===browser?['--test-name-pattern=TO links:']:[]),suite];
      const result={name,...run(args,String(index+1))};
      if(property) {result.propertyOnly=run(['--test','--test-reporter=spec','--test-name-pattern=normalization preserves each',unit],`${index+1}-property`);}
      results.push(result);process.stdout.write(`${name}: ${result.killed?'KILLED':'SURVIVED'}\n`);
    } finally {writeFileSync(target,original);}
  }
} finally {
  const files=[...new Set(mutants.map(([,file])=>file))];
  const restored=files.every(file=>hash(readFileSync(file))===hash(readFileSync(`${scratch}/${file}`)));
  writeFileSync(`${artifact}/results.json`,JSON.stringify({mutants:results,restored},null,2)+'\n');
  rmSync(scratch,{recursive:true,force:true});
}
if(results.some(result=>!result.killed || (result.propertyOnly && !result.propertyOnly.killed))) {process.exitCode=1;}
