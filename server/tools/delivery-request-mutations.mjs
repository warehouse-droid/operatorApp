import { readFileSync,writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
if(process.env.MBT_TEST_ISOLATED!=='1') {throw new Error('Mutations require disposable isolated infrastructure.');}
const file='src/delivery-request-domain.js',original=readFileSync(file,'utf8');
const hash=value=>createHash('sha256').update(value).digest('hex');
const mutants=[
  ['round trips down','const trips = Math.ceil(yard.totalUnits / capacityPerTrip);','const trips = Math.floor(yard.totalUnits / capacityPerTrip);'],
  ['charge paired yards separately',"const paired = ['3445','2967'].includes(yard.originYardCode)",'const paired = false'],
  ['choose highest consolidation charge','left.totalAmountMinor-right.totalAmountMinor','right.totalAmountMinor-left.totalAmountMinor'],
  ['admit SO at expiry equality','instant >= new Date(row.approvalExpiresAt).getTime()','instant > new Date(row.approvalExpiresAt).getTime()'],
  ['keep secured approval clock','securedAt:options.now,approvalExpiresAt:null,reminderAt:null,reminderSentAt:null','securedAt:options.now,approvalExpiresAt:row.approvalExpiresAt,reminderAt:row.reminderAt,reminderSentAt:null'],
  ['skip requesting-yard permission','(actor?.yardLocationIds || []).map(Number).includes(Number(yard))','true'],
  ['admit public Sales','!actor?.id || actor.publicSales','!actor?.id'],
  ['ignore edited truck capacity',"positiveInteger(input?.pos, 'POS capacity', 10000)",'26'],
  ['ignore edited BIN capacity',"positiveInteger(input?.bin, 'BIN capacity', 10000)",'1']
];
const results=[];
try {
  for(const [index,[name,from,to]] of mutants.entries()) {
    if(!original.includes(from)) {throw new Error(`Mutation anchor changed: ${name}`);}
    writeFileSync(file,original.replace(from,to));
    const outcomes={};
    for(const [layer,suite] of [['unit','unit/delivery-request-domain.test.js'],['properties','property/delivery-request-domain.property.test.js']]) {
      const run=spawnSync(process.execPath,['--test',`test/mbt/${suite}`],{encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
      const output=run.stdout+run.stderr;
      writeFileSync(`test-artifacts/delivery-requests/mutant-${index+1}-${layer}.log`,output);
      outcomes[layer]={exit:run.status,killed:run.status!==0 && /(?:not ok|✖)/u.test(output),signal:run.signal};
    }
    writeFileSync(file,original);
    results.push({name,...outcomes});
    process.stdout.write(`${name}: unit ${outcomes.unit.killed?'KILLED':'SURVIVED'}, properties ${outcomes.properties.killed?'KILLED':'SURVIVED'}\n`);
  }
  for(const [target,suite,name,from,to] of [
    ['src/delivery-request-expiry.js','test/mbt/unit/delivery-request-expiry.test.js','allow overlapping expiry ticks','if (running) {return;}',''],
    ['src/delivery-request-expiry.js','test/mbt/unit/delivery-request-expiry.test.js','start duplicate expiry timers','if (timer) {return;}',''],
    ['src/delivery-request-router.js','test/mbt/unit/delivery-request-router.test.js','misclassify infrastructure errors as invalid requests','else {next(error);}',"else {res.status(400).json({error:error.message});}"],
    ['public/app-event-stream.js','test/mbt/integration/delivery-request-event-stream-browser.test.js','open a connection for every alert subscriber',',key=token;',',key=token+Math.random();'],
    ['public/app-event-stream.js','test/mbt/integration/delivery-request-event-stream-browser.test.js','close shared connection before last subscriber leaves','stream.subscribers===0','stream.subscribers>=0'],
    ['public/app-event-stream.js','test/mbt/integration/delivery-request-event-stream-browser.test.js','mix authenticated and anonymous event subscribers',',key=token;',",key='';"]
  ]) {
    const source=readFileSync(target,'utf8');
    if(!source.includes(from)) {throw new Error(`Mutation anchor changed: ${name}`);}
    try {
      writeFileSync(target,source.replace(from,to));
      const run=spawnSync(process.execPath,['--test',suite],{encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
      const output=run.stdout+run.stderr,killed=run.status!==0 && /(?:not ok|✖)/u.test(output);
      writeFileSync(`test-artifacts/delivery-requests/mutant-${results.length+1}-runtime.log`,output);
      results.push({name,runtime:{exit:run.status,killed,signal:run.signal}});
      process.stdout.write(`${name}: runtime ${killed?'KILLED':'SURVIVED'}\n`);
    } finally {writeFileSync(target,source);}
  }
} finally {
  writeFileSync(file,original);
  writeFileSync('test-artifacts/delivery-requests/mutations.json',JSON.stringify({sourceHash:hash(original),restored:hash(readFileSync(file))===hash(original),mutants:results},null,2)+'\n');
}
if(results.length!==mutants.length+6 || results.some(result=>result.runtime?!result.runtime.killed:(!result.unit.killed || !result.properties.killed))) {process.exitCode=1;}
