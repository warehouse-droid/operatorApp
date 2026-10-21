import {cpSync,symlinkSync,readFileSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

if(process.env.MBT_TEST_ISOLATED!=='1') {throw new Error('Mutation verification requires disposable infrastructure.');}
const scratch='/tmp/delivery-enhancements-mutations',artifact=process.cwd()+'/test-artifacts/mutations';
mkdirSync(artifact,{recursive:true});rmSync(scratch,{recursive:true,force:true});mkdirSync(scratch,{recursive:true});
for(const dir of ['src','public','test']) {cpSync(dir,`${scratch}/${dir}`,{recursive:true});}
for(const name of ['package.json','package-lock.json']) {cpSync(name,`${scratch}/${name}`);}
symlinkSync(process.cwd()+'/node_modules',`${scratch}/node_modules`);symlinkSync(process.cwd()+'/migrations',`${scratch}/migrations`);
symlinkSync(process.cwd()+'/test-artifacts',`${scratch}/test-artifacts`);
const unit='test/mbt/unit/delivery-request-enhancements.test.js',documents='test/mbt/unit/delivery-request-documents.test.js',browser='test/mbt/integration/delivery-request-enhancements-browser.test.js';
const integration='test/mbt/integration/delivery-request-enhancements.test.js';
const mutants=[
  ['omit loose pallets','src/delivery-request-domain.js','positiveInteger(fullPosQty+loosePosQty,','positiveInteger(fullPosQty,',unit,true],
  ['count Yard quantities as BIN counts','src/delivery-request-domain.js',"return pricing.quantityUnit==='yard'?Math.round(capacity*(pricing.binCapacityYards ?? 0)*100)/100:capacity;",'return capacity;',unit,true],
  ['allow blank replies','src/delivery-request-domain.js',"typeof value!=='string' || !value.trim() || value.trim().length>2000","typeof value!=='string' || value.trim().length>2000",unit,false],
  ['skip EST yard authorization','src/delivery-request-documents.js','if(Number(found.location)!==yard)','if(false)',documents,false],
  ['accept a different estimate record','src/delivery-request-documents.js',"Number(record?.id)!==identity.id || ",'',documents,false],
  ['confirm when sending a reply','public/delivery-requests.js',"await executeAction('reply',{message});","await executeAction('confirm',{message});",browser,false],
  ['reject valid BIN quantities','src/delivery-request-domain.js',"value!==Math.round(value*100)/100","value===Math.round(value*100)/100",unit,true],
  ['write instead of reading the estimate','src/netsuite.js',"rest(`/record/v1/estimate/${id}?expandSubResources=true`, { method: 'GET' })","rest(`/record/v1/estimate/${id}?expandSubResources=true`, { method: 'POST' })",documents,false],
  ['display unit IDs instead of labels','src/delivery-request-documents.js','return {...line,units:{refName:label}};','return line;',documents,false],
  ['admit system authors to the conversation','src/delivery-request-repository.js',"if(!['sales','dispatch'].includes(mapped.audience)) {return null;}",'if(false) {return null;}',integration,false],
  ['show audit summaries instead of human comments','src/delivery-request-repository.js','String(event.conversation_message ?? legacy).trim()','String(event.message).trim()',integration,false],
  ['retain generated legacy summaries','src/delivery-request-repository.js','event.message.slice(automatic.length)','event.message',integration,false],
  ['replay a stale cached conversation','src/delivery-request-repository.js','return {...result,conversation:await loadConversation(result)};','return result;',integration,false],
  ['include later messages in an older retry','src/delivery-request-repository.js','AND event.revision<=$2','AND ($2::int IS NOT NULL)',integration,false],
  ['render system and blank browser messages','public/delivery-requests.js',"(row.conversation || []).filter(event=>['sales','dispatch'].includes(event.audience) && event.message?.trim())",'(row.conversation || [])',browser,false],
  ['stop after one legacy event batch','src/delivery-request-repository.js','revision=batch.rows.at(-1).revision-1;','return messages.slice(0,200).reverse();',integration,false]
];
const results=[];
try {
  for(const [index,[name,file,from,to,suite,property]] of mutants.entries()) {
    const target=`${scratch}/${file}`,original=readFileSync(target,'utf8');
    if(original.split(from).length!==2) {throw new Error(`Mutation anchor is not unique: ${name}`);}
    try {
      writeFileSync(target,original.replace(from,to));
      const args=suite===integration?['--input-type=module','-e',`import {runNodeTestFilesIsolated} from './test/support/test-database-isolation.mjs';
        process.exitCode=await runNodeTestFilesIsolated([${JSON.stringify(suite)}],{environment:process.env,label:'Conversation mutation'});`]
        :['--test','--test-reporter=spec',suite];
      const result=spawnSync(process.execPath,args,{cwd:scratch,encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024,
        env:{...process.env,DELIVERY_UI_COVERAGE:'0',NODE_V8_COVERAGE:''}});
      const output=result.stdout+result.stderr;
      writeFileSync(`${artifact}/${index+1}.log`,output);
      const killed=result.status!==0 && /✖|not ok/u.test(output) && !/ERR_MODULE_NOT_FOUND/u.test(output);
      const detail={name,killed,exitCode:result.status,propertyOnly:null};
      if(property) {
        const generated=spawnSync(process.execPath,['--test','--test-reporter=spec','--test-name-pattern=generated POS and BIN',unit],{cwd:scratch,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024,
          env:{...process.env,DELIVERY_UI_COVERAGE:'0',NODE_V8_COVERAGE:''}});
        writeFileSync(`${artifact}/${index+1}-properties.log`,generated.stdout+generated.stderr);
        detail.propertyOnly={killed:generated.status!==0 && /✖|not ok/u.test(generated.stdout+generated.stderr),exitCode:generated.status};
      }
      results.push(detail);process.stdout.write(`${name}: ${killed?'KILLED':'SURVIVED'}\n`);
    } finally {writeFileSync(target,original);}
  }
} finally {
  const files=[...new Set(mutants.map(([,file])=>file))];
  const hash=value=>createHash('sha256').update(value).digest('hex');
  const restored=files.every(file=>hash(readFileSync(file))===hash(readFileSync(`${scratch}/${file}`)));
  writeFileSync(`${artifact}/results.json`,JSON.stringify({mutants:results,restored},null,2)+'\n');
  rmSync(scratch,{recursive:true,force:true});
}
if(results.some(result=>!result.killed || (result.propertyOnly && !result.propertyOnly.killed))) {process.exitCode=1;}
