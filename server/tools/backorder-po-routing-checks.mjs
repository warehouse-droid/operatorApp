import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
const focused='test/mbt/integration/backorder-po-routing.test.js';
const full=process.argv[2]==='final';
const changed=JSON.parse(readFileSync('test-artifacts/changed-lines.json','utf8'));
const hashes=()=>Object.fromEntries(Object.keys(changed).map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
const report={passed:true,hashes:hashes(),layers:[]};
report.toolchain={node:process.version,...Object.fromEntries(['typescript','eslint','c8','fast-check','@playwright/test'].map(name=>[name,JSON.parse(readFileSync('node_modules/'+name+'/package.json','utf8')).version]))};
function failureMessage(output) {
  const failures=[...output.matchAll(/not ok [\s\S]*?\n  \.\.\./g)].map(match=>match[0]);
  return failures.length?output.slice(0,4500)+'\n'+failures.join('\n'):output.slice(-9000);
}
function run(name,args,{mustFail=false,quiet=false}={}) {
  const result=spawnSync(process.execPath,args,{encoding:'utf8',timeout:240000,maxBuffer:16*1024*1024});
  const output=(result.stdout||'')+(result.stderr||'');
  const passed=mustFail?result.status!==0&&/not ok/.test(output):result.status===0;
  report.layers.push({name,passed,exitCode:result.status,summary:output.split('\n').filter(line=>/^# (tests|pass|fail|duration_ms)|^not ok|^  error:/.test(line)),...(!passed?{failure:failureMessage(output)}:{})});
  report.passed &&= passed;if(!quiet||!passed) {process.stdout.write(output);}
  writeFileSync('test-artifacts/report.json',JSON.stringify(report,null,2));
}
const suites=process.argv[2]==='import-check'?['test/mbt/unit/special-po-routing-note-service.test.js']:[focused,'test/mbt/unit/backorder-po-routing.test.js',...(full?['test/mbt/integration/special-child-po.test.js','test/mbt/integration/special-child-po-browser.test.js','test/mbt/unit/special-child-po.test.js','test/mbt/unit/special-po-routing.test.js','test/mbt/unit/special-po-routing-note-service.test.js','test/mbt/integration/backorder-routing.test.js','test/mbt/unit/backorder-workflow.test.js','test/mbt/unit/backorder-review-flow.test.js']:[])];
writeFileSync('test-artifacts/c8-config.json','{}');
run('affected suites',full?['node_modules/c8/bin/c8.js','--config=test-artifacts/c8-config.json','--all=false',...Object.keys(changed).map(file=>'--include='+file),'--reporter=json','--reporter=text-summary','--reports-dir=test-artifacts/coverage',process.execPath,'--test','--test-concurrency=1',...suites]:['--test','--test-concurrency=1',...suites]);
if(full) {
  for(const file of Object.keys(changed)) {run('syntax '+file,['--check',file],{quiet:true});}
  run('routing UI types',['node_modules/typescript/bin/tsc','--allowJs','--checkJs','--noEmit','--skipLibCheck','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','--lib','ES2022,DOM,DOM.Iterable','public/backorder-po-routing.js','public/special-stock-po-routing.js'],{quiet:true});
  run('scoped lint',['node_modules/eslint/bin/eslint.js','--config','tools/backorder-po-routing-eslint.config.mjs','--max-warnings=0','public/backorder-po-routing.js','public/special-stock-po-routing.js','src/backorder-request-routes.js','src/special-stock-purchase-order-routing.js',focused,'test/mbt/unit/backorder-po-routing.test.js','tools/backorder-po-routing-checks.mjs'],{quiet:true});
  coverageReport();
  const mutants=[
    ['dropped child selection','src/backorder-request-service.js','purchaseOrderSplitId:input.purchaseOrderSplitId','purchaseOrderSplitId:undefined',[focused]],
    ['foreign child allowed','src/special-stock-request-repository.js','Number(selected.source_po_id)!==Number(special.purchase_order_netsuite_id)','false',[focused]],
    ['request vendor used for Backorder note','src/special-stock-purchase-order-routing.js',"detail.workflowKind==='backorder' && !detail.purchaseOrderSplitId",'false',['test/mbt/unit/backorder-po-routing.test.js']],
    ['browser discards selected child','public/backorder-po-routing.js',"new FormData(form).get('purchaseOrderSplitId')",'null',[focused]],
    ['refresh keeps stale routing','public/backorder-po-routing.js',' && entry.detail===d','',[focused]]
  ];
  for(const [name,file,from,to,tests] of report.passed?mutants:[]) {
    const source=readFileSync(file,'utf8');
    if(!source.includes(from)) {throw Error('Missing mutation anchor: '+name);}
    try {writeFileSync(file,source.replace(from,to));run('mutation: '+name,['--test','--test-concurrency=1',...tests],{mustFail:true,quiet:true});}
    finally {writeFileSync(file,source);}
  }
  if(report.passed) {run('focused suites reversed',['--test','--test-concurrency=1','test/mbt/unit/backorder-po-routing.test.js',focused],{quiet:true});}
  report.restored=JSON.stringify(hashes())===JSON.stringify(report.hashes);
  report.passed &&= report.restored;
}
writeFileSync('test-artifacts/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));process.exitCode=report.passed?0:1;

function coverageReport() {
  const data=JSON.parse(readFileSync('test-artifacts/coverage/coverage-final.json','utf8'));
  report.changedCoverage={};
  for(const [file,lines] of Object.entries(changed)) {
    const coverage=Object.entries(data).find(([path])=>path.endsWith('/'+file))?.[1];
    const measured=new Set(),covered=new Set();
    for(const [id,location] of Object.entries(coverage?.statementMap || {})) {
      for(const line of lines.filter(value=>value>=location.start.line&&value<=location.end.line)) {
        measured.add(line);if(coverage.s[id]>0) {covered.add(line);}
      }
    }
    report.changedCoverage[file]={covered:covered.size,measured:measured.size,uncovered:[...measured].filter(line=>!covered.has(line))};
  }
  const browserFiles=['test-artifacts/backorder-po-browser.json','test-artifacts/backorder-po-race-browser.json'];
  const entries=browserFiles.filter(existsSync).flatMap(file=>JSON.parse(readFileSync(file,'utf8')));
  report.browserCoverage={};
  for(const [file,lines] of Object.entries(changed).filter(([name])=>name.startsWith('public/'))) {
    const matches=entries.filter(entry=>entry.url&&new URL(entry.url).pathname==='/'+file.replace('public/',''));
    const covered=new Set();
    for(const entry of matches) {
      let offset=0;
      const ranges=entry.functions.flatMap(fn=>fn.ranges);
      entry.source.split('\n').forEach((line,index)=>{
        const start=offset,end=start+line.length;offset=end+1;
        const inner=ranges.filter(range=>range.startOffset<=start&&range.endOffset>=end).sort((a,b)=>(a.endOffset-a.startOffset)-(b.endOffset-b.startOffset))[0];
        if(lines.includes(index+1)&&line.trim()&&inner?.count>0) {covered.add(index+1);}
      });
    }
    report.browserCoverage[file]={covered:covered.size,changed:lines.length};
  }
}
