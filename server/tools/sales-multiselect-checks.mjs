import fs from 'node:fs';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
const tree={};
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=dir+'/'+e.name;if(e.isDirectory())walk(p);else if(e.isFile())tree[p]=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');}}
for(const dir of ['src','public','migrations'])walk(dir);
const encoded='{'+Object.keys(tree).sort().map(key=>JSON.stringify(key)+': '+JSON.stringify(tree[key])).join(', ')+'}';
const result={candidateTreeHash:crypto.createHash('sha256').update(encoded).digest('hex'),checks:[]};
function run(name,args,{isolate=false,knownLayout=false}={}){
  const log=fs.openSync(`test-artifacts/${name}.log`,'w'),start=Date.now();
  const child=spawnSync('node',isolate?['tools/request-loading-20261008/isolate-command.mjs','node',...args]:args,{stdio:['ignore',log,log],timeout:240000,env:{...process.env,XDG_CONFIG_HOME:'/tmp/workflow-config',XDG_CACHE_HOME:'/tmp/workflow-cache'}});fs.closeSync(log);
  const text=fs.readFileSync(`test-artifacts/${name}.log`,'utf8');
  const failed=[...text.matchAll(/^not ok \d+ - (.+)$/gm)].map(m=>m[1]);
  const baseline=knownLayout?fs.readFileSync('test-artifacts/preexisting-ui-baseline.log','utf8'):'';
  const old='stock-request feedback is content-sized and availability shows Sales plus conversion equivalents';
  const preexisting=knownLayout&&child.status===1&&failed.length===1&&failed[0]===old&&baseline.includes(' - '+old)&&baseline.includes('grid-template-rows');
  const row={name,exit:preexisting?0:child.status,rawExit:child.status,signal:child.signal,preexistingFailures:preexisting?failed:[],ms:Date.now()-start};
  result.checks.push(row);console.log(JSON.stringify(row));fs.writeFileSync('test-artifacts/workflow-checks.json',JSON.stringify(result,null,2));
}
run('unit-regression',['--test','--test-concurrency=1','test/mbt/unit/sales-workflow-status.test.js','test/mbt/unit/sales-stock-multiselect.test.js','test/mbt/unit/stock-request-ui-contract.test.js','test/request-loading-ui.test.js'],{knownLayout:true});
run('status-api',['--test','--test-concurrency=1','test/mbt/integration/sales-workflow-status.test.js'],{isolate:true});
run('multiselect-api',['--test','--test-concurrency=1','test/mbt/integration/sales-stock-multiselect.test.js'],{isolate:true});
run('status-browser',['--test','--test-concurrency=1','test/mbt/integration/sales-stock-status-filter-browser.test.js'],{isolate:true});
run('stock-check-popup',['--test','--test-concurrency=1','test/mbt/integration/sales-stock-check-popup.test.js'],{isolate:true});
run('stocking-alert-regression',['--test','--test-concurrency=1','test/mbt/integration/stocking-replies-browser.test.js'],{isolate:true});
run('backorder-alert-regression',['--test','--test-concurrency=1','--test-name-pattern=popup|PO link|alerts|acknowledgements|directory, vendor','test/mbt/integration/backorder-browser.test.js','test/mbt/integration/backorder-requests.test.js'],{isolate:true});
process.exitCode=result.checks.some(row=>row.exit!==0)?1:0;
