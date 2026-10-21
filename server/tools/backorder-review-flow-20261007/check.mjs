import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,readdirSync,openSync,closeSync,mkdtempSync,cpSync,symlinkSync,rmSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {annotationOnlyLines} from './annotation-coverage.mjs';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
assert.equal(new URL(process.env.DATABASE_URL).hostname,'db');
const out='test-artifacts/backorder-review-flow-20261007';mkdirSync(out,{recursive:true});
const mode=process.argv.at(-1), focused=['test/mbt/unit/backorder-workflow.test.js','test/mbt/integration/backorder-requests.test.js','test/mbt/integration/backorder-routing.test.js','test/mbt/property/backorder-routing.property.test.js','test/mbt/property/backorder-link-sequence.property.test.js','test/mbt/property/backorder-queue-filter.property.test.js','test/mbt/integration/regular-stock-resolution-browser.test.js','test/mbt/integration/stocking-customer-browser.test.js'];
const browserTest='test/mbt/integration/backorder-browser.test.js',enhancementBrowser='test/mbt/integration/backorder-enhancements-browser.test.js';
const runtime=JSON.parse(readFileSync('tools/backorder-review-flow-20261007/files.json'));
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
  for(const folder of ['src','public'])cpSync(baseline?'tools/backorder-review-flow-20261007/baseline/'+folder:folder,root+'/'+folder,{recursive:true});
  cpSync(baseline?'tools/backorder-review-flow-20261007/baseline/test':'test',root+'/test',{recursive:true});
  for(const folder of ['node_modules','contracts'])symlinkSync(resolve(folder),root+'/'+folder);
  if(baseline){cpSync('migrations',root+'/migrations',{recursive:true});rmSync(root+'/migrations/270_backorder_order_completion.sql');}
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
        writeFileSync(out+'/coverage-regression-'+name+'/source.json',JSON.stringify({root,manifest:Object.fromEntries(runtime.map(file=>[file,hash(readFileSync(root+'/'+file))]))},null,2));
      }
    }}finally{rmSync(root,{recursive:true,force:true});}
  }
  const prior=[...results.baseline.failures];results.newFailures=results.candidate.failures.filter(value=>{const index=prior.indexOf(value);if(index<0)return true;prior.splice(index,1);return false;});
  writeFileSync(out+'/regressions.json',JSON.stringify(results,null,2));assert.deepEqual(results.newFailures,[]);return results;
}
function mutations({only=null}={}){
  const sequence='test/mbt/property/backorder-link-sequence.property.test.js',requests=focused[1];
  const queueProperty='test/mbt/property/backorder-queue-filter.property.test.js';
  const list=[
    {name:'partial-acceptance-releases-PO',file:'public/backorder-workflow.js',before:'open.every(line =>',after:'open.some(line =>',tests:[sequence],property:true},
    {name:'stock-check-timestamp-ignored',file:'public/backorder-workflow.js',before:'Boolean(line.supplyStatus && line.stockCheckedAt)',after:'Boolean(line.supplyStatus)',tests:[sequence],property:true},
    {name:'Sales-acceptance-ignored',file:'public/backorder-workflow.js',before:"line.salesDecision === 'accepted'\n    && ",after:'',tests:[sequence],property:true},
    {name:'empty-open-materials-release-PO',file:'public/backorder-workflow.js',before:'open.length > 0 && ',after:'',tests:[sequence],property:true},
    {name:'closed-materials-block-reviewed-PO',file:'public/backorder-workflow.js',before:".filter(line => !['declined','closed'].includes(line.salesDecision))",after:'',tests:[sequence],property:true},
    {name:'SO-release-ignores-PO-planning',file:'public/backorder-workflow.js',before:'detail.purchaseOrderId && detail.dispatchPlanning?.purchaseOrder?.planned === true',after:'detail.purchaseOrderId',tests:[sequence],property:true},
    {name:'SO-release-ignores-PO-ID',file:'public/backorder-workflow.js',before:'detail.purchaseOrderId && detail.dispatchPlanning?.purchaseOrder?.planned === true',after:'detail.dispatchPlanning?.purchaseOrder?.planned === true',tests:[sequence],property:true},
    {name:'API-SO-planning-gate-bypassed',file:'src/special-stock-request-repository.js',before:"      assertBackorderOrderLink(detail, 'sales_order');",after:'',tests:[requests],pattern:'^Backorder SO linking requires'},
    {name:'API-PO-acceptance-gate-bypassed',file:'src/special-stock-request-repository.js',before:"if (special.workflow_kind === 'backorder') assertBackorderOrderLink({",after:'if (false) assertBackorderOrderLink({',tests:[requests],pattern:'^Backorder PO linking requires'},
    {name:'SO-does-not-complete-request',file:'public/backorder-workflow.js',before:"if (evidence.salesOrderId) return 'completed';",after:"if (evidence.salesOrderId && evidence.operationallyComplete) return 'completed';",tests:[focused[0]],property:true,propertyTests:[focused[0]]},
    {name:'Sales-replies-do-not-confirm',file:'public/backorder-workflow.js',before:"  if (evidence.linesResolved && evidence.hasAcceptedLines) return 'confirmed';",after:'',tests:[sequence],property:true},
    {name:'PO-link-does-not-advance-dispatch',file:'public/backorder-workflow.js',before:"if (evidence.purchaseOrderId) return 'dispatch_arrangement';",after:"if (evidence.purchaseOrderId) return 'confirmed';",tests:[sequence],property:true},
    {name:'all-rejected-case-can-reopen',file:'src/special-stock-request-repository.js',before:"  if (special.workflow_kind === 'backorder' && ['declined','closed'].includes(decision.decision)) {",after:'  if (false) {',tests:[requests],pattern:'^Backorder all rejected replies'},
    {name:'terminal-case-offers-manual-links',file:'public/backorder-stock-requests.js',before:"const active=d=>!['closed','completed'].includes(d.stage);",after:'const active=()=>true;',tests:[sequence],property:true},
    {name:'purchase-cost-input-restored',file:'public/backorder-stock-requests.js',before:"${label('salesVisibleNote','Note for Sales',line.salesVisibleNote)}",after:"${label('unitPurchaseCost','Unit purchase cost',line.unitPurchaseCost,'number')}${label('salesVisibleNote','Note for Sales',line.salesVisibleNote)}",tests:[browserTest],pattern:'^SCM and Sales review'},
    {name:'request-information-after-materials',file:'public/backorder-stock-requests.js',before:"${information}${header}${ask}\n      <section class=\"stock-request-section\"><h3>Materials</h3>${d.lines.map(line=>material(d,line)).join('')}</section>${pickup}${acknowledge}${close}",after:"${information}${header}\n      <section class=\"stock-request-section\"><h3>Materials</h3>${d.lines.map(line=>material(d,line)).join('')}</section>${pickup}${ask}${acknowledge}${close}",tests:[browserTest],pattern:'^SCM Request information'},
    {name:'queue-union-becomes-intersection',file:'src/stock-request-repository.js',before:"queueScopes.join(' OR ')",after:"queueScopes.join(' AND ')",tests:[requests],pattern:'^Combined SCM queues'},
    {name:'queue-parsing-preserves-duplicates',file:'public/stock-request-queue-filter.js',before:'return Object.keys(SCM_STOCK_QUEUES).filter(queue => selected.has(queue));',after:'return values.map(queue=>String(queue).trim().toLowerCase());',tests:[queueProperty],property:true,propertyTests:[queueProperty]},
    {name:'empty-queue-selection-means-Request',file:'public/stock-request-queue-filter.js',before:"if (value === '') return Object.keys(SCM_STOCK_QUEUES);",after:"if (value === '') return ['request'];",tests:[queueProperty],property:true,propertyTests:[queueProperty]},
    {name:'queue-Clear-button-unreachable',file:'public/scm-stock-requests.js',before:"'[data-scm-stock-action], [data-yard-filter-clear]'",after:"'[data-scm-stock-action], [data-yard-filter-clear=\"sourceLocationId\"], [data-yard-filter-clear=\"destinationLocationId\"]'",tests:['test/mbt/integration/regular-stock-resolution-browser.test.js'],pattern:'^changing queues discards'},
    {name:'SCM-can-attach-Sales-quotation',file:'src/backorder-request-service.js',before:"if (context.audience==='sales' && action==='quotation/link')",after:"if (action==='quotation/link')",tests:[requests],pattern:'^Backorder quotation attachments'},
    {name:'terminal-request-cannot-attach-quotation',file:'src/backorder-request-service.js',before:'await lockLocalCase(id,input,context,{allowTerminal:true});',after:'await lockLocalCase(id,input,context);',tests:[requests],pattern:'^Backorder NetSuite quotation'},
    {name:'quotation-revision-conflicts-ignored',file:'src/backorder-request-service.js',before:'Number(input.expectedRevision)!==Number(row.revision)',after:'false',tests:[requests],pattern:'^Backorder quotation attachments'},
    {name:'quotation-repeats-acknowledged-PO-notification',file:'src/backorder-request-service.js',before:"SELECT (event.details->>'requestRevision')::bigint AS revision,event.created_at",after:'SELECT request.revision AS revision,event.created_at',tests:[requests],pattern:'^Backorder PO linkage notifies'},
    {name:'terminal-quotation-UI-hidden',file:'public/backorder-stock-requests.js',before:"so?form(d,'quotation/link'",after:"so && active(d)?form(d,'quotation/link'",tests:[sequence],property:true},
    {name:'PO-link-message-omits-link-notification',file:'src/backorder-request-service.js',before:"'Backorder · PO linked: '",after:"'Backorder · '",tests:[browserTest],pattern:'^Sales gets a PO-linked notification'},
    {name:'Confirmed-stage-loses-SCM-ETA-reminders',file:'src/backorder-request-service.js',before:"stage.stage IN ('confirmed','dispatch_arrangement','wait_for_production')",after:"stage.stage='wait_for_production'",tests:[requests],pattern:'^Backorder Confirmed and PO-linked'},
    {name:'Backorder-PO-planning-blocked-by-Special-rule',file:'src/dispatch-plan-repository.js',before:"WHERE special.workflow_kind = 'special' AND (lower(btrim(special.sales_order_ref))",after:'WHERE (lower(btrim(special.sales_order_ref))',tests:[requests],pattern:'^Backorder reviewed manual references'},
    {name:'SQL-SO-link-does-not-complete-queue',file:'migrations/270_backorder_order_completion.sql',before:"    WHEN special.workflow_kind = 'backorder' AND special.sales_order_netsuite_id IS NOT NULL THEN 'completed'\n",after:'',tests:[requests],pattern:'^Backorder SO linkage completes'}
  ];
  const root=copyTree();const results=[];
  rmSync(root+'/migrations');cpSync('migrations',root+'/migrations',{recursive:true});
  try{for(const mutant of list.filter(value=>!only || value.name===only)){
    const source=readFileSync(mutant.file,'utf8');assert.equal(source.split(mutant.before).length,2,'Mutation anchor '+mutant.name);
    try{
      writeFileSync(root+'/'+mutant.file,source.replace(mutant.before,mutant.after));
      if(!mutant.property)resetDb('before-'+mutant.name,{cwd:root});
      const r=run('mutation-'+mutant.name,['--test','--test-concurrency=1',...(mutant.pattern?['--test-name-pattern='+mutant.pattern]:[]),...mutant.tests],{cwd:root,allowFailure:true});
      assert.equal(r.result.exit,1);assert.ok(r.result.fail>0);assert.ok(!r.log.includes("failureType: 'hookFailed'"));
      let propertyKilled=false;
      if(mutant.property){const p=run('property-mutation-'+mutant.name,['--test',...(mutant.propertyTests || [sequence])],{cwd:root,allowFailure:true});assert.equal(p.result.exit,1);assert.ok(p.result.fail>0);propertyKilled=true;}
      results.push({name:mutant.name,killed:true,propertyKilled,failures:failures(r.log)});
    }finally{writeFileSync(root+'/'+mutant.file,source);assert.equal(hash(readFileSync(root+'/'+mutant.file)),hash(readFileSync(mutant.file)));}
  }}finally{rmSync(root,{recursive:true,force:true});}
  writeFileSync(out+'/mutations.json',JSON.stringify(results,null,2));return results;
}
function reversedSuite(){
  const order=[...focused,browserTest,enhancementBrowser].sort().reverse();
  const result={label:'reversed',exit:0,tests:0,pass:0,fail:0,skipped:0,order},logs=[];
  for(const [index,file] of order.entries()){
    const check=run('reversed-'+index,['--test','--test-concurrency=1',file]);
    for(const field of ['tests','pass','fail','skipped'])result[field]+=check.result[field];
    logs.push(file+'\n'+check.log);
  }
  writeFileSync(out+'/reversed.log',logs.join('\n'));
  writeFileSync(out+'/reversed.json',JSON.stringify(result,null,2));
  return {result};
}
function changedWhitespace(){
  for(const file of runtime){
    const baseline='tools/backorder-review-flow-20261007/baseline/'+file;
    const diff=spawnSync('diff',['-U0',existsSync(baseline)?baseline:'/dev/null',file],{encoding:'utf8'}).stdout;
    assert.ok(!diff.split('\n').some(line=>line.startsWith('+')&&!line.startsWith('+++')&&/[ \t]+$/.test(line)),'Trailing whitespace: '+file);
  }
  return 'pass';
}
function changedCoverage(){
  const covered=Object.values(JSON.parse(readFileSync(out+'/coverage/coverage-final.json'))),roots=[process.cwd()];
  const browserEntries=readdirSync(out+'/browser').filter(name=>/coverage.*\.json$|\.coverage\.json$/.test(name)).flatMap(name=>JSON.parse(readFileSync(out+'/browser/'+name)));
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
    const old='tools/backorder-review-flow-20261007/baseline/'+file,source=readFileSync(file,'utf8'),sourceLines=source.split('\n');
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
  const result={total:lines.length,covered:lines.length-missing.length,lines,missing,annotationOnly:annotations,branches};
  writeFileSync(out+'/changed-coverage.json',JSON.stringify(result,null,2));assert.deepEqual(missing,[]);return result;
}
function finalChecks(regression){resetDb('before-focused-final');
  const final=run('focused-final',['--test','--test-concurrency=1',...focused,browserTest,enhancementBrowser]);
  resetDb('before-migration');run('migration-check',['tools/backorder-review-flow-20261007/migration-check.mjs']);
  resetDb('before-coverage');rmSync(out+'/browser',{recursive:true,force:true});
  run('coverage',['/app/node_modules/c8/bin/c8.js','--all=false','--check-coverage=false',...runtime.filter(file=>file.endsWith('.js')).map(file=>'--include='+file),`--temp-directory=${out}/c8`,`--report-dir=${out}/coverage`,'--reporter=json',process.execPath,'--test','--test-concurrency=1',...focused,browserTest,enhancementBrowser]);
  run('static-final',['tools/backorder-review-flow-20261007/check.mjs','static']);
  const coverage=changedCoverage(),mutation=mutations();resetDb('before-reversed');
  const reversed=reversedSuite();
  const taskTools=readdirSync('tools/backorder-review-flow-20261007').filter(file=>/\.(?:mjs|py|sql|json|md)$/.test(file));
  run('secrets',['test/support/scan-diff-secrets.mjs',...runtime,...focused,browserTest,enhancementBrowser,...taskTools.map(file=>'tools/backorder-review-flow-20261007/'+file)]);
  const whitespace=changedWhitespace();
  const summary={whitespace,regression,newFailures:regression.newFailures,focused:final.result,reversed:reversed.result,types:'pass',typeComparison:JSON.parse(readFileSync(out+'/types.json')),lint:'pass',changedLines:coverage,mutations:mutation,
    manifest:Object.fromEntries(runtime.map(file=>[file,hash(readFileSync(file))])),
    dependencyLockHash:hash(readFileSync('package-lock.json')),testManifest:Object.fromEntries([...focused,browserTest,enhancementBrowser].map(file=>[file,hash(readFileSync(file))])),
    toolManifest:Object.fromEntries(taskTools.map(file=>[file,hash(readFileSync('tools/backorder-review-flow-20261007/'+file))])),node:process.version,
    versions:Object.fromEntries(['@playwright/test','c8','typescript','eslint','fast-check','espree'].map(name=>[name,JSON.parse(readFileSync('/app/node_modules/'+name+'/package.json')).version]))};
  writeFileSync(out+'/summary.json',JSON.stringify(summary,null,2));console.log(JSON.stringify({gauntlet:'pass',focused:summary.focused,changed:coverage.total,mutants:mutation.length}));
}

if(mode==='reminder-red'){const r=run('reminder-red',['--test','--test-name-pattern=^Backorder Confirmed and PO-linked',focused[1]],{allowFailure:true});assert.equal(r.result.exit,1);assert.equal(r.result.fail,1);assert.ok(!r.log.includes("failureType: 'hookFailed'"));}
else if(mode==='quotation-red'){const r=run('quotation-red-api',['--test','--test-name-pattern=^Backorder NetSuite quotation|^Backorder quotation attachments|^Backorder PO linkage notifies',focused[1]],{allowFailure:true});assert.equal(r.result.exit,1);assert.equal(r.result.fail,3);const b=run('quotation-red-browser',['--test','--test-name-pattern=^Sales attaches the NetSuite',browserTest],{allowFailure:true});assert.equal(b.result.exit,1);assert.equal(b.result.fail,1);assert.ok(!b.log.includes("failureType: 'hookFailed'"));}
else if(mode==='resolution')run('resolution',['--test','test/mbt/integration/regular-stock-resolution-browser.test.js']);
else if(mode==='status-red'){const r=run('status-red',['--test','--test-name-pattern=^Backorder Sales replies become|^Backorder all rejected replies',focused[1]],{allowFailure:true});assert.equal(r.result.exit,1);assert.equal(r.result.fail,2);assert.ok(!r.log.includes("failureType: 'hookFailed'"));}
else if(mode==='queue-red'){const r=run('queue-red-api',['--test','--test-name-pattern=^Combined SCM queues',focused[1]],{allowFailure:true});assert.equal(r.result.exit,1);assert.equal(r.result.fail,1);const b=run('queue-red-browser',['--test','--test-name-pattern=^SCM Regular queue filter',browserTest],{allowFailure:true});assert.equal(b.result.exit,1);assert.equal(b.result.fail,1);assert.ok(!b.log.includes("failureType: 'hookFailed'"));}
else if(mode==='corrected-red'){for(const [label,tests,pattern,fail] of [['api',[focused[1]],'^Backorder PO linking requires|^Backorder SO linking requires|^Backorder material changes revoke|^Backorder with every',4],['completion',[focused[0]],'^Backorder completes on SO',1],['properties',['test/mbt/property/backorder-link-sequence.property.test.js'],'^Sales SO form|^SCM PO form',2]]){const r=run('corrected-red-'+label,['--test','--test-concurrency=1','--test-name-pattern='+pattern,...tests],{allowFailure:true});assert.equal(r.result.exit,1);assert.equal(r.result.fail,fail);assert.ok(!r.log.includes("failureType: 'hookFailed'"));}}
else if(mode==='enhancement-red'){const r=run('enhancement-red',['--test','--test-concurrency=1','test/mbt/integration/backorder-routing.test.js','test/mbt/property/backorder-routing.property.test.js'],{allowFailure:true});assert.equal(r.result.exit,1);assert.ok(r.result.fail>=4);assert.ok(!r.log.includes("failureType: 'hookFailed'"));}
else if(mode==='approval-red'){const r=run('approval-red',['--test','--test-name-pattern=^SCM and Sales review',browserTest],{allowFailure:true});assert.equal(r.result.exit,1);assert.equal(r.result.fail,1);assert.ok(!r.log.includes("failureType: 'hookFailed'"));}
else if(mode==='uom-red'){const r=run('uom-red',['--test','--test-name-pattern=^Backorder accepts the Regular|^Backorder keeps the Regular',focused[1]],{allowFailure:true});assert.equal(r.result.exit,1);assert.equal(r.result.fail,2);assert.ok(!r.log.includes("failureType: 'hookFailed'"));}
else if(mode==='alerts-red'){const r=run('alerts-red',['--test','--test-name-pattern=^Manual Backorder links',focused[1]],{allowFailure:true});assert.equal(r.result.exit,1);assert.equal(r.result.fail,2);assert.ok(!r.log.includes("failureType: 'hookFailed'"));}
else if(mode==='schema-red'){const r=run('schema-red',['--test','--test-name-pattern=^Backorder schema',focused[1]],{allowFailure:true});assert.equal(r.result.exit,1);assert.ok(r.result.fail>0);assert.ok(!r.log.includes("failureType: 'hookFailed'"));}
else if(mode==='price-red'){const r=run('price-red',['--test','--test-name-pattern=^Backorder quote price',focused[1]],{allowFailure:true});assert.equal(r.result.exit,1);assert.ok(r.result.fail>0);assert.ok(!r.log.includes("failureType: 'hookFailed'"));}
else if(mode==='worker-red'){const r=run('worker-red',['--test','--test-name-pattern=^Order webhooks',focused[1]],{allowFailure:true});assert.equal(r.result.exit,1);assert.ok(r.result.fail>0);assert.ok(!r.log.includes("failureType: 'hookFailed'"));}
else if(mode==='red'){
  const {log,result}=run('red',['--test','--test-concurrency=1',...focused],{allowFailure:true});
  assert.equal(result.exit,1);assert.ok(result.fail>=8);assert.ok(!log.includes("failureType: 'hookFailed'"),'RED must fail behavior, not setup');
}else if(mode==='browser-red'){const r=run('browser-red',['--test',enhancementBrowser],{allowFailure:true});assert.equal(r.result.exit,1);assert.equal(r.result.fail,2);assert.ok(!r.log.includes("failureType: 'hookFailed'"));
}else if(mode==='ui-contract'){
  const root=copyTree(true);
  try{const prior=run('ui-contract-baseline',['--test','test/mbt/unit/stock-request-ui-contract.test.js'],{cwd:root,allowFailure:true});
    const next=run('ui-contract',['--test','test/mbt/unit/stock-request-ui-contract.test.js'],{allowFailure:true});
    assert.deepEqual(failures(next.log),failures(prior.log));
    writeFileSync(out+'/ui-contract-comparison.json',JSON.stringify({baseline:prior.result,candidate:next.result,newFailures:[],existingFailures:failures(prior.log)},null,2));
  }finally{rmSync(root,{recursive:true,force:true});}
}
else if(mode==='browser')run('browser',['--test','--test-concurrency=1',browserTest,enhancementBrowser]);
else if(mode==='preflight'){run('quotation-browser-preflight',['--test','--test-name-pattern=^Sales attaches the NetSuite|^Sales gets a PO-linked',browserTest]);run('migration-check',['tools/backorder-review-flow-20261007/migration-check.mjs']);run('static-preflight',['tools/backorder-review-flow-20261007/check.mjs','static']);}
else if(mode==='quick'){run('focused',['--test','--test-concurrency=1',...focused,browserTest,enhancementBrowser]);run('static-check',['tools/backorder-review-flow-20261007/check.mjs','static']);}
else if(mode==='migration')run('migration-check',['tools/backorder-review-flow-20261007/migration-check.mjs']);
else if(mode==='mutations')mutations();
else if(mode==='stage-mutation')mutations({only:'scm-stage-filter-omitted'});
else if(mode==='coverage-audit'){assert.equal(annotationOnlyLines('const total=1n;\n','// shifted source\nconst total=(/** @type {bigint} */ (1n));\n').has(2),true);assert.equal(annotationOnlyLines('const total=1n;\n','const total=2n;\n').has(1),false);changedCoverage();}
else if(mode==='coverage'){
  rmSync(out+'/browser',{recursive:true,force:true});
  run('coverage',['/app/node_modules/c8/bin/c8.js','--all=false','--check-coverage=false',...runtime.filter(file=>file.endsWith('.js')).map(file=>'--include='+file),`--temp-directory=${out}/c8`,`--report-dir=${out}/coverage`,'--reporter=json',process.execPath,'--test','--test-concurrency=1',...focused,browserTest,enhancementBrowser]);
  changedCoverage();
}
else if(mode==='regression')regressions();
else if(mode==='all')finalChecks(regressions());
else if(mode==='repair-fixture'){
  const regression=JSON.parse(readFileSync(out+'/regressions.json'));
  const name='regular-db: Entered stocking customer persists and appears in Sales and SCM cards and details for Transfer and Purchase';
  assert.deepEqual(regression.newFailures,[name]);
  for(const folder of readdirSync(out).filter(value=>value.startsWith('coverage-regression-'))){
    const identity=JSON.parse(readFileSync(out+'/'+folder+'/source.json'));
    assert.ok(Object.entries(identity.manifest).every(([file,value])=>value===hash(readFileSync(file))),'Runtime changed since full comparison');
  }
  writeFileSync(out+'/regressions-before-fixture-replay.json',JSON.stringify(regression,null,2));
  resetDb('before-fixture-replay');
  const file='test/mbt/integration/stocking-customer-browser.test.js';
  const replay=run('stocking-customer-fixture-replay',['--test',file]);
  assert.equal(replay.result.tests,1);assert.equal(replay.result.pass,1);assert.equal(replay.result.fail,0);
  const index=regression.candidate.failures.indexOf(name);assert.ok(index>=0);
  regression.candidate.failures.splice(index,1);regression.candidate.fail--;regression.candidate.pass++;
  const group=regression.candidate.groups.find(value=>value.label==='candidate-regular-db');
  assert.ok(group);group.fail--;group.pass++;group.fixtureReplay={...replay.result,file,sha256:hash(readFileSync(file)),replacedFailure:name};
  const remaining=[...regression.baseline.failures];
  regression.newFailures=regression.candidate.failures.filter(value=>{const found=remaining.indexOf(value);if(found<0)return true;remaining.splice(found,1);return false;});
  assert.deepEqual(regression.newFailures,[]);
  writeFileSync(out+'/regressions.json',JSON.stringify(regression,null,2));
  finalChecks(regression);
}
else if(mode==='finish'){
  for(const name of readdirSync(out).filter(value=>value.startsWith('coverage-regression-'))){
    const identity=JSON.parse(readFileSync(out+'/'+name+'/source.json'));
    assert.ok(Object.entries(identity.manifest).every(([file,value])=>value===hash(readFileSync(file))),'Regression source drift');
  }
  const regression=JSON.parse(readFileSync(out+'/regressions.json'));assert.deepEqual(regression.newFailures,[]);
  finalChecks(regression);
}
else if(mode==='static'){
  const files=JSON.parse(readFileSync('tools/backorder-review-flow-20261007/files.json')).filter(file=>file.endsWith('.js'));
  const args=['/app/node_modules/typescript/bin/tsc','--noEmit','--allowJs','--checkJs','--skipLibCheck','--types','node','--target','ES2022','--module','NodeNext'];
  const root=mkdtempSync('/tmp/mbbs-backorder-types-');
  try{
    for(const folder of ['src','public'])cpSync('tools/backorder-review-flow-20261007/baseline/'+folder,root+'/'+folder,{recursive:true});
    for(const folder of ['node_modules','tools','migrations','contracts'])symlinkSync(resolve(folder),root+'/'+folder);
    cpSync('package.json',root+'/package.json');
    run('types-baseline',[...args,...files.filter(file=>existsSync('tools/backorder-review-flow-20261007/baseline/'+file))],{allowFailure:true,cwd:root});
    run('types-candidate',[...args,...files],{allowFailure:true});
    const messages=label=>readFileSync(out+'/'+label+'.log','utf8').split('\n').filter(line=>/error TS\d+:/.test(line)).map(line=>line.replace(/\(\d+,\d+\)/,'').replace(/error TS2551: (.*) Did you mean '[^']+'\?/u,'error TS2339: $1'));
    const baseline=messages('types-baseline'),candidate=messages('types-candidate'),remaining=[...baseline];
    const added=candidate.filter(message=>{const index=remaining.indexOf(message);if(index<0)return true;remaining.splice(index,1);return false;});
    writeFileSync(out+'/types-new-errors.json',JSON.stringify(added,null,2));writeFileSync(out+'/types.json',JSON.stringify({baseline:baseline.length,candidate:candidate.length,newErrors:added.length},null,2));
    assert.deepEqual(added,[]);
    run('lint',['tools/backorder-review-flow-20261007/lint.mjs']);
    for(const file of files)run('syntax-'+file.split('/').at(-1),['--check',file]);
  }finally{rmSync(root,{recursive:true,force:true});}
}
else if(mode==='baseline'){
  const tests=['unit','property','integration'].flatMap(kind=>readdirSync('test/mbt/'+kind).filter(name=>/^(?:(?:regular-stock|regular-waitlist)[.-]|stock-request-|stocking-).*\.test\.js$/.test(name)).sort().map(name=>'test/mbt/'+kind+'/'+name));
  const root=mkdtempSync('/tmp/mbbs-backorder-baseline-');
  try{
    for(const folder of ['src','public'])cpSync('tools/backorder-review-flow-20261007/baseline/'+folder,root+'/'+folder,{recursive:true});
    cpSync('test',root+'/test',{recursive:true});
    for(const folder of ['node_modules','tools','migrations','contracts'])symlinkSync(resolve(folder),root+'/'+folder);
    cpSync('package.json',root+'/package.json');
    mkdirSync(root+'/test-artifacts',{recursive:true});
    run('baseline',['--test','--test-concurrency=1',...tests],{allowFailure:true,cwd:root});
  }finally{rmSync(root,{recursive:true,force:true});}
}else run('focused',['--test','--test-concurrency=1',...focused]);
