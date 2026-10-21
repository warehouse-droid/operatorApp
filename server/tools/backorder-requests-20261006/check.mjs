import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,readdirSync,openSync,closeSync,mkdtempSync,cpSync,symlinkSync,rmSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {annotationOnlyLines} from './annotation-coverage.mjs';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
assert.equal(new URL(process.env.DATABASE_URL).hostname,'db');
const out='test-artifacts/backorder-requests-20261006';mkdirSync(out,{recursive:true});
const mode=process.argv.at(-1), focused=['test/mbt/unit/backorder-workflow.test.js','test/mbt/integration/backorder-requests.test.js'];
const browserTest='test/mbt/integration/backorder-browser.test.js';
const runtime=JSON.parse(readFileSync('tools/backorder-requests-20261006/files.json'));
const hash=value=>createHash('sha256').update(value).digest('hex');
const counts=log=>Object.fromEntries(['tests','pass','fail','skipped'].map(key=>[key,Number(log.match(new RegExp(`^# ${key} (\\d+)$`,'m'))?.[1]||0)]));
const failures=log=>[...log.matchAll(/^not ok \d+ - (.+?)(?: # SKIP.*?)?$/gm)].filter(match=>!match[0].includes(' # SKIP')).map(match=>match[1].replace(/^.*?(?=\/test\/mbt\/)/,''));
export function run(label,args,{allowFailure=false,env={},cwd=process.cwd()}={}){
  const fd=openSync(out+'/'+label+'.log','w');let r;
  try{r=spawnSync(process.execPath,args,{cwd,env:{...process.env,...env},stdio:['ignore',fd,fd],timeout:1800000});}finally{closeSync(fd);}
  const log=readFileSync(out+'/'+label+'.log','utf8'),result={label,exit:r.status,...counts(log)};
  console.log(JSON.stringify(result));writeFileSync(out+'/'+label+'.json',JSON.stringify(result,null,2));
  assert.notEqual(r.status,null,'Timeout: '+label);if(!allowFailure)assert.equal(r.status,0,log.slice(-5000));return {log,result};
}
function copyTree(baseline=false){
  const root=mkdtempSync('/tmp/mbbs-backorder-check-');
  for(const folder of ['src','public'])cpSync(baseline?'tools/backorder-requests-20261006/baseline/'+folder:folder,root+'/'+folder,{recursive:true});
  cpSync('test',root+'/test',{recursive:true});
  for(const folder of ['node_modules','contracts'])symlinkSync(resolve(folder),root+'/'+folder);
  if(baseline){cpSync('migrations',root+'/migrations',{recursive:true});rmSync(root+'/migrations/268_regular_backorder.sql');}
  else symlinkSync(resolve('migrations'),root+'/migrations');
  const copyTools=(source,target)=>{
    mkdirSync(target,{recursive:true});
    for(const entry of readdirSync(source,{withFileTypes:true})){
      const from=source+'/'+entry.name,to=target+'/'+entry.name;
      if(entry.isDirectory()&&/^baseline(?:-|$)/.test(entry.name))symlinkSync(resolve(from),to);
      else if(entry.isDirectory())copyTools(from,to);else cpSync(from,to);
    }
  };
  copyTools('tools',root+'/tools');
  for(const file of readdirSync('.').filter(name=>name.endsWith('.js')||name==='package.json'))cpSync(file,root+'/'+file);
  mkdirSync(root+'/test-artifacts',{recursive:true});return root;
}
function resetDb(label,{cwd=process.cwd()}={}){
  run(label+'-reset',['--input-type=module','-e',`import pg from 'pg';const u=new URL(process.env.DATABASE_URL);if(u.hostname!=='db'||u.pathname!=='/mbt_test')throw Error('Not isolated');u.pathname='/postgres';const c=new pg.Client({connectionString:u.href});try{await c.connect();await c.query('DROP DATABASE mbt_test WITH (FORCE)');await c.query('CREATE DATABASE mbt_test');}finally{await c.end();}`]);
  run(label+'-migrate',['src/migrate.js'],{cwd});
}
function regressionGroups(){
  const files=['unit','property','integration'].flatMap(kind=>readdirSync('test/mbt/'+kind).filter(name=>/^(?:(?:regular-stock|regular-waitlist)[.-]|stock-request-|stocking-|special-).*\.test\.js$/.test(name)).sort().map(name=>'test/mbt/'+kind+'/'+name));
  const groups=new Map();
  for(const file of files){
    const source=readFileSync(file,'utf8');
    const host=source.match(/hostname\s*,\s*['"](mbbs-special-[^'"]+)['"]/)?.[1]||'db';
    const key=(file.includes('/special-')?'special':'regular')+'-'+host;
    if(!groups.has(key))groups.set(key,{host,files:[]});groups.get(key).files.push(file);
  }
  return groups;
}
function regressions(){
  const results={};
  for(const baseline of [true,false]){
    const root=copyTree(baseline);const kind=baseline?'baseline':'candidate';results[kind]={tests:0,pass:0,fail:0,skipped:0,failures:[],groups:[]};
    try{for(const [name,group] of regressionGroups()){
      resetDb(kind+'-'+name,{cwd:root});
      const db=new URL(process.env.DATABASE_URL);db.hostname=group.host;
      const args=baseline?[]:['/app/node_modules/c8/bin/c8.js','--all=false','--check-coverage=false',...runtime.filter(file=>file.endsWith('.js')).map(file=>'--include='+file),
        '--temp-directory='+resolve(out+'/c8-regression-'+name),'--report-dir='+resolve(out+'/coverage-regression-'+name),'--reporter=json',process.execPath];
      const runResult=run(kind+'-'+name,[...args,'--test','--test-concurrency=1',...group.files],{cwd:root,allowFailure:true,env:{DATABASE_URL:db.href,
        SPECIAL_HEADER_NOTE_BROWSER_OUTPUT:root+'/test-artifacts/special-header-browser',SPECIAL_DELIVERY_FEE_BROWSER_OUTPUT:root+'/test-artifacts/special-fee-browser',SPECIAL_CUSTOM_PO_BROWSER_OUTPUT:root+'/test-artifacts/special-custom-browser'}});
      for(const field of ['tests','pass','fail','skipped'])results[kind][field]+=runResult.result[field];
      results[kind].failures.push(...failures(runResult.log).map(value=>name+': '+value));results[kind].groups.push(runResult.result);
      if(!baseline){
        const coverage=[];
        const collect=folder=>{for(const entry of readdirSync(folder,{withFileTypes:true})){
          const path=folder+'/'+entry.name;if(entry.isDirectory())collect(path);else if(/coverage.*\.json$|\.coverage\.json$/.test(entry.name)){
            const value=JSON.parse(readFileSync(path));if(Array.isArray(value))coverage.push(...value.filter(row=>row?.url&&row?.source&&row?.functions));
          }
        }};collect(root+'/test-artifacts');
        writeFileSync(out+'/browser-regression-'+name+'.json',JSON.stringify(coverage));
        writeFileSync(out+'/coverage-regression-'+name+'/source.json',JSON.stringify({root,manifest:Object.fromEntries(runtime.filter(file=>file.endsWith('.js')).map(file=>[file,hash(readFileSync(root+'/'+file))]))},null,2));
      }
    }}finally{rmSync(root,{recursive:true,force:true});}
  }
  const prior=[...results.baseline.failures];results.newFailures=results.candidate.failures.filter(value=>{const index=prior.indexOf(value);if(index<0)return true;prior.splice(index,1);return false;});
  writeFileSync(out+'/regressions.json',JSON.stringify(results,null,2));assert.deepEqual(results.newFailures,[]);return results;
}
function mutations({only=null}={}){
  const list=[
    {name:'missing-so-completes',file:'public/backorder-workflow.js',before:'evidence.salesOrderId && evidence.purchaseOrderId',after:'evidence.purchaseOrderId',tests:[focused[0]],property:true},
    {name:'missing-po-completes',file:'public/backorder-workflow.js',before:'evidence.salesOrderId && evidence.purchaseOrderId',after:'evidence.salesOrderId',tests:[focused[0]],property:true},
    {name:'fail-closed-completion',file:'public/backorder-workflow.js',before:'operationallyComplete:both && Boolean(evidence.operationallyComplete)',after:'operationallyComplete:false',tests:[focused[0]],property:true},
    {name:'remote-write-enabled',file:'public/backorder-workflow.js',before:'isBackorder(detail) && !manualReference',after:'false',tests:[focused[0]],property:true},
    {name:'manual-reference-forbidden',file:'public/backorder-workflow.js',before:'isBackorder(detail) && !manualReference',after:'isBackorder(detail)',tests:[focused[0]],property:true},
    {name:'zero-ancillary-allowed',file:'public/backorder-workflow.js',before:"input[field] != null && input[field] !== ''",after:'Boolean(input[field])',tests:[focused[0]],property:true},
    {name:'generic-backorder-guard-disabled',file:'src/backorder-request-service.js',before:'if (isBackorder(request))',after:'if (false)',tests:[focused[0],focused[1]],property:true},
    {name:'native-backorder-uom-uppercased',file:'src/special-stock-request-domain.js',before:"workflowKind === 'backorder' ? nativeUom : nativeUom.toUpperCase()",after:'nativeUom.toUpperCase()',tests:[focused[1]],pattern:'^Backorder keeps the Regular'},
    {name:'special-default-becomes-backorder',file:'src/stock-case-workflow.js',before:"getStore() || 'special'",after:"getStore() || 'backorder'",tests:[focused[0]]},
    {name:'private-sales-remark-exposed',file:'src/special-stock-request-policy.js',before:'omitSalesInternalRemark(detail)',after:'detail',tests:[focused[1]]},
    {name:'material-edit-discards-price',file:'src/backorder-request-service.js',before:'original_unit_rate=$7',after:'original_unit_rate=0',tests:[focused[1]]},
    {name:'unknown-action-runs-closure',file:'src/backorder-request-service.js',before:"else if (action==='close')",after:"else if (action!=='close')",tests:[focused[1]]},
    {name:'closed-case-review-allowed',file:'src/special-stock-request-repository.js',before:"special.workflow_kind === 'backorder' && (special.close_status",after:"special.workflow_kind === 'special' && (special.close_status",tests:[focused[1]]},
    {name:'generic-cancellation-allowed',file:'src/stock-request-repository.js',before:"result.rows[0].regular_details?.deliveryMethod === 'backorder'",after:'false',tests:[focused[1]]},
    {name:'special-alerts-include-backorders',file:'src/special-stock-alerts.js',before:"AND request_id IN (SELECT request_id FROM sales_special_stock_cases WHERE workflow_kind='special')",after:'',tests:[focused[1]]},
    {name:'worker-reconciles-backorders',file:'tools/backorder-requests-20261006/worker-candidate/src/special-stock-request-repository.js',before:"WHERE workflow_kind='special' AND ${normalizedKind",after:'WHERE ${normalizedKind',tests:[focused[1]],pattern:'^Order webhooks'},
    {name:'vendor-outage-drops-saved-vendor',file:'public/backorder-stock-requests.js',before:"[{id,name:line.responseVendorName || d.vendorName},...(vendors.get(d.vendorName)||[])]",after:'[...(vendors.get(d.vendorName)||[])]',tests:[browserTest]},
    {name:'backorder-approval-notice-restored',file:'public/backorder-stock-requests.js',before:'showOrderPreviews:false,showApprovalNotice:false',after:'showOrderPreviews:false,showApprovalNotice:true',tests:[browserTest],pattern:'^SCM and Sales review'},
    {name:'scm-stage-filter-omitted',file:'public/scm-stock-requests.js',before:'if(scmStockState.backorderStageFilter)params.set("stage",scmStockState.backorderStageFilter);',after:'',tests:[browserTest]}
  ];
  const root=copyTree();const results=[];
  try{for(const mutant of list.filter(value=>!only || value.name===only)){
    const source=readFileSync(mutant.file,'utf8');assert.equal(source.split(mutant.before).length,2,'Mutation anchor '+mutant.name);
    if(mutant.tests.includes(focused[1])||mutant.tests.includes(browserTest))resetDb('before-'+mutant.name);
    try{
      writeFileSync(root+'/'+mutant.file,source.replace(mutant.before,mutant.after));
      const r=run('mutation-'+mutant.name,['--test','--test-concurrency=1',...(mutant.pattern?['--test-name-pattern='+mutant.pattern]:[]),...mutant.tests],{cwd:root,allowFailure:true});
      assert.equal(r.result.exit,1);assert.ok(r.result.fail>0);assert.ok(!r.log.includes("failureType: 'hookFailed'"));
      let propertyKilled=false;
      if(mutant.property){const p=run('property-mutation-'+mutant.name,['--test','--test-name-pattern=completion|capability|ancillary',focused[0]],{cwd:root,allowFailure:true});assert.equal(p.result.exit,1);assert.ok(p.result.fail>0);propertyKilled=true;}
      results.push({name:mutant.name,killed:true,propertyKilled,failures:failures(r.log)});
    }finally{writeFileSync(root+'/'+mutant.file,source);assert.equal(hash(readFileSync(root+'/'+mutant.file)),hash(readFileSync(mutant.file)));}
  }}finally{rmSync(root,{recursive:true,force:true});}
  writeFileSync(out+'/mutations.json',JSON.stringify(results,null,2));return results;
}
function changedCoverage(){
  const covered=Object.values(JSON.parse(readFileSync(out+'/coverage/coverage-final.json'))),roots=[process.cwd()];
  const browserEntries=readdirSync(out+'/browser').filter(name=>name.endsWith('.coverage.json')).flatMap(name=>JSON.parse(readFileSync(out+'/browser/'+name)));
  for(const name of readdirSync(out)){
    if(name.startsWith('browser-regression-')&&name.endsWith('.json'))browserEntries.push(...JSON.parse(readFileSync(out+'/'+name)));
    if(name.startsWith('coverage-regression-')&&existsSync(out+'/'+name+'/coverage-final.json')){
      const identity=JSON.parse(readFileSync(out+'/'+name+'/source.json'));
      assert.ok(Object.entries(identity.manifest).every(([file,value])=>value===hash(readFileSync(file))),'Stale regression coverage '+name);
      roots.push(identity.root);covered.push(...Object.values(JSON.parse(readFileSync(out+'/'+name+'/coverage-final.json'))));
    }
  }
  const lines=[],missing=[],annotations=[],branches=[];
  for(const file of runtime.filter(f=>f.endsWith('.js'))){
    const old='tools/backorder-requests-20261006/baseline/'+file,source=readFileSync(file,'utf8'),sourceLines=source.split('\n');
    const annotationLines=annotationOnlyLines(existsSync(old)?readFileSync(old,'utf8'):'',source);
    const diff=spawnSync('diff',['-U0',existsSync(old)?old:'/dev/null',file],{encoding:'utf8'}).stdout;
    const entries=covered.filter(value=>roots.some(root=>value.path===root+'/'+file));
    const browser=browserEntries.filter(value=>value.url.split('?')[0].endsWith('/'+file.split('/').at(-1))&&value.source===source);
    let line=0;
    for(const text of diff.split('\n')){
      const hunk=text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);if(hunk)line=Number(hunk[1]);
      else if(text.startsWith('+')&&!text.startsWith('+++')){
        if(annotationLines.has(line)){annotations.push(file+':'+line);line++;continue;}
        if(file.startsWith('public/')){
          const value=sourceLines[line-1],trim=value.trim();
          if(trim&&!trim.startsWith('//')&&!trim.startsWith('/*')&&!trim.startsWith('*')&&!/^[{});]+$/.test(trim)){
            const offset=sourceLines.slice(0,line-1).join('\n').length+(line>1?1:0)+value.indexOf(trim);
            const hit=entries.some(entry=>Object.entries(entry.statementMap).some(([key,value])=>value.start.line<=line&&value.end.line>=line&&entry.s[key]>0))||browser.some(value=>value.functions.flatMap(fn=>fn.ranges).filter(range=>range.startOffset<=offset&&range.endOffset>offset).sort((a,b)=>(a.endOffset-a.startOffset)-(b.endOffset-b.startOffset))[0]?.count>0);
            lines.push(file+':'+line);if(!hit)missing.push(file+':'+line);
          }
        }else{
          const executable=entries.some(entry=>Object.values(entry.statementMap).some(value=>value.start.line<=line&&value.end.line>=line));
          const hit=entries.some(entry=>Object.entries(entry.statementMap).some(([key,value])=>value.start.line<=line&&value.end.line>=line&&entry.s[key]>0));
          if(executable){lines.push(file+':'+line);if(!hit)missing.push(file+':'+line);}
          else if(!entries.length&&sourceLines[line-1].trim()&&!/^\s*(\/\/|\/\*|\*)/.test(sourceLines[line-1]))missing.push(file+':'+line);
        }
        line++;
      }else if(!text.startsWith('-')&&!text.startsWith('\\'))line++;
    }
    for(const entry of entries)branches.push({file,path:entry.path,total:Object.values(entry.b).flat().length,covered:Object.values(entry.b).flat().filter(value=>value>0).length});
  }
  const workerFile='src/special-stock-request-repository.js',workerPath='tools/backorder-requests-20261006/worker-candidate/'+workerFile;
  const workerIdentity=JSON.parse(readFileSync(out+'/worker-coverage/source.json'));
  assert.equal(workerIdentity.sha256,hash(readFileSync(workerPath)),'Worker coverage must match the tested candidate');
  const workerEntries=Object.values(JSON.parse(readFileSync(out+'/worker-coverage/coverage-final.json'))).filter(entry=>entry.path===workerIdentity.root+'/'+workerFile);
  const workerDiff=spawnSync('diff',['-U0','tools/backorder-requests-20261006/baseline-worker/'+workerFile,workerPath],{encoding:'utf8'}).stdout;let workerLine=0;
  for(const text of workerDiff.split('\n')){
    const hunk=text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);if(hunk)workerLine=Number(hunk[1]);
    else if(text.startsWith('+')&&!text.startsWith('+++')){
      const hit=workerEntries.some(entry=>Object.entries(entry.statementMap).some(([key,range])=>range.start.line<=workerLine&&range.end.line>=workerLine&&entry.s[key]>0));
      const key='worker:'+workerFile+':'+workerLine;lines.push(key);if(!hit)missing.push(key);workerLine++;
    }else if(!text.startsWith('-')&&!text.startsWith('\\'))workerLine++;
  }
  for(const entry of workerEntries)branches.push({file:'worker:'+workerFile,path:entry.path,total:Object.values(entry.b).flat().length,covered:Object.values(entry.b).flat().filter(value=>value>0).length});
  const result={total:lines.length,covered:lines.length-missing.length,lines,missing,annotationOnly:annotations,branches};
  writeFileSync(out+'/changed-coverage.json',JSON.stringify(result,null,2));assert.deepEqual(missing,[]);return result;
}
if(mode==='approval-red'){const r=run('approval-red',['--test','--test-name-pattern=^SCM and Sales review',browserTest],{allowFailure:true});assert.equal(r.result.exit,1);assert.equal(r.result.fail,1);assert.ok(!r.log.includes("failureType: 'hookFailed'"));}
else if(mode==='uom-red'){const r=run('uom-red',['--test','--test-name-pattern=^Backorder accepts the Regular|^Backorder keeps the Regular',focused[1]],{allowFailure:true});assert.equal(r.result.exit,1);assert.equal(r.result.fail,2);assert.ok(!r.log.includes("failureType: 'hookFailed'"));}
else if(mode==='alerts-red'){const r=run('alerts-red',['--test','--test-name-pattern=^Manual Backorder links',focused[1]],{allowFailure:true});assert.equal(r.result.exit,1);assert.equal(r.result.fail,2);assert.ok(!r.log.includes("failureType: 'hookFailed'"));}
else if(mode==='schema-red'){const r=run('schema-red',['--test','--test-name-pattern=^Backorder schema',focused[1]],{allowFailure:true});assert.equal(r.result.exit,1);assert.ok(r.result.fail>0);assert.ok(!r.log.includes("failureType: 'hookFailed'"));}
else if(mode==='price-red'){const r=run('price-red',['--test','--test-name-pattern=^Backorder quote price',focused[1]],{allowFailure:true});assert.equal(r.result.exit,1);assert.ok(r.result.fail>0);assert.ok(!r.log.includes("failureType: 'hookFailed'"));}
else if(mode==='worker-red'){const r=run('worker-red',['--test','--test-name-pattern=^Order webhooks',focused[1]],{allowFailure:true});assert.equal(r.result.exit,1);assert.ok(r.result.fail>0);assert.ok(!r.log.includes("failureType: 'hookFailed'"));}
else if(mode==='red'){
  const {log,result}=run('red',['--test','--test-concurrency=1',...focused],{allowFailure:true});
  assert.equal(result.exit,1);assert.ok(result.fail>=8);assert.ok(!log.includes("failureType: 'hookFailed'"),'RED must fail behavior, not setup');
}else if(mode==='browser-red'){
  const {log,result}=run('browser-red',['--test','test/mbt/integration/backorder-browser.test.js'],{allowFailure:true});
  assert.equal(result.exit,1);assert.ok(result.fail>0);assert.ok(!log.includes("failureType: 'hookFailed'"));
}else if(mode==='ui-contract'){
  const root=copyTree(true);
  try{const prior=run('ui-contract-baseline',['--test','test/mbt/unit/stock-request-ui-contract.test.js'],{cwd:root,allowFailure:true});
    const next=run('ui-contract',['--test','test/mbt/unit/stock-request-ui-contract.test.js'],{allowFailure:true});
    assert.deepEqual(failures(next.log),failures(prior.log));
    writeFileSync(out+'/ui-contract-comparison.json',JSON.stringify({baseline:prior.result,candidate:next.result,newFailures:[],existingFailures:failures(prior.log)},null,2));
  }finally{rmSync(root,{recursive:true,force:true});}
}
else if(mode==='browser')run('browser',['--test',browserTest]);
else if(mode==='quick'){run('focused',['--test','--test-concurrency=1',...focused,browserTest]);resetDb('quick-before-migration');run('migration-check',['tools/backorder-requests-20261006/migration-check.mjs']);run('static-check',['tools/backorder-requests-20261006/check.mjs','static']);}
else if(mode==='migration')run('migration-check',['tools/backorder-requests-20261006/migration-check.mjs']);
else if(mode==='mutations')mutations();
else if(mode==='stage-mutation')mutations({only:'scm-stage-filter-omitted'});
else if(mode==='coverage-audit'){assert.equal(annotationOnlyLines('const total=1n;\n','// shifted source\nconst total=(/** @type {bigint} */ (1n));\n').has(2),true);assert.equal(annotationOnlyLines('const total=1n;\n','const total=2n;\n').has(1),false);changedCoverage();}
else if(mode==='coverage'){
  rmSync(out+'/browser',{recursive:true,force:true});
  run('coverage',['/app/node_modules/c8/bin/c8.js','--all=false','--check-coverage=false',...runtime.filter(file=>file.endsWith('.js')).map(file=>'--include='+file),`--temp-directory=${out}/c8`,`--report-dir=${out}/coverage`,'--reporter=json',process.execPath,'--test','--test-concurrency=1',...focused,browserTest]);
  changedCoverage();
}
else if(mode==='regression')regressions();
else if(mode==='all'){
  const regression=regressions();resetDb('before-focused-final');
  const final=run('focused-final',['--test','--test-concurrency=1',...focused,browserTest]);
  resetDb('before-migration');run('migration-check',['tools/backorder-requests-20261006/migration-check.mjs']);
  resetDb('before-coverage');rmSync(out+'/browser',{recursive:true,force:true});
  run('coverage',['/app/node_modules/c8/bin/c8.js','--all=false','--check-coverage=false',...runtime.filter(file=>file.endsWith('.js')).map(file=>'--include='+file),`--temp-directory=${out}/c8`,`--report-dir=${out}/coverage`,'--reporter=json',process.execPath,'--test','--test-concurrency=1',...focused,browserTest]);
  run('static-final',['tools/backorder-requests-20261006/check.mjs','static']);
  const coverage=changedCoverage(),mutation=mutations();resetDb('before-reversed');
  const reversed=run('reversed',['--test','--test-concurrency=1',browserTest,...focused.toReversed()]);
  const taskTools=readdirSync('tools/backorder-requests-20261006').filter(file=>/\.(?:mjs|py|sql|json|md)$/.test(file));
  run('secrets',['test/support/scan-diff-secrets.mjs',...runtime,...focused,browserTest,...taskTools.map(file=>'tools/backorder-requests-20261006/'+file)]);
  const summary={regression,newFailures:regression.newFailures,focused:final.result,reversed:reversed.result,types:'pass',typeComparison:JSON.parse(readFileSync(out+'/types.json')),lint:'pass',changedLines:coverage,mutations:mutation,
    manifest:Object.fromEntries(runtime.map(file=>[file,hash(readFileSync(file))])),workerManifest:{'src/special-stock-request-repository.js':hash(readFileSync('tools/backorder-requests-20261006/worker-candidate/src/special-stock-request-repository.js'))},
    dependencyLockHash:hash(readFileSync('package-lock.json')),testManifest:Object.fromEntries([...focused,browserTest].map(file=>[file,hash(readFileSync(file))])),
    toolManifest:Object.fromEntries(taskTools.map(file=>[file,hash(readFileSync('tools/backorder-requests-20261006/'+file))])),node:process.version,
    versions:Object.fromEntries(['@playwright/test','c8','typescript','eslint','fast-check','espree'].map(name=>[name,JSON.parse(readFileSync('/app/node_modules/'+name+'/package.json')).version]))};
  writeFileSync(out+'/summary.json',JSON.stringify(summary,null,2));console.log(JSON.stringify({gauntlet:'pass',focused:summary.focused,changed:coverage.total,mutants:mutation.length}));
}
else if(mode==='static'){
  const files=JSON.parse(readFileSync('tools/backorder-requests-20261006/files.json')).filter(file=>file.endsWith('.js'));
  const args=['/app/node_modules/typescript/bin/tsc','--noEmit','--allowJs','--checkJs','--skipLibCheck','--types','node','--target','ES2022','--module','NodeNext'];
  const root=mkdtempSync('/tmp/mbbs-backorder-types-');
  try{
    for(const folder of ['src','public'])cpSync('tools/backorder-requests-20261006/baseline/'+folder,root+'/'+folder,{recursive:true});
    for(const folder of ['node_modules','tools','migrations','contracts'])symlinkSync(resolve(folder),root+'/'+folder);
    cpSync('package.json',root+'/package.json');
    run('types-baseline',[...args,...files.filter(file=>existsSync('tools/backorder-requests-20261006/baseline/'+file))],{allowFailure:true,cwd:root});
    run('types-candidate',[...args,...files],{allowFailure:true});
    const messages=label=>readFileSync(out+'/'+label+'.log','utf8').split('\n').filter(line=>/error TS\d+:/.test(line)).map(line=>line.replace(/\(\d+,\d+\)/,'').replace(/error TS2551: (.*) Did you mean '[^']+'\?/u,'error TS2339: $1'));
    const baseline=messages('types-baseline'),candidate=messages('types-candidate'),remaining=[...baseline];
    const added=candidate.filter(message=>{const index=remaining.indexOf(message);if(index<0)return true;remaining.splice(index,1);return false;});
    writeFileSync(out+'/types-new-errors.json',JSON.stringify(added,null,2));writeFileSync(out+'/types.json',JSON.stringify({baseline:baseline.length,candidate:candidate.length,newErrors:added.length},null,2));
    assert.deepEqual(added,[]);
    run('lint',['tools/backorder-requests-20261006/lint.mjs']);
    for(const file of files)run('syntax-'+file.split('/').at(-1),['--check',file]);
  }finally{rmSync(root,{recursive:true,force:true});}
}
else if(mode==='baseline'){
  const tests=['unit','property','integration'].flatMap(kind=>readdirSync('test/mbt/'+kind).filter(name=>/^(?:(?:regular-stock|regular-waitlist)[.-]|stock-request-|stocking-).*\.test\.js$/.test(name)).sort().map(name=>'test/mbt/'+kind+'/'+name));
  const root=mkdtempSync('/tmp/mbbs-backorder-baseline-');
  try{
    for(const folder of ['src','public'])cpSync('tools/backorder-requests-20261006/baseline/'+folder,root+'/'+folder,{recursive:true});
    cpSync('test',root+'/test',{recursive:true});
    for(const folder of ['node_modules','tools','migrations','contracts'])symlinkSync(resolve(folder),root+'/'+folder);
    cpSync('package.json',root+'/package.json');
    mkdirSync(root+'/test-artifacts',{recursive:true});
    run('baseline',['--test','--test-concurrency=1',...tests],{allowFailure:true,cwd:root});
  }finally{rmSync(root,{recursive:true,force:true});}
}else run('focused',['--test','--test-concurrency=1',...focused]);
