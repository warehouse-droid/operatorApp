import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,writeFileSync,readdirSync,cpSync,symlinkSync,mkdtempSync,rmSync,openSync,closeSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
assert.equal(new URL(process.env.DATABASE_URL).hostname,'mbbs-special-review-db');
const out='test-artifacts/special-po-reference-only-20261006';mkdirSync(out,{recursive:true});
const focused=['test/mbt/unit/special-po-reference-only-service.test.js','test/mbt/integration/special-po-reference-only.test.js','test/mbt/integration/special-po-reference-only-browser.test.js'];
const coreFocused=[...focused];
focused.push('test/mbt/integration/special-manual-so-link.test.js','test/mbt/integration/special-custom-po-http.test.js','test/mbt/integration/special-po-unsubmitted-link-http.test.js','test/mbt/unit/special-manual-so-ui.browser.test.js');
const runtime=JSON.parse(readFileSync('tools/special-po-reference-only-20261006/files.json'));
const mode=process.argv.at(-1),hash=value=>createHash('sha256').update(value).digest('hex');
const counts=log=>Object.fromEntries(['tests','pass','fail','skipped'].map(key=>[key,Number(log.match(new RegExp(`^# ${key} (\\d+)$`,'m'))?.[1]||0)]));
const failures=log=>[...log.matchAll(/^not ok \d+ - (.+?)(?: # SKIP.*?)?$/gm)].filter(match=>!match[0].includes(' # SKIP')).map(match=>match[1].replace(/^.*?(?=\/test\/mbt\/)/,''));
function run(label,args,{cwd=process.cwd(),red=false,baseline=false}={}){
  const fd=openSync(resolve(`${out}/${label}.log`),'w');let result;
  try{result=spawnSync(process.execPath,args,{cwd,timeout:600000,stdio:['ignore',fd,fd]});}finally{closeSync(fd);}
  const log=readFileSync(`${out}/${label}.log`,'utf8');console.log(JSON.stringify({label,exit:result.status,...counts(log)}));
  if(red){assert.equal(result.status,1,label);assert.ok(counts(log).fail>0);assert.ok(!log.includes("failureType: 'hookFailed'"),'Setup failure is not a reproduced bug');}
  else if(!baseline)assert.equal(result.status,0,`${label}: ${log.slice(-3500)}`);
  assert.notEqual(result.status,null,label+' timed out');return {counts:counts(log),failures:failures(log)};
}
function copyTree(){
  const root=mkdtempSync('/tmp/mbbs-special-po-reference-only-');
  for(const folder of ['src','public','test'])cpSync(folder,root+'/'+folder,{recursive:true});
  for(const folder of ['node_modules','tools','migrations','contracts'])symlinkSync(resolve(folder),root+'/'+folder);
  for(const file of readdirSync('.').filter(name=>name.endsWith('.js')||name==='package.json'))cpSync(file,root+'/'+file);
  mkdirSync(root+'/test-artifacts/stocking-replies-20261006',{recursive:true});return root;
}
if(mode==='red'){
  const root=copyTree();try{for(const file of runtime)writeFileSync(root+'/'+file,readFileSync('tools/special-po-reference-only-20261006/baseline/'+file));
    for(const file of coreFocused)run('red-'+file.split('/').at(-1),['--test',file],{red:true,cwd:root});
  }finally{rmSync(root,{recursive:true,force:true});}
}
else if(mode==='focused')run('focused',['--test','--test-concurrency=1',...focused]);
else{
  const roots=[];try{
    const tests=['unit','property','integration'].flatMap(kind=>readdirSync('test/mbt/'+kind).filter(name=>/^special-.*\.test\.js$/.test(name)).sort().map(name=>'test/mbt/'+kind+'/'+name));
    let baseline,candidate;
    if(mode==='audit'||mode==='candidate'){
      const old=readFileSync(`${out}/baseline.log`,'utf8');baseline={counts:counts(old),failures:failures(old)};
      if(mode==='candidate'){const next=copyTree();roots.push(next);candidate=run('candidate',['--test','--test-concurrency=1',...tests],{cwd:next,baseline:true});}
      else {const next=readFileSync(`${out}/candidate.log`,'utf8');candidate={counts:counts(next),failures:failures(next)};}
    }else{
      const old=copyTree();roots.push(old);for(const file of runtime)writeFileSync(old+'/'+file,readFileSync('tools/special-po-reference-only-20261006/baseline/'+file));
      baseline=run('baseline',['--test','--test-concurrency=1',...tests],{cwd:old,baseline:true});
      run('reset-test-db',['--input-type=module','-e',`import pg from 'pg';const url=new URL(process.env.DATABASE_URL);if(url.hostname!=='mbbs-special-review-db'||url.pathname!=='/mbt_verify')throw Error('Not isolated');url.pathname='/mbt_test';const c=new pg.Client({connectionString:url.href});try{await c.connect();await c.query('DROP DATABASE mbt_verify WITH (FORCE)');await c.query('CREATE DATABASE mbt_verify');}finally{await c.end();}`]);
      run('candidate-migrate',['src/migrate.js']);
      const next=copyTree();roots.push(next);candidate=run('candidate',['--test','--test-concurrency=1',...tests],{cwd:next,baseline:true});
    }
    const newFailures=candidate.failures.filter(name=>!baseline.failures.includes(name));
    writeFileSync(`${out}/new-failures.json`,JSON.stringify(newFailures,null,2));assert.deepEqual(newFailures,[]);
    const final=run('focused-final',['--test','--test-concurrency=1',...focused]);
    run('coverage',['/app/node_modules/c8/bin/c8.js','--all=false','--check-coverage=false',...runtime.filter(f=>f.endsWith('.js')).map(f=>'--include='+f),
      `--temp-directory=${out}/c8`,`--report-dir=${out}/coverage`,'--reporter=json',process.execPath,'--test','--test-concurrency=1',...focused]);
    const typeArgs=['/app/node_modules/typescript/bin/tsc','--noEmit','--allowJs','--checkJs','--skipLibCheck','--types','node','--target','ES2022','--module','NodeNext',...runtime.filter(file=>file.endsWith('.js'))];
    const typeRoot=copyTree();roots.push(typeRoot);for(const file of runtime)writeFileSync(typeRoot+'/'+file,readFileSync('tools/special-po-reference-only-20261006/baseline/'+file));
    run('types-baseline',typeArgs,{cwd:typeRoot,baseline:true});run('types-candidate',typeArgs,{baseline:true});
    const diagnostics=label=>readFileSync(`${out}/${label}.log`,'utf8').split('\n').filter(line=>/error TS\d+:/.test(line)).map(line=>line.replace(/\(\d+,\d+\)/,''));
    const baselineTypes=diagnostics('types-baseline'),candidateTypes=diagnostics('types-candidate');
    const remainingTypes=[...baselineTypes];
    const newTypeErrors=candidateTypes.filter(value=>{const index=remainingTypes.indexOf(value);if(index<0)return true;remainingTypes.splice(index,1);return false;});writeFileSync(`${out}/types-new-errors.json`,JSON.stringify(newTypeErrors,null,2));assert.deepEqual(newTypeErrors,[]);

    run('lint',['/app/node_modules/eslint/bin/eslint.js','--config','tools/special-so-preview-20261006/eslint.config.mjs','--max-warnings=0',...runtime.filter(f=>f.endsWith('.js')),...focused,'tools/special-po-reference-only-20261006/check.mjs']);
    for(const file of runtime.filter(f=>f.endsWith('.js')))run('syntax-'+file.split('/').at(-1),['--check',file]);
    const covered=JSON.parse(readFileSync(`${out}/coverage/coverage-final.json`)),changed=[];
    const browserEntries=readdirSync(`${out}/custom-browser`).filter(name=>/^coverage-\d+\.json$/.test(name))
      .flatMap(name=>JSON.parse(readFileSync(`${out}/custom-browser/${name}`)));
    const salesCoverage='test-artifacts/special-so-link-sqft-20261006/browser-coverage.json';
    if(existsSync(salesCoverage)){writeFileSync(`${out}/sales-browser-coverage.json`,readFileSync(salesCoverage));browserEntries.push(...JSON.parse(readFileSync(salesCoverage)));}
    for(const file of runtime.filter(f=>f.endsWith('.js'))){
      const diff=spawnSync('diff',['-U0','tools/special-po-reference-only-20261006/baseline/'+file,file],{encoding:'utf8'}).stdout;
      const source=readFileSync(file,'utf8'),browser=file.startsWith('public/');
      const entries=browserEntries.filter(entry=>entry.url.includes('/'+file.split('/').at(-1))&&entry.source===source);
      const entry=Object.values(covered).find(value=>value.path.endsWith('/'+file));
      assert.ok(browser?entries.length:entry);let line=0;
      for(const text of diff.split('\n')){
        const hunk=text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);if(hunk)line=Number(hunk[1]);
        else if(text.startsWith('+')&&!text.startsWith('+++')){
          if(browser){
            const text=source.split('\n')[line-1],trim=text.trim();
            if(trim&&!trim.startsWith('//')&&!/^[{});]+$/.test(trim)){
              const offset=source.split('\n').slice(0,line-1).join('\n').length+(line>1?1:0)+text.indexOf(trim);
              assert.ok(entries.some(entry=>entry.functions.flatMap(fn=>fn.ranges).filter(range=>range.startOffset<=offset&&range.endOffset>offset)
                .sort((a,b)=>(a.endOffset-a.startOffset)-(b.endOffset-b.startOffset))[0]?.count>0),`Uncovered ${file}:${line}`);
              changed.push(file+':'+line);
            }
          }else{
            const statements=Object.entries(entry.statementMap).filter(([,value])=>value.start.line<=line&&value.end.line>=line);
            if(statements.length){assert.ok(statements.some(([key])=>entry.s[key]>0),`Uncovered ${file}:${line}`);changed.push(file+':'+line);}
          }
          line++;
        }else if(!text.startsWith('-')&&!text.startsWith('\\'))line++;
      }
    }
    const mutations=[
      {name:'require-manual-so-business-release',file:runtime[0],before:'if (!manual) assertSpecialOrderRelease((await lineRows(id)).map(mapLine));',after:'assertSpecialOrderRelease((await lineRows(id)).map(mapLine));',tests:[focused[1]]},
      {name:'require-manual-po-business-release',file:runtime[0],before:'if (!custom) assertSpecialPurchaseRelease((await lineRows(id, { forUpdate: true })).map(mapLine));',after:'assertSpecialPurchaseRelease((await lineRows(id, { forUpdate: true })).map(mapLine));',tests:[focused[1]]},
      {name:'omit-po-first-handoff',file:runtime[0],before:"if (manual && special.purchase_order_netsuite_id && special.close_status === 'active'",after:"if (false && special.purchase_order_netsuite_id && special.close_status === 'active'",tests:[focused[1]]},
      {name:'omit-purchase-insert',file:runtime[0],before:'if (independentPurchase) {',after:'if (false) {',tests:[focused[1]]},
      {name:'synchronize-manual-so',file:runtime[1],before:'claimed.salesOrderId && !independentPurchase ? claimed.purchaseOrderLines',after:'claimed.salesOrderId ? claimed.purchaseOrderLines',tests:[focused[0]],property:true},
      {name:'recover-native-po-for-manual-so',file:runtime[1],before:'findLinkedOrder: independentPurchase ? null : async () =>',after:'findLinkedOrder: async () =>',tests:[focused[0]],property:true},
      {name:'hide-request-materials',file:runtime[2],before:"const independentPurchase = detail.salesOrderSource === 'manual_link';",after:'const independentPurchase = false;',tests:[focused[2]]}
    ];
    const mutationRoot=copyTree();roots.push(mutationRoot);const mutationResults=[];
    for(const mutant of mutations){
      const source=readFileSync(mutant.file,'utf8');assert.equal(source.split(mutant.before).length,2,mutant.name);
      try{writeFileSync(mutationRoot+'/'+mutant.file,source.replace(mutant.before,mutant.after));
        run('mutation-'+mutant.name,['--test','--test-concurrency=1',...mutant.tests],{cwd:mutationRoot,red:true});
        if(mutant.property)run('property-mutation-'+mutant.name,['--test','--test-name-pattern=^property:',...mutant.tests],{cwd:mutationRoot,red:true});
        mutationResults.push({name:mutant.name,killed:true,propertyKilled:mutant.property||false});
      }finally{writeFileSync(mutationRoot+'/'+mutant.file,source);}
    }
    const order=run('reversed-order',['--test','--test-concurrency=1',...focused.toReversed()]);
    run('secrets',['test/support/scan-diff-secrets.mjs',...runtime,...focused,'tools/special-po-reference-only-20261006/check.mjs','tools/special-po-reference-only-20261006/run.py']);
    const summary={baseline:baseline.counts,baselineFailures:baseline.failures,candidate:candidate.counts,candidateFailures:candidate.failures,newFailures,focused:final.counts,
      types:'pass',typeComparison:{baseline:baselineTypes.length,candidate:candidateTypes.length,newErrors:newTypeErrors},lint:'pass',changedLines:{total:changed.length,covered:changed.length,lines:changed},mutations:mutationResults,order:order.counts,
      manifest:Object.fromEntries(runtime.map(file=>[file,hash(readFileSync(file))])),node:process.version};
    writeFileSync(`${out}/summary.json`,JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
  }finally{for(const root of roots)rmSync(root,{recursive:true,force:true});}
}
