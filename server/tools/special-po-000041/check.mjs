import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,readdirSync,cpSync,symlinkSync,mkdtempSync,rmSync,openSync,closeSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
assert.equal(new URL(process.env.DATABASE_URL).hostname,'mbbs-special-review-db');
assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED,'false');
const out='test-artifacts/special-po-000041';mkdirSync(out,{recursive:true});
const unit='test/mbt/unit/special-po-pallet-recovery.test.js';
const http='test/mbt/integration/special-po-unsubmitted-link-http.test.js';
const browser='test/mbt/integration/stock-request-audit-scroll-browser.test.js';
const runtime=['src/special-stock-native-po-adapter.js','src/special-stock-request-repository.js',
  'public/stock-requests.css','public/sales-stock-requests.html','public/scm-stock-requests.html'];
const mode=process.argv.at(-1),hash=value=>createHash('sha256').update(value).digest('hex');
const counts=log=>Object.fromEntries(['tests','pass','fail','skipped'].map(key=>[key,Number(log.match(new RegExp(`^# ${key} (\\d+)$`,'m'))?.[1]||0)]));
const failures=log=>[...log.matchAll(/^not ok \d+ - (.+?)(?: # SKIP.*?)?$/gm)].filter(match=>!match[0].includes(' # SKIP')).map(match=>match[1].replace(/^.*?(?=\/test\/mbt\/)/,''));
function run(label,args,{cwd=process.cwd(),red=false,baseline=false}={}) {
  const fd=openSync(resolve(`${out}/${label}.log`),'w');let result;
  try{result=spawnSync(process.execPath,args,{cwd,timeout:600000,stdio:['ignore',fd,fd]});}finally{closeSync(fd);}
  const log=readFileSync(`${out}/${label}.log`,'utf8');console.log(JSON.stringify({label,exit:result.status,...counts(log)}));
  if(red){assert.equal(result.status,1,label);assert.ok(counts(log).fail>0);assert.ok(!log.includes("failureType: 'hookFailed'"),'Setup failures do not prove behavior');}
  else if(!baseline)assert.equal(result.status,0,`${label}: ${log.slice(-3500)}`);
  assert.notEqual(result.status,null,label+' timed out');return {counts:counts(log),failures:failures(log)};
}
function copyTree() {
  const root=mkdtempSync('/tmp/mbbs-special-po-000041-');
  for(const folder of ['src','public','test'])cpSync(folder,root+'/'+folder,{recursive:true});
  for(const folder of ['node_modules','tools','migrations','contracts'])symlinkSync(resolve(folder),root+'/'+folder);
  for(const file of readdirSync('.').filter(name=>name.endsWith('.js')||name==='package.json'))cpSync(file,root+'/'+file);
  mkdirSync(root+'/test-artifacts/stocking-replies-20261006',{recursive:true});return root;
}
if(mode==='red-scroll')run('red-scroll',['--test',browser],{red:true});
else if(mode==='red') {
  run('red-unit',['--test',unit],{red:true});
  run('red-http',['--test','--test-name-pattern=unsubmitted failed|preserves unrelated',http],{red:true});
  run('red-scroll',['--test',browser],{red:true});
}else if(mode==='focused')run('focused',['--test','--test-concurrency=1',unit,http,browser]);
else{
  const roots=[];try{
    const tests=['unit','property','integration'].flatMap(kind=>readdirSync('test/mbt/'+kind).filter(name=>/^special-.*\.test\.js$/.test(name)).sort().map(name=>'test/mbt/'+kind+'/'+name));
    tests.push(browser,'test/mbt/unit/stock-request-view.test.js');
    let baseline,candidate;
    if(mode==='audit'){
      const old=readFileSync(`${out}/baseline.log`,'utf8'),next=readFileSync(`${out}/candidate.log`,'utf8');
      baseline={counts:counts(old),failures:failures(old)};candidate={counts:counts(next),failures:failures(next)};
    }else{
      const old=copyTree();roots.push(old);for(const file of runtime)writeFileSync(old+'/'+file,readFileSync('tools/special-po-000041/baseline/'+file));
      baseline=run('baseline',['--test','--test-concurrency=1',...tests],{cwd:old,baseline:true});
      run('reset-test-db',['--input-type=module','-e',`import pg from 'pg';const url=new URL(process.env.DATABASE_URL);if(url.hostname!=='mbbs-special-review-db'||url.pathname!=='/mbt_verify')throw Error('Not isolated');url.pathname='/mbt_test';const c=new pg.Client({connectionString:url.href});try{await c.connect();await c.query('DROP DATABASE mbt_verify WITH (FORCE)');await c.query('CREATE DATABASE mbt_verify');}finally{await c.end();}`]);
      run('candidate-migrate',['src/migrate.js']);
      const next=copyTree();roots.push(next);candidate=run('candidate',['--test','--test-concurrency=1',...tests],{cwd:next,baseline:true});
    }
    const newFailures=candidate.failures.filter(name=>!baseline.failures.includes(name));
    writeFileSync(`${out}/new-failures.json`,JSON.stringify(newFailures,null,2));assert.deepEqual(newFailures,[]);
    const focused=run('focused-final',['--test','--test-concurrency=1',unit,http,browser]);
    run('coverage',['/app/node_modules/c8/bin/c8.js','--all=false','--check-coverage=false',`--include=${runtime[0]}`,`--include=${runtime[1]}`,
      `--temp-directory=${out}/c8`,`--report-dir=${out}/coverage`,'--reporter=json',process.execPath,
      '--test','--test-concurrency=1',unit,http,browser]);
    run('types',['/app/node_modules/typescript/bin/tsc','--noEmit','--allowJs','--checkJs','--skipLibCheck','--types','node','--target','ES2022','--module','NodeNext',runtime[0]]);
    run('lint',['/app/node_modules/eslint/bin/eslint.js','--config','tools/special-so-preview-20261006/eslint.config.mjs','--max-warnings=0',...runtime.filter(name=>name.endsWith('.js')),unit,http,browser,'tools/special-po-000041/check.mjs']);
    for(const file of runtime.filter(name=>name.endsWith('.js')))run('syntax-'+file.split('/').at(-1),['--check',file]);
    const covered=JSON.parse(readFileSync(`${out}/coverage/coverage-final.json`)),changed=[];
    for(const file of runtime.filter(name=>name.endsWith('.js'))){
      const diff=spawnSync('diff',['-U0','tools/special-po-000041/baseline/'+file,file],{encoding:'utf8'}).stdout;
      const entry=Object.values(covered).find(value=>value.path.endsWith('/'+file));assert.ok(entry);let line=0;
      for(const text of diff.split('\n')){
        const hunk=text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);if(hunk)line=Number(hunk[1]);
        else if(text.startsWith('+')&&!text.startsWith('+++')){
          const statements=Object.entries(entry.statementMap).filter(([,value])=>value.start.line<=line&&value.end.line>=line);
          if(statements.length){assert.ok(statements.some(([key])=>entry.s[key]>0),`Uncovered ${file}:${line}`);changed.push(file+':'+line);}line++;
        }
      }
    }
    const mutationRoot=copyTree();roots.push(mutationRoot);
    const mutations=[
      {name:'pallet-as-material',file:runtime[0],before:"itemId === '1784' ? l.ancillary && l.itemId === 1784",after:"itemId === '1784' ? false",tests:[unit],property:true},
      {name:'ignore-material-uom',file:runtime[0],before:'ref(line.units) !== ref(item.units)',after:'false',tests:[unit],property:true},
      {name:'ignore-sales-price',file:runtime[0],before:'Number(line.rate) !== Number(expected[0].rate)',after:'false',tests:[unit],property:true},
      {name:'leave-manual-lock',file:runtime[1],before:"const recoverUnsubmitted = custom && special.purchase_order_operation_status === 'attention'",after:'const recoverUnsubmitted = false',tests:[http]},
      {name:'mobile-scroll-trap',file:runtime[2],before:'.stock-request-detail { overflow: visible; overscroll-behavior: auto; }',after:'.stock-request-detail { overflow: auto; overscroll-behavior: contain; }',tests:[browser]}
    ],mutationResults=[];
    for(const mutant of mutations){
      const source=readFileSync(mutant.file,'utf8');assert.equal(source.split(mutant.before).length,2,mutant.name);
      try{
        writeFileSync(mutationRoot+'/'+mutant.file,source.replace(mutant.before,mutant.after));
        run('mutation-'+mutant.name,['--test','--test-concurrency=1',...mutant.tests],{cwd:mutationRoot,red:true});
        if(mutant.property)run('property-mutation-'+mutant.name,['--test','--test-name-pattern=^property:',unit],{cwd:mutationRoot,red:true});
        mutationResults.push({name:mutant.name,killed:true,propertyKilled:mutant.property||false});
      }finally{writeFileSync(mutationRoot+'/'+mutant.file,source);}
    }
    const order=run('reversed-order',['--test','--test-concurrency=1',browser,http,unit]);
    run('secrets',['test/support/scan-diff-secrets.mjs',...runtime,unit,http,browser,'tools/special-po-000041/check.mjs','tools/special-po-000041/run.py']);
    const summary={baseline:baseline.counts,baselineFailures:baseline.failures,candidate:candidate.counts,candidateFailures:candidate.failures,
      newFailures,focused:focused.counts,changedLines:{total:changed.length,covered:changed.length,lines:changed},mutations:mutationResults,
      reversedOrder:order.counts,types:'pass',lint:'pass',manifest:Object.fromEntries([...runtime,unit,http,browser].map(file=>[file,hash(readFileSync(file))])),
      tools:{node:process.version,...Object.fromEntries(['typescript','eslint','c8','fast-check','@playwright/test'].map(name=>[name,JSON.parse(readFileSync('node_modules/'+name+'/package.json')).version]))}};
    writeFileSync(`${out}/summary.json`,JSON.stringify(summary,null,2));console.log(JSON.stringify({complete:true,...summary.focused}));
  }finally{for(const root of roots)rmSync(root,{recursive:true,force:true});}
}
