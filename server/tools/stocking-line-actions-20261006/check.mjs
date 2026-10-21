import assert from 'node:assert/strict';
import {annotationOnlyLines} from './annotation-coverage.mjs';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,writeFileSync,readdirSync,cpSync,symlinkSync,mkdtempSync,rmSync,openSync,closeSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
assert.equal(new URL(process.env.DATABASE_URL).hostname,'db');
const out='test-artifacts/stocking-line-actions-20261006';mkdirSync(out,{recursive:true});
const focused=['test/mbt/unit/stocking-line-actions.test.js','test/mbt/integration/stocking-line-actions.test.js','test/mbt/integration/stocking-line-actions-browser.test.js'];
const coreFocused=[...focused];
focused.push('test/mbt/integration/stocking-replies-http.test.js','test/mbt/integration/stocking-replies-browser.test.js','test/mbt/integration/regular-stock-resolution-browser.test.js');
const runtime=JSON.parse(readFileSync('tools/stocking-line-actions-20261006/files.json'));
const dependencies=['src/regular-stock-domain.js','public/regular-stock-input.js','src/stock-request-domain.js'];
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
  const root=mkdtempSync('/tmp/mbbs-stocking-line-actions-');
  for(const folder of ['src','public','test'])cpSync(folder,root+'/'+folder,{recursive:true});
  for(const folder of ['node_modules','tools','migrations','contracts'])symlinkSync(resolve(folder),root+'/'+folder);
  for(const file of readdirSync('.').filter(name=>name.endsWith('.js')||name==='package.json'))cpSync(file,root+'/'+file);
  mkdirSync(root+'/test-artifacts/stocking-replies-20261006',{recursive:true});return root;
}
function baselineTypesRoot(){
  const root=copyTree();
  for(const file of runtime)if(existsSync('tools/stocking-line-actions-20261006/baseline/'+file))writeFileSync(root+'/'+file,readFileSync('tools/stocking-line-actions-20261006/baseline/'+file));
  rmSync(root+'/tools');mkdirSync(root+'/tools');
  for(const name of readdirSync('tools')){
    const original='tools/stocking-line-actions-20261006/baseline/tools/'+name;
    if(existsSync(original))cpSync(original,root+'/tools/'+name);else symlinkSync(resolve('tools/'+name),root+'/tools/'+name);
  }
  return root;
}
const baselineTypeArgs=args=>args.filter(arg=>!runtime.includes(arg)||existsSync('tools/stocking-line-actions-20261006/baseline/'+arg));
// A new declared browser global can change only the compiler's spelling hint.
// Keep the missing property, receiver and occurrence count in the comparison.
const typeDiagnostics=label=>readFileSync(`${out}/${label}.log`,'utf8').split('\n').filter(line=>/error TS\d+:/.test(line))
  .map(line=>line.replace(/\(\d+,\d+\)/,'').replace(/error TS2551: (.*) Did you mean '[^']+'\?/u,'error TS2339: $1'));
function resetDb(label){
  run(label+'-reset',['--input-type=module','-e',`import pg from 'pg';const url=new URL(process.env.DATABASE_URL);if(url.hostname!=='db'||url.pathname!=='/mbt_test')throw Error('Not isolated');url.pathname='/postgres';const c=new pg.Client({connectionString:url.href});try{await c.connect();await c.query('DROP DATABASE mbt_test WITH (FORCE)');await c.query('CREATE DATABASE mbt_test');}finally{await c.end();}`]);
  run(label+'-migrate',['src/migrate.js']);
}
if(mode==='annotation'){
  const before='const result=state.lines.filter(line=>line.id===target);\n';
  const annotated='// shifted source position\nconst result=(/** @type {{lines:{id:number}[]}} */ (state)).lines.filter(line=>line.id===target);\n';
  assert.ok(annotationOnlyLines(before,annotated).has(2));
  assert.equal(annotationOnlyLines(before,annotated.replace('===target','!==target')).size,0);
  assert.equal(annotationOnlyLines('',annotated).size,0);
  const file='public/scm-stock-requests.js',lines=annotationOnlyLines(readFileSync('tools/stocking-line-actions-20261006/baseline/'+file,'utf8'),readFileSync(file,'utf8'));
  assert.ok(lines.has(870));assert.ok(lines.has(908));
  writeFileSync(out+'/annotation-check.json',JSON.stringify({pureAnnotationsExcluded:true,businessChangesRetained:true,newStatementsRetained:true,legacyCastLines:[870,908]},null,2));
}else if(mode==='red'){
  const root=copyTree();try{for(const file of runtime){const old='tools/stocking-line-actions-20261006/baseline/'+file;if(existsSync(old))writeFileSync(root+'/'+file,readFileSync(old));}
    for(const file of coreFocused)run('red-'+file.replaceAll('/','_'),['--test',file],{red:true,cwd:root});
  }finally{rmSync(root,{recursive:true,force:true});}
}else if(mode==='repair-red')run('repair-red',['--test','--test-name-pattern=^legacy request-wide resolution','test/mbt/integration/stocking-line-actions.test.js'],{red:true});
else if(mode==='edit-red')run('edit-red',['--test','--test-name-pattern=^Sales edits preserve','test/mbt/integration/stocking-line-actions.test.js'],{red:true});
else if(mode==='allocation-red'){
  const args=['--test','--test-name-pattern=^allocation completion','test/mbt/integration/stocking-line-actions.test.js'];
  run('allocation-green',args);resetDb('before-allocation-red');const root=copyTree();
  try{const file='src/regular-stock-purchase-repository.js',source=readFileSync(file,'utf8');assert.equal(source.split('await refreshStockingReplyStatus(requestIds);').length,2);
    writeFileSync(root+'/'+file,source.replace('await refreshStockingReplyStatus(requestIds);',''));
    run('allocation-red',args,{cwd:root,red:true});
  }finally{rmSync(root,{recursive:true,force:true});}
}
else if(mode==='guards-red'){
  const mutants=[{file:'src/regular-stock-resolution.js',before:'!active.includes(line.status)',after:'false',pattern:'^Resolve rejects'},
    {file:'src/regular-stock-waitlist-transition.js',before:'clearStockingLineReplies(requestId,[selectedLineId])',after:'clearStockingLineReplies(requestId,Object.keys(request.regular_details.stockingLines).map(Number))',pattern:'^moving one material'}];
  for(const [index,mutant] of mutants.entries()){
    resetDb('before-guard-red-'+index);const root=copyTree();
    try{const source=readFileSync(mutant.file,'utf8');assert.equal(source.split(mutant.before).length,2);writeFileSync(root+'/'+mutant.file,source.replace(mutant.before,mutant.after));
      run('guard-red-'+index,['--test','--test-name-pattern='+mutant.pattern,focused[1]],{cwd:root,red:true});
    }finally{rmSync(root,{recursive:true,force:true});}
  }
}
else if(mode==='static'){const roots=[];try{
    const typeArgs=['/app/node_modules/typescript/bin/tsc','--noEmit','--allowJs','--checkJs','--skipLibCheck','--types','node','--target','ES2022','--module','NodeNext',...runtime.filter(file=>file.endsWith('.js'))];
    const typeRoot=baselineTypesRoot();roots.push(typeRoot);
    run('types-baseline',baselineTypeArgs(typeArgs),{cwd:typeRoot,baseline:true});run('types-candidate',typeArgs,{baseline:true});
    const baselineTypes=typeDiagnostics('types-baseline'),candidateTypes=typeDiagnostics('types-candidate');
    const remainingTypes=[...baselineTypes];
    const newTypeErrors=candidateTypes.filter(value=>{const index=remainingTypes.indexOf(value);if(index<0)return true;remainingTypes.splice(index,1);return false;});writeFileSync(`${out}/types-new-errors.json`,JSON.stringify(newTypeErrors,null,2));assert.deepEqual(newTypeErrors,[]);

    run('lint',['tools/stocking-line-actions-20261006/lint.mjs']);
    for(const file of runtime.filter(f=>f.endsWith('.js')))run('syntax-'+file.split('/').at(-1),['--check',file]);

}finally{for(const root of roots)rmSync(root,{recursive:true,force:true});}}
else if(mode==='focused')run('focused',['--test','--test-concurrency=1',...focused]);
else{
  const roots=[];try{
    const tests=['unit','property','integration'].flatMap(kind=>readdirSync('test/mbt/'+kind).filter(name=>/^(?:(?:regular-stock|regular-waitlist)[.-]|stock-request-|stocking-).*\.test\.js$/.test(name)).sort().map(name=>'test/mbt/'+kind+'/'+name)).filter(file=>!coreFocused.includes(file));
    let baseline,candidate;
    if(mode==='audit'||mode==='candidate'){
      const old=readFileSync(`${out}/baseline.log`,'utf8');baseline={counts:counts(old),failures:failures(old)};
      if(mode==='candidate'){const next=copyTree();roots.push(next);candidate=run('candidate',['--test','--test-concurrency=1',...tests],{cwd:next,baseline:true});}
      else {const next=readFileSync(`${out}/candidate.log`,'utf8');candidate={counts:counts(next),failures:failures(next)};}
    }else{
      const old=copyTree();roots.push(old);for(const file of runtime)if(existsSync('tools/stocking-line-actions-20261006/baseline/'+file))writeFileSync(old+'/'+file,readFileSync('tools/stocking-line-actions-20261006/baseline/'+file));
      for(const file of focused)if(existsSync('tools/stocking-line-actions-20261006/baseline-tests/'+file))writeFileSync(old+'/'+file,readFileSync('tools/stocking-line-actions-20261006/baseline-tests/'+file));
      baseline=run('baseline',['--test','--test-concurrency=1',...tests],{cwd:old,baseline:true});
      run('reset-test-db',['--input-type=module','-e',`import pg from 'pg';const url=new URL(process.env.DATABASE_URL);if(url.hostname!=='db'||url.pathname!=='/mbt_test')throw Error('Not isolated');url.pathname='/postgres';const c=new pg.Client({connectionString:url.href});try{await c.connect();await c.query('DROP DATABASE mbt_test WITH (FORCE)');await c.query('CREATE DATABASE mbt_test');}finally{await c.end();}`]);
      run('candidate-migrate',['src/migrate.js']);
      const next=copyTree();roots.push(next);candidate=run('candidate',['--test','--test-concurrency=1',...tests],{cwd:next,baseline:true});
    }
    const remainingFailures=[...baseline.failures];
    const newFailures=candidate.failures.filter(name=>{const index=remainingFailures.indexOf(name);if(index<0)return true;remainingFailures.splice(index,1);return false;});
    writeFileSync(`${out}/new-failures.json`,JSON.stringify(newFailures,null,2));assert.deepEqual(newFailures,[]);
    resetDb('before-focused');
    const final=run('focused-final',['--test','--test-concurrency=1',...focused]);
    resetDb('before-coverage');
    run('coverage',['/app/node_modules/c8/bin/c8.js','--all=false','--check-coverage=false',...runtime.filter(f=>f.endsWith('.js')).map(f=>'--include='+f),
      `--temp-directory=${out}/c8`,`--report-dir=${out}/coverage`,'--reporter=json',process.execPath,'--test','--test-concurrency=1',...focused]);
    const typeArgs=['/app/node_modules/typescript/bin/tsc','--noEmit','--allowJs','--checkJs','--skipLibCheck','--types','node','--target','ES2022','--module','NodeNext',...runtime.filter(file=>file.endsWith('.js'))];
    const typeRoot=baselineTypesRoot();roots.push(typeRoot);
    run('types-baseline',baselineTypeArgs(typeArgs),{cwd:typeRoot,baseline:true});run('types-candidate',typeArgs,{baseline:true});
    const baselineTypes=typeDiagnostics('types-baseline'),candidateTypes=typeDiagnostics('types-candidate');
    const remainingTypes=[...baselineTypes];
    const newTypeErrors=candidateTypes.filter(value=>{const index=remainingTypes.indexOf(value);if(index<0)return true;remainingTypes.splice(index,1);return false;});writeFileSync(`${out}/types-new-errors.json`,JSON.stringify(newTypeErrors,null,2));assert.deepEqual(newTypeErrors,[]);

    run('lint',['tools/stocking-line-actions-20261006/lint.mjs']);
    for(const file of runtime.filter(f=>f.endsWith('.js')))run('syntax-'+file.split('/').at(-1),['--check',file]);
    const covered=JSON.parse(readFileSync(`${out}/coverage/coverage-final.json`)),changed=[],annotations=[];
    const browserEntries=readdirSync(`${out}/browser`).filter(name=>name.endsWith('.coverage.json')).flatMap(name=>JSON.parse(readFileSync(`${out}/browser/${name}`)));
    for(const folder of ['test-artifacts/stocking-replies-20261006','test-artifacts/regular-stock-resolve-20261002/browser'])if(existsSync(folder)){for(const name of readdirSync(folder).filter(name=>/coverage.*\.json$/.test(name))){const entries=JSON.parse(readFileSync(folder+'/'+name));if(Array.isArray(entries))browserEntries.push(...entries);}}
    for(const file of runtime.filter(f=>f.endsWith('.js'))){
      const diff=spawnSync('diff',['-U0',existsSync('tools/stocking-line-actions-20261006/baseline/'+file)?'tools/stocking-line-actions-20261006/baseline/'+file:'/dev/null',file],{encoding:'utf8'}).stdout;
      const source=readFileSync(file,'utf8'),browser=file.startsWith('public/');
      const old='tools/stocking-line-actions-20261006/baseline/'+file;const typeLines=annotationOnlyLines(existsSync(old)?readFileSync(old,'utf8'):'',source);
      const entries=browserEntries.filter(entry=>entry.url.includes('/'+file.split('/').at(-1))&&entry.source===source);
      const entry=Object.values(covered).find(value=>value.path.endsWith('/'+file));
      assert.ok(browser?entries.length:entry);let line=0;
      for(const text of diff.split('\n')){
        const hunk=text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);if(hunk)line=Number(hunk[1]);
        else if(text.startsWith('+')&&!text.startsWith('+++')){
          if(typeLines.has(line)){annotations.push(file+':'+line);line++;continue;}
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
      {name:'sales-reply-wrong-thread',file:'src/regular-stock-replies.js',before:'request_line_id=$2 OR request_line_id IS NULL',after:'request_line_id<>$2 OR request_line_id IS NULL',tests:[focused[1]]},
      {name:'resolve-closes-other-lines',file:'src/regular-stock-resolution.js',before:'decided_by=$3,decided_at=now(),updated_at=now() WHERE id=$1`,\n      [line.id,',after:'decided_by=$3,decided_at=now(),updated_at=now() WHERE request_id=$1`,\n      [requestId,',tests:[focused[1]]},
      {name:'premature-case-closure',file:'src/regular-stock-resolution.js',before:"THEN 'active' ELSE 'completed' END,revision=revision+1",after:"THEN 'completed' ELSE 'active' END,revision=revision+1",tests:[focused[1]]},
      {name:'terminal-conversation-counted',file:'src/regular-stock-reply-domain.js',before:"const open=request.lines.filter(line=>!['closed','rejected','cancelled','received','fulfilled'].includes(line.status));",after:'const open=request.lines;',tests:[focused[0]],property:true},
      {name:'proposal-other-materials',file:'public/scm-stock-requests.js',before:"line.status==='submitted'&&line.id===Number(button.dataset.lineId)",after:"line.status==='submitted'&&line.id!==Number(button.dataset.lineId)",tests:[focused[2]]},
      {name:'repair-reopens-resolved-material',file:'tools/stocking-line-actions-20261006/repair.mjs',before:'others=lines.filter(line=>line.id!==target.id)',after:'others=lines.filter(line=>line.id===target.id)',tests:[focused[1]]},
      {name:'wrong-line-selector',file:'src/regular-stock-line-actions.js',before:'line.id===Number(value)',after:'line.id!==Number(value)',tests:[focused[0]],property:true},
      {name:'replace-existing-line-metadata',file:'src/regular-stock-line-actions.js',before:'states[lineId]={...states[lineId],...changes}',after:'states[lineId]={...changes}',tests:[focused[0]],property:true},
      {name:'sales-edit-discards-conversations',file:'src/regular-stock-request-service.js',before:'Object.assign(details,{stockingLines})',after:'Object.assign(details,{})',tests:[focused[1]]},
      {name:'allocation-retains-terminal-waiting-marker',file:'src/regular-stock-purchase-repository.js',before:'await refreshStockingReplyStatus(requestIds);',after:'',tests:[focused[1]]},
      {name:'resolve-reopens-rejected-material',file:'src/regular-stock-resolution.js',before:'!active.includes(line.status)',after:'false',tests:[focused[1]]},
      {name:'waitlist-clears-other-conversation',file:'src/regular-stock-waitlist-transition.js',before:'clearStockingLineReplies(requestId,[selectedLineId])',after:'clearStockingLineReplies(requestId,Object.keys(request.regular_details.stockingLines).map(Number))',tests:[focused[1]]}
    ];
    const mutationRoot=copyTree();rmSync(mutationRoot+'/tools');cpSync('tools',mutationRoot+'/tools',{recursive:true});roots.push(mutationRoot);const mutationResults=[];
    for(const mutant of mutations){
      const source=readFileSync(mutant.file,'utf8');assert.equal(source.split(mutant.before).length,2,mutant.name);
      if(mutant.tests.includes(focused[1]))resetDb('before-mutation-'+mutant.name);
      try{writeFileSync(mutationRoot+'/'+mutant.file,source.replace(mutant.before,mutant.after));
        run('mutation-'+mutant.name,['--test','--test-concurrency=1',...mutant.tests],{cwd:mutationRoot,red:true});
        if(mutant.property)run('property-mutation-'+mutant.name,['--test','--test-name-pattern=^property:',...mutant.tests],{cwd:mutationRoot,red:true});
        mutationResults.push({name:mutant.name,killed:true,propertyKilled:mutant.property||false});
      }finally{writeFileSync(mutationRoot+'/'+mutant.file,source);}
    }
    resetDb('before-reversed');
    const order=run('reversed-order',['--test','--test-concurrency=1',...focused.toReversed()]);
    const taskTools=['repair.mjs','check.mjs','run.py','deploy.py','deploy-worker.py','correct-000082.py','verify-live.mjs','lint.mjs','eslint.config.mjs','annotation-coverage.mjs','files.json','SPEC.md'];
    run('secrets',['test/support/scan-diff-secrets.mjs',...runtime,...dependencies,...focused,...taskTools.map(file=>'tools/stocking-line-actions-20261006/'+file),'tools/regular-stock-resolution-globals.d.ts']);
    const versions=Object.fromEntries(['@playwright/test','c8','typescript','eslint','fast-check','espree'].map(name=>[name,JSON.parse(readFileSync('/app/node_modules/'+name+'/package.json')).version]));
    const summary={baseline:baseline.counts,baselineFailures:baseline.failures,candidate:candidate.counts,candidateFailures:candidate.failures,newFailures,focused:final.counts,
      types:'pass',typeComparison:{baseline:baselineTypes.length,candidate:candidateTypes.length,newErrors:newTypeErrors},lint:'pass',changedLines:{total:changed.length,covered:changed.length,lines:changed,annotationOnly:annotations},mutations:mutationResults,order:order.counts,
      manifest:Object.fromEntries(runtime.map(file=>[file,hash(readFileSync(file))])),testManifest:Object.fromEntries(focused.map(file=>[file,hash(readFileSync(file))])),
      dependencyManifest:Object.fromEntries(dependencies.map(file=>[file,hash(readFileSync(file))])),
      declarationManifest:{'tools/regular-stock-resolution-globals.d.ts':hash(readFileSync('tools/regular-stock-resolution-globals.d.ts'))},
      toolManifest:Object.fromEntries(taskTools.map(file=>[file,hash(readFileSync('tools/stocking-line-actions-20261006/'+file))])),node:process.version,versions};
    writeFileSync(`${out}/summary.json`,JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
  }finally{for(const root of roots)rmSync(root,{recursive:true,force:true});}
}
