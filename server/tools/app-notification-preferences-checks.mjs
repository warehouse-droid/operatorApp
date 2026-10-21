import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {buildIsolatedTestEnvironment} from '../test/support/test-foundation.mjs';
import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';

if(process.env.MBT_TEST_ISOLATED!=='1') {throw new Error('Bounded disposable infrastructure is required.');}
const mode=process.argv[2] || 'final';
for(const path of ['test-artifacts/delivery-requests-ui','/tmp/mbbs-test-config','/tmp/mbbs-test-cache']) {mkdirSync(path,{recursive:true});}
const focused=['app-notification-preferences-browser','app-notification-attention-browser','app-notifications-browser']
  .map(name=>`test/mbt/integration/${name}.test.js`);
const files=[...focused,...[
  'delivery-request-event-stream-browser','delivery-requests-browser',
  'special-po-reference-browser','special-delivery-method-browser','regular-stock-resolution-browser',
  'special-sales-alert-browser','aggregate-request-alert-browser','special-stock-alert-browser'
].map(name=>`test/mbt/integration/${name}.test.js`)];
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const runtimeHashes=Object.fromEntries(['public/app-notifications.js','public/app-sidebar.js'].map(file=>[file,hash(file)]));
const environment={...buildIsolatedTestEnvironment(process.env,{databaseUrl:process.env.DATABASE_URL || ''}),
  XDG_CONFIG_HOME:'/tmp/mbbs-test-config',XDG_CACHE_HOME:'/tmp/mbbs-test-cache',DELIVERY_UI_COVERAGE:'1',
  MBBS_PREFERENCES_SCREENSHOT:'/app/test-artifacts/preferences-mobile.png'};
if(mode==='green') {
  const result=spawnSync(process.execPath,['--test','--test-concurrency=1',...focused],{encoding:'utf8',env:environment,maxBuffer:16*1024*1024});
  writeFileSync('test-artifacts/runtime-hashes.json',JSON.stringify(runtimeHashes,null,2)+'\n');
  process.stdout.write(result.stdout+result.stderr);process.exit(result.status || 0);
}
let seed=15102026;
for(let i=files.length-1;i>0;i--) {seed=(Math.imul(seed,1664525)+1013904223)>>>0;const j=seed%(i+1);[files[i],files[j]]=[files[j],files[i]];}
writeFileSync('test-artifacts/suite-order.json',JSON.stringify({seed:15102026,files},null,2)+'\n');
if(mode==='suite-only') {
  process.exitCode=await runNodeTestFilesIsolated(files,{environment,label:'Personal notification preferences'});
} else {
  for(const file of ['public/app-sidebar.js','public/app-notifications.js']) {
    const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
    if(result.status!==0) {process.stdout.write(result.stdout+result.stderr);process.exit(result.status || 1);}
  }
  const lint=spawnSync('node_modules/.bin/eslint',['--config','tools/app-notification-attention-eslint.config.mjs','--max-warnings=0',
    'public/app-notifications.js',...focused,'tools/app-notification-preferences-checks.mjs'],{encoding:'utf8',maxBuffer:16*1024*1024});
  writeFileSync('test-artifacts/lint.log',lint.stdout+lint.stderr);process.stdout.write(`lint: ${lint.status}\n`);
  if(lint.status!==0) {process.stdout.write(lint.stdout+lint.stderr);process.exit(lint.status || 1);}
  const result=spawnSync(process.execPath,['tools/app-notification-preferences-checks.mjs','suite-only'],{encoding:'utf8',maxBuffer:64*1024*1024,env:environment});
  const output=result.stdout+result.stderr;writeFileSync('test-artifacts/tests.log',output);
  const failed=[...new Set([...output.matchAll(/^✖ (.+) \([\d.]+ms\)$/gm)].map(match=>match[1]))].sort();
  const baseline=JSON.parse(readFileSync('tools/delivery-timeslot-notifications-baseline.json','utf8'));
  const unchanged=Object.entries(baseline.testSourceHashes).every(([file,sha])=>hash(file)===sha);
  const known=unchanged && failed.length===baseline.failedTests.length && failed.every((name,i)=>name===baseline.failedTests[i]);
  const count=name=>[...output.matchAll(new RegExp(`^ℹ ${name} (\\d+)$`,'gm'))].reduce((total,match)=>total+Number(match[1]),0);
  const report={tests:count('tests'),passed:count('pass'),failed:count('fail'),skipped:count('skipped'),failedTests:failed,knownBaselineFailures:known,rawExitCode:result.status,runtimeHashes};
  writeFileSync('test-artifacts/test-results.json',JSON.stringify(report,null,2)+'\n');process.stdout.write(JSON.stringify(report)+'\n');
  process.exitCode=result.status===0 || (result.status===1 && known)?0:1;
  if(process.exitCode) {process.stdout.write(output.slice(-14000));}
}
