import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';

if(process.env.MBT_TEST_ISOLATED!=='1') {throw new Error('Run in the bounded disposable test environment.');}
const mode=process.argv[2] || 'focused';
const files=mode==='baseline'?['special-stock-alert-browser']:['app-notification-roles-sounds-browser','app-notification-preferences-browser','app-notification-attention-browser','app-notifications-browser'];
if(mode==='regression') {files.push('delivery-request-event-stream-browser','special-po-reference-browser','special-delivery-method-browser','special-sales-alert-browser','aggregate-request-alert-browser','special-stock-alert-browser','stock-request-conversation-browser');}
const tests=files.map(name=>`test/mbt/integration/${name}.test.js`);
const runtime=['app-alert-sound.js','app-notifications.js','app-sidebar.js','delivery-request-alert.js','regular-stock-alert.js','special-delivery-method-alert.js','special-po-reference-alert.js','sales-special-alert.js','stock-request-conversation-alert.js','operator.js','operator.html'].map(name=>'public/'+name);
const hashes=Object.fromEntries(runtime.map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
mkdirSync('test-artifacts/delivery-requests-ui',{recursive:true});
for(const file of runtime.filter(name=>name.endsWith('.js'))) {
  const syntax=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
  if(syntax.status!==0) {process.stderr.write(syntax.stderr);process.exit(1);}
}
const lint=spawnSync('node_modules/.bin/eslint',['--config','tools/app-notification-attention-eslint.config.mjs','--max-warnings=0',
  'public/app-notifications.js','public/app-alert-sound.js','test/mbt/integration/app-notification-roles-sounds-browser.test.js','tools/app-notification-roles-sounds-checks.mjs'],{encoding:'utf8',maxBuffer:16*1024*1024});
const lintOutput=(lint.stdout || '')+(lint.stderr || '')+(lint.error?.stack || '');
writeFileSync('test-artifacts/lint.log',lintOutput);
process.stdout.write(lintOutput);
// Run behavioral checks even when a static check needs correction.
const pattern=mode==='baseline'?['--test-name-pattern=^Wait for Transfer requires ETA, sends the date, and keeps the selection after saving$']:[];
const result=spawnSync(process.execPath,['--test','--test-concurrency=1',...pattern,...tests],{
  encoding:'utf8',maxBuffer:32*1024*1024,env:{...process.env,XDG_CONFIG_HOME:'/tmp/browser-config',XDG_CACHE_HOME:'/tmp/browser-cache'}
});
const output=result.stdout+result.stderr;process.stdout.write(output);writeFileSync('test-artifacts/tests.log',output);
const count=name=>Number(new RegExp(`^# ${name} (\\d+)$`,'m').exec(output)?.[1] || 0);
const failedTests=[...output.matchAll(/^not ok \d+ - (.+)$/gm)].map(match=>match[1]);
const testHash=createHash('sha256').update(readFileSync('test/mbt/integration/special-stock-alert-browser.test.js')).digest('hex');
const baseline=JSON.parse(readFileSync('test/app-notification-roles-sounds-baseline.json','utf8'));
const knownBaselineFailures=mode==='regression' && result.status===1 && count('fail')===1 && baseline.testSourceHash===testHash && JSON.stringify(failedTests)===JSON.stringify(baseline.failedTests);
const report={mode,tests:count('tests'),passed:count('pass'),failed:count('fail'),skipped:count('skipped'),failedTests,knownBaselineFailures,testSourceHash:testHash,testExit:result.status,lintExit:lint.status,runtimeHashes:hashes};
writeFileSync('test-artifacts/test-results.json',JSON.stringify(report,null,2)+'\n');
process.exitCode=lint.status===0 && (result.status===0 || knownBaselineFailures)?0:1;
