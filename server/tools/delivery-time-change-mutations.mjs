import assert from 'node:assert/strict';
import {cpSync,mkdtempSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {buildIsolatedTestEnvironment} from '../test/support/test-foundation.mjs';
import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const scratch=mkdtempSync('/tmp/delivery-time-change-mutants-'),results=[];
const domain='src/delivery-request-domain.js';
const mutants=[
  {name:'replace approved time immediately',file:domain,from:'return {...row,pendingWindow:normalizeDeliveryWindow(input.window)};',to:'return {...row,confirmedWindow:normalizeDeliveryWindow(input.window),pendingWindow:normalizeDeliveryWindow(input.window)};'},
  {name:'accept without switching approved time',file:domain,from:'return {...row,confirmedWindow:normalizeDeliveryWindow(row.pendingWindow),pendingWindow:null};',to:'return {...row,pendingWindow:null};'},
  {name:'permit Sales acceptance',file:domain,from:"const dispatchActions = ['confirm', 'propose', 'accept-time-change', 'decline-time-change'];",to:"const dispatchActions = ['confirm', 'propose', 'decline-time-change'];"},
  {name:'keep SOs when cancelled',file:domain,from:"status:'cancelled',approvalExpiresAt:null,reminderAt:null,salesOrderRefs:[],pendingWindow:null",to:"status:'cancelled',approvalExpiresAt:null,reminderAt:null,pendingWindow:null"},
  {name:'allow a short requested slot',file:domain,from:'return {...row,pendingWindow:normalizeDeliveryWindow(input.window)};',to:'return {...row,pendingWindow:input.window};'},
  {name:'keep cancelled associations in database',file:'src/delivery-request-repository.js',from:"if (action==='cancel') {await query('DELETE FROM delivery_request_sales_orders WHERE request_id=$1',[id]);}",to:'',db:true},
  {name:'hide the time-change notification',file:'public/delivery-request-alert.js',from:"'request-time-change':'Sales requested",to:"'request-time-changed':'Sales requested",browser:true}
];
function runSuite(suite,environment,index) {
  const run=spawnSync(process.execPath,['--test','--test-name-pattern=time change:',suite],{cwd:scratch,env:environment,encoding:'utf8',timeout:90000,maxBuffer:5*1024*1024});
  const output=run.stdout+run.stderr;
  writeFileSync(`test-artifacts/time-change-mutant-${index}-${suite.split('/').at(-1)}.log`,output);
  return {layer:suite,killed:run.status===1 && /(?:not ok|✖)/u.test(output),exitCode:run.status};
}
try {
  for(const name of ['src','public','migrations','test/mbt','test/support']) {cpSync(name,`${scratch}/${name}`,{recursive:true});}
  cpSync('package.json',`${scratch}/package.json`);symlinkSync('/app/node_modules',`${scratch}/node_modules`,'dir');
  symlinkSync('/app/test-artifacts',`${scratch}/test-artifacts`,'dir');
  const environment=buildIsolatedTestEnvironment(process.env,{databaseUrl:process.env.DATABASE_URL});
  delete environment.DELIVERY_UI_COVERAGE;delete environment.NODE_V8_COVERAGE;
  for(const [index,mutant] of mutants.entries()) {
    const file=`${scratch}/${mutant.file}`,source=readFileSync(file,'utf8');assert.ok(source.includes(mutant.from),mutant.name);
    const outcomes=[];
    try {
      writeFileSync(file,source.replace(mutant.from,mutant.to));
      if(mutant.db) {
        const exitCode=await runNodeTestFilesIsolated([`${scratch}/test/mbt/integration/delivery-requests.test.js`],{environment,label:'Time change association mutant'});
        outcomes.push({layer:'integration',killed:exitCode===1});
      } else {
        const suites=mutant.browser?['test/mbt/integration/delivery-requests-browser.test.js']:
          ['test/mbt/unit/delivery-request-domain.test.js','test/mbt/property/delivery-request-domain.property.test.js'];
        outcomes.push(...suites.map(suite=>runSuite(suite,environment,index)));
      }
    } finally {writeFileSync(file,source);}
    assert.equal(readFileSync(file,'utf8'),source);results.push({name:mutant.name,outcomes,restored:true});
    process.stdout.write(`${mutant.name}: ${outcomes.every(outcome=>outcome.killed)?'KILLED':'SURVIVED'}\n`);
  }
} finally {rmSync(scratch,{recursive:true,force:true});writeFileSync('test-artifacts/time-change-mutations.json',JSON.stringify(results,null,2)+'\n');}
assert.equal(results.length,mutants.length);assert.ok(results.every(result=>result.outcomes.every(outcome=>outcome.killed)));
