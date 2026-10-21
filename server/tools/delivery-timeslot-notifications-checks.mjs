import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {buildIsolatedTestEnvironment} from '../test/support/test-foundation.mjs';
import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';

if(process.env.MBT_TEST_ISOLATED!=='1') {throw new Error('Disposable isolated infrastructure is required.');}
const mode=process.argv[2] || 'final';
mkdirSync('test-artifacts/delivery-requests-ui',{recursive:true});mkdirSync('test-artifacts/delivery-requests',{recursive:true});
const delivery=['unit/delivery-request-domain','unit/delivery-request-expiry','unit/delivery-request-router',
  'property/delivery-request-domain.property','integration/delivery-requests','integration/delivery-requests-http',
  'integration/delivery-request-planning','integration/delivery-requests-browser','integration/delivery-request-event-stream-browser',
  'integration/delivery-request-cards-browser','unit/delivery-request-enhancements','unit/delivery-request-documents',
  'integration/delivery-request-enhancements','integration/delivery-request-enhancements-browser'];
const additions=['unit/delivery-timeslot-counter','unit/delivery-request-trips','integration/app-notifications-browser'];
const alerts=['integration/special-po-reference-browser','integration/special-delivery-method-browser',
  'integration/regular-stock-resolution-browser','integration/special-sales-alert-browser',
  'integration/aggregate-request-alert-browser','integration/special-stock-alert-browser'];
const selected=mode==='baseline-alerts'?['integration/regular-stock-resolution-browser','integration/special-stock-alert-browser']
  :mode==='red'?['integration/delivery-requests','integration/delivery-requests-browser',...additions]:[...delivery,...additions,...alerts];
const files=selected
  .map(name=>`test/mbt/${name}.test.js`);
if(mode==='final') {
  for(const file of ['public/app-sidebar.js','public/regular-stock-alert.js','public/special-delivery-method-alert.js','public/special-po-reference-alert.js']) {
    const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
    if(result.status!==0) {process.stdout.write(result.stdout+result.stderr);process.exit(result.status || 1);}
  }
  for(const [name,binary,args] of [
    ['types','node_modules/.bin/tsc',['--project','tools/tsconfig.delivery-requests.json','--noEmit']],
    ['lint','node_modules/.bin/eslint',['--config','tools/delivery-timeslot-notifications-eslint.config.mjs','--max-warnings=0',
      'src/delivery-request-domain.js','src/delivery-request-repository.js','public/delivery-requests.js','public/delivery-request-alert.js',
      'public/app-notifications.js','public/app-notification-worker.js','test/mbt/unit/delivery-timeslot-counter.test.js',
      'test/mbt/unit/delivery-request-trips.test.js','test/mbt/integration/app-notifications-browser.test.js','tools/delivery-timeslot-notifications-checks.mjs','tools/delivery-timeslot-notifications-mutations.mjs']],
    ['versions',process.execPath,['tools/delivery-request-quality.mjs','versions']]
  ]) {
    const result=spawnSync(binary,args,{encoding:'utf8',maxBuffer:16*1024*1024});
    writeFileSync(`test-artifacts/${name}.log`,result.stdout+result.stderr);
    process.stdout.write(`${name}: ${result.status}\n`);
    if(result.status!==0) {process.stdout.write(result.stdout+result.stderr);process.exit(result.status || 1);}
  }
}
let seed=14102026;
for(let index=files.length-1;index>0;index--) {seed=(Math.imul(seed,1664525)+1013904223)>>>0;const next=seed%(index+1);[files[index],files[next]]=[files[next],files[index]];}
writeFileSync('test-artifacts/suite-order.json',JSON.stringify({seed:14102026,files},null,2)+'\n');
const environment=buildIsolatedTestEnvironment(process.env,{databaseUrl:process.env.DATABASE_URL || ''});
mkdirSync('/tmp/mbbs-test-config',{recursive:true});mkdirSync('/tmp/mbbs-test-cache',{recursive:true});
if(mode==='final') {
  const suite=spawnSync(process.execPath,['tools/delivery-timeslot-notifications-checks.mjs','suite-only'],{encoding:'utf8',maxBuffer:64*1024*1024});
  const output=suite.stdout+suite.stderr;writeFileSync('test-artifacts/tests.log',output);
  const failed=[...new Set([...output.matchAll(/^✖ (.+) \([\d.]+ms\)$/gm)].map(match=>match[1]))].sort();
  const baseline=JSON.parse(readFileSync('tools/delivery-timeslot-notifications-baseline.json','utf8'));
  const unchanged=Object.entries(baseline.testSourceHashes).every(([file,hash])=>createHash('sha256').update(readFileSync(file)).digest('hex')===hash);
  const known=failed.length===baseline.failedTests.length && failed.every((name,index)=>name===baseline.failedTests[index]) && unchanged;
  const count=name=>[...output.matchAll(new RegExp(`^ℹ ${name} (\\d+)$`,'gm'))].reduce((sum,match)=>sum+Number(match[1]),0);
  const report={tests:count('tests'),passed:count('pass'),failed:count('fail'),failedTests:failed,knownBaselineFailures:known,exitCode:suite.status};
  writeFileSync('test-artifacts/test-results.json',JSON.stringify(report,null,2)+'\n');process.stdout.write(JSON.stringify(report)+'\n');
  process.exitCode=suite.status===0 || (suite.status===1 && known)?0:1;
  if(process.exitCode) {process.stdout.write(output.slice(-10000));}
} else {
  process.exitCode=await runNodeTestFilesIsolated(files,{environment:{...environment,XDG_CONFIG_HOME:'/tmp/mbbs-test-config',XDG_CACHE_HOME:'/tmp/mbbs-test-cache',DELIVERY_UI_COVERAGE:mode==='suite-only'?'1':'0'},label:`Delivery timeslot notifications ${mode}`});
}
if(mode==='final' && !process.exitCode) {
  const result=spawnSync(process.execPath,['tools/delivery-timeslot-notifications-mutations.mjs'],{encoding:'utf8',maxBuffer:16*1024*1024});
  writeFileSync('test-artifacts/mutations.log',result.stdout+result.stderr);process.stdout.write(result.stdout+result.stderr);process.exitCode=result.status || 0;
}
