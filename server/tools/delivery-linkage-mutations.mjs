import assert from 'node:assert/strict';
import {cpSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {buildIsolatedTestEnvironment} from '../test/support/test-foundation.mjs';
import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const scratch=mkdtempSync('/tmp/delivery-linkage-mutants-'),results=[];
const domain='src/delivery-request-domain.js';
const mutants=[
  {name:'ignore exchange',file:domain,from:'return {...row,salesOrderRefs:normalizeSalesOrderReferences(input.salesOrderRefs)};',to:'return {...row};',properties:true},
  {name:'permit empty last link',file:domain,from:'return {...row,salesOrderRefs:normalizeSalesOrderReferences(input.salesOrderRefs)};',to:'return {...row,salesOrderRefs:input.salesOrderRefs.length ? normalizeSalesOrderReferences(input.salesOrderRefs) : []};',properties:true},
  {name:'permit Dispatch relink',file:domain,from:"'counter', 'secure', 'relink', 'reraise'",to:"'counter', 'secure', 'reraise'",properties:true},
  {name:'keep default SO end time',file:'src/delivery-request-repository.js',from:'next.windowEnd=approval.window.end;',to:'',db:true,suite:'test/mbt/integration/delivery-request-planning.test.js'},
  {name:'discard original timing in compact cards',file:'src/dispatch-planner-optimization.js',from:'"windowEnd", "deliveryRequestOriginalWindow",',to:'"windowEnd",',db:true,suite:'test/mbt/integration/delivery-request-planning.test.js'},
  {name:'clear popup on browser restore',file:'public/delivery-request-alert.js',from:'if(current!==session) {stop();session=current;}',to:'if(current!==session || force) {stop();session=current;}',suite:'test/mbt/integration/delivery-request-event-stream-browser.test.js',pattern:'restore:'},
  {name:'expose linkage editor to Dispatch',file:'public/delivery-requests.js',from:"editableSales && row.status==='confirmed'?",to:"row.status==='confirmed'?",suite:'test/mbt/integration/delivery-requests-browser.test.js',pattern:'linkage: Dispatch'}
];
function runSuite(suite,mutant,environment,index) {
  const args=['--test',...(mutant.pattern?[`--test-name-pattern=${mutant.pattern}`]:[]),suite];
  const run=spawnSync(process.execPath,args,{cwd:scratch,env:environment,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
  const output=run.stdout+run.stderr;
  writeFileSync(`test-artifacts/mutant-${index}-${suite.split('/').at(-1)}.log`,output);
  return {layer:suite,killed:run.status===1 && /(?:not ok|✖)/u.test(output),exitCode:run.status};
}
try {
  for(const name of ['src','public','test/mbt','test/support']) {cpSync(name,`${scratch}/${name}`,{recursive:true});}
  cpSync('package.json',`${scratch}/package.json`);symlinkSync('/app/node_modules',`${scratch}/node_modules`,'dir');
  symlinkSync('/app/test-artifacts',`${scratch}/test-artifacts`,'dir');
  const environment=buildIsolatedTestEnvironment(process.env,{databaseUrl:process.env.DATABASE_URL || ''});
  delete environment.DELIVERY_UI_COVERAGE;delete environment.NODE_V8_COVERAGE;
  for(const [index,mutant] of mutants.entries()) {
    const file=`${scratch}/${mutant.file}`,source=readFileSync(file,'utf8');assert.ok(source.includes(mutant.from),mutant.name);
    const digest=createHash('sha256').update(source).digest('hex');
    const outcomes=[];
    try {
      writeFileSync(file,source.replace(mutant.from,mutant.to));
      if(mutant.db) {
        const exitCode=await runNodeTestFilesIsolated([`${scratch}/${mutant.suite}`],{environment,label:`mutant-${index}`});
        outcomes.push({layer:'integration',killed:exitCode!==0});
      } else {
        const suites=mutant.properties?['test/mbt/unit/delivery-request-domain.test.js','test/mbt/property/delivery-request-domain.property.test.js']:[mutant.suite];
        outcomes.push(...suites.map(suite=>runSuite(suite,mutant,environment,index)));
      }
    } finally {writeFileSync(file,source);}
    assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'),digest);
    results.push({name:mutant.name,outcomes,restored:true});
    process.stdout.write(`${mutant.name}: ${outcomes.every(outcome=>outcome.killed)?'KILLED':'SURVIVED'}\n`);
  }
} finally {
  rmSync(scratch,{recursive:true,force:true});mkdirSync('test-artifacts',{recursive:true});
  writeFileSync('test-artifacts/mutations.json',JSON.stringify(results,null,2)+'\n');
}
assert.equal(results.length,mutants.length);assert.ok(results.every(result=>result.outcomes.every(outcome=>outcome.killed)));
