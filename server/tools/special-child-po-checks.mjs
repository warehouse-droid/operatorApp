import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const focused=['test/mbt/unit/special-child-po.test.js','test/mbt/integration/special-child-po.test.js'];
const files=[...focused,'test/mbt/integration/special-child-po-browser.test.js',
  'test/mbt/unit/special-po-routing.test.js','test/mbt/unit/special-po-routing-note-service.test.js',
  'test/mbt/unit/special-workflow-documents.test.js','test/mbt/unit/special-workflow-native-documents.test.js',
  'test/mbt/unit/special-planning-arrival.test.js','test/mbt/unit/special-logistics-progress.test.js',
  'test/dispatch/integration/scm-po-split-schedule-remaining.test.js',
  'test/mbt/integration/special-po-routing-browser.test.js'];
const full=process.argv[2]==='final';
const report={passed:true,layers:[]};
const changed=JSON.parse(readFileSync('test-artifacts/changed-lines.json','utf8'));
const runtime=Object.keys(changed);
const hashes=()=>Object.fromEntries(runtime.map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
report.hashes=hashes();
report.toolchain={node:process.version,...Object.fromEntries(['typescript','eslint','c8','fast-check','@playwright/test'].map(name=>[name,JSON.parse(readFileSync('node_modules/'+name+'/package.json','utf8')).version]))};

function failures(output) {
  return [...output.matchAll(/not ok \d+ - ([^\n]+)\n([\s\S]*?)\n  \.\.\./g)].map(match=>({
    name:match[1],error:(match[2].match(/\n  error: ([\s\S]*?)(?=\n  (?:code|name|stack):)/)?.[1] || '').replace(/mbbs-\d+-\d+/g,'mbbs-REFERENCE')
  }));
}

function success(result,output,mustFail,known) {
  if (mustFail) {return result.status!==0 && /not ok/.test(output);}
  if (result.status===0) {return true;}
  const errors=failures(output);
  return errors.length>0 && errors.every(error=>known.some(previous=>JSON.stringify(error)===JSON.stringify(previous)));
}

function run(name,args,{cwd=process.cwd(),mustFail=false,quiet=false,known=[]}={}) {
  const result=spawnSync(process.execPath,args,{cwd,encoding:'utf8',timeout:240000,maxBuffer:12*1024*1024});
  const output=(result.stdout||'')+(result.stderr||'');
  const passed=success(result,output,mustFail,known);
  const summary=output.split('\n').filter(line=>/^# (tests|pass|fail|duration_ms)|^not ok|^  error:/.test(line));
  const failureDetails=passed ? undefined : output.slice(0,5000);
  report.layers.push({name,passed,exitCode:result.status,summary,failureDetails});
  if (!passed || !quiet) {process.stdout.write(output);}
  report.passed &&= passed;
  return result;
}

function changedCoverage(data,lines) {
  if (!data) {return {unmeasured:lines.length};}
  const measured=new Set(),covered=new Set();
  for (const [id,location] of Object.entries(data.statementMap)) {
    for (const line of lines.filter(value=>value>=location.start.line && value<=location.end.line)) {
      measured.add(line);
      if (data.s[id]>0) {covered.add(line);}
    }
  }
  return {covered:covered.size,measured:measured.size,uncovered:[...measured].filter(line=>!covered.has(line))};
}

const testArgs=['--test','--test-concurrency=1',...(process.argv[2]==='allocation-red' ? [focused[1]] : files)];
let known=[];
if (full) {
  const baseline=spawnSync(process.execPath,['--test','--test-concurrency=1','test/mbt/integration/special-po-routing-browser.test.js','test/mbt/unit/special-workflow-native-documents.test.js'],
    {cwd:process.cwd()+'/baseline',encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024});
  known=failures(baseline.stdout+baseline.stderr);
  report.baseline={exitCode:baseline.status,failures:known};
}
writeFileSync('test-artifacts/c8-config.json','{}');
run('affected suites',full ? ['node_modules/c8/bin/c8.js','--config=test-artifacts/c8-config.json','--all=false','--include=src/**','--include=public/**','--reporter=json','--reporter=text-summary','--reports-dir=test-artifacts/coverage',process.execPath,...testArgs] : testArgs,{known});
if (full) {
  for (const file of runtime) {run('syntax '+file,['--check',file],{quiet:true});}
  run('types: routing UI',['node_modules/typescript/bin/tsc','--allowJs','--checkJs','--noEmit','--skipLibCheck','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','--lib','ES2022,DOM,DOM.Iterable','public/special-stock-po-routing.js'],{quiet:true});
  run('lint',['node_modules/eslint/bin/eslint.js','--config','tools/special-child-po-eslint.config.mjs','--max-warnings=0',
    'src/special-stock-purchase-order-routing.js','public/special-stock-po-routing.js','src/scm-schedule-special-order.js',...focused,'test/mbt/integration/special-child-po-browser.test.js','tools/special-child-po-checks.mjs'],{quiet:true});
  const mutations=[
    ['preview without draft','src/special-stock-documents.js','(!sales && detail.purchaseOrderCustomLinkage)','(!sales && false)',[focused[0]]],
    ['child route targets source','src/special-stock-purchase-order-routing.js','child ? detail.purchaseOrderTargetRef : detail.purchaseOrderReference || detail.purchaseOrderRef','detail.purchaseOrderRef',[focused[0]]],
    ['sibling request remark','src/scm-schedule-special-order.js','special.purchase_order_split_id IS NULL OR EXISTS (','true OR EXISTS (',[focused[1]]],
    ['foreign child accepted','src/special-stock-request-repository.js','Number(selected.source_po_id)!==Number(special.purchase_order_netsuite_id)','false',[focused[1]]],
    ['source planning counts for child','src/special-stock-planning.js','detail.purchaseOrderTargetRef || detail.purchaseOrderRef','detail.purchaseOrderRef',[focused[0]]]
  ];
  for (const [name,file,from,to,tests] of mutations) {
    const source=readFileSync(file,'utf8');
    if (!source.includes(from)) {throw Error('Mutation anchor changed: '+name);}
    try {
      writeFileSync(file,source.replace(from,to));
      run('mutation: '+name,['--test','--test-concurrency=1',...tests],{mustFail:true,quiet:true});
    } finally {writeFileSync(file,source);}
  }
  run('suite order: focused reversed',['--test','--test-concurrency=1',...focused.toReversed()],{quiet:true});
  const coverage=JSON.parse(readFileSync('test-artifacts/coverage/coverage-final.json','utf8'));
  report.changedCoverage={};
  for (const [file,lines] of Object.entries(changed)) {
    const data=Object.entries(coverage).find(([path])=>path.endsWith('/'+file))?.[1];
    report.changedCoverage[file]=changedCoverage(data,lines);
  }
  report.restored=JSON.stringify(hashes())===JSON.stringify(report.hashes);
  report.passed &&= report.restored;
}
writeFileSync('test-artifacts/report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
process.exitCode=report.passed ? 0 : 1;
