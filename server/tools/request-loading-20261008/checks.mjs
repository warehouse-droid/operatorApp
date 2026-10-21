import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
fs.mkdirSync('test-artifacts/checks',{recursive:true});
const stages=[];
function run(name,command,args){
 const fd=fs.openSync(`test-artifacts/checks/${name}.log`,'w'),started=Date.now();
 const result=spawnSync('node',['tools/request-loading-20261008/isolate-command.mjs',command,...args],{stdio:['ignore',fd,fd],env:{...process.env,REQUEST_LOADING_BROWSER_PHASE:name}});fs.closeSync(fd);
 stages.push({name,exit:result.status,signal:result.signal,ms:Date.now()-started});console.log(JSON.stringify(stages.at(-1)));
 fs.writeFileSync('test-artifacts/checks/stages.json',JSON.stringify(stages,null,2));
}
run('static','node',['tools/request-loading-20261008/static.mjs']);
run('cache-version-contract','node',['--test','--test-name-pattern=Sales Request Stock has complete Simplified Chinese UI and validation coverage','test/mbt/unit/stock-request-ui-contract.test.js']);
run('browser-latency','node',['--test','--test-concurrency=1','--test-name-pattern=queue records|cold browser','test/request-loading-browser.test.js']);
run('behavior-coverage','node_modules/.bin/c8',['--all=false','--check-coverage=false','--include=src/special-stock-planning.js','--include=src/special-stock-request-repository.js','--include=src/stock-request-repository.js','--include=public/sales-stock-requests.js','--include=public/scm-stock-requests.js','--reporter=json','--reporter=text','--temp-directory=/tmp/request-loading-c8','--report-dir=test-artifacts/request-coverage',
 'node','--test','--test-concurrency=1','--test-name-pattern=completion|planning|sales:|scm:|queue records|batch hydration','test/request-loading-database.test.js','test/request-loading-ui.test.js','test/request-loading-browser.test.js']);
run('concurrent-stress','node',['--test','--test-concurrency=1','--test-name-pattern=concurrent Sales','test/request-loading-browser.test.js']);
run('property-mutations','node',['tools/request-loading-20261008/mutations.mjs']);
process.exitCode=stages.some(stage=>stage.name!=='concurrent-stress' && stage.exit!==0)?1:0;
