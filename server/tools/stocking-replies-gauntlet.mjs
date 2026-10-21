import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,cp,symlink,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import coverage from 'istanbul-lib-coverage';
import v8ToIstanbul from 'v8-to-istanbul';

const out='test-artifacts/stocking-replies-20261006';
const files=JSON.parse(await readFile('tools/stocking-replies-files.json','utf8')).filter(file=>file.endsWith('.js'));
const hash=body=>createHash('sha256').update(body).digest('hex');
const state=async()=>Object.fromEntries(await Promise.all(files.map(async file=>[file,hash(await readFile(file))])));
const sourceBefore=await state(),layers=[];
function run(name,args,options={}){
  const result=spawnSync(process.execPath,args,{encoding:'utf8',maxBuffer:24_000_000,timeout:300000,...options});
  return {name,exitCode:result.status,output:(result.stdout||'')+(result.stderr||'')};
}
async function record(result){await writeFile(`${out}/${result.name}.log`,result.output);layers.push({name:result.name,exitCode:result.exitCode});return result;}
const staticCheck=await record(run('static-final',['tools/stocking-replies-static.mjs']));assert.equal(staticCheck.exitCode,0,staticCheck.output);
const suites=JSON.parse(await readFile('tools/stocking-replies-suites.json','utf8'));
const order=[...suites].sort((a,b)=>hash('20261006'+a).localeCompare(hash('20261006'+b)));
const regression=await record(run('regressions-final',['node_modules/c8/bin/c8.js','--reports-dir='+out+'/coverage','--reporter=json','--reporter=text',
  ...files.map(file=>'--include='+file),'node','tools/stocking-replies-checks.mjs',...order]));
const failures=text=>[...new Set(text.split('\n').filter(line=>/^✖ .+ \([\d.]+ms\)$/.test(line)).map(line=>line.replace(/^✖ /,'').replace(/ \([\d.]+ms\)$/,'')))].sort();
const baseline=failures(await readFile('test-artifacts/stocking-replies-20261006-baseline.log','utf8'));
const after=failures(regression.output);assert.deepEqual(after,baseline,'No new failing behaviors compared with the exact live baseline');
assert.equal(regression.exitCode,baseline.length?1:0,regression.output);
const totals=[...regression.output.matchAll(/ℹ tests (\d+)/g)].map(match=>Number(match[1]));
assert.equal(totals.length,suites.length,'Every suite completed');
await writeFile(`${out}/regression-comparison.json`,JSON.stringify({seed:20261006,suites:suites.length,tests:totals.reduce((a,b)=>a+b,0),baselineFailures:baseline,newFailures:after.filter(name=>!baseline.includes(name)),order},null,2));

const map=coverage.createCoverageMap(JSON.parse(await readFile(out+'/coverage/coverage-final.json','utf8')));
const browsers=[...JSON.parse(await readFile(out+'/browser-coverage.json','utf8')),...JSON.parse(await readFile(out+'/view-browser-coverage.json','utf8'))];
for(const entry of browsers){
  if(!entry.url.startsWith('http'))continue;
  const file='public/'+new URL(entry.url).pathname.split('/').pop();if(!files.includes(file))continue;
  const source=await readFile(file,'utf8');assert.equal(entry.source,source,file);
  const converter=v8ToIstanbul(resolve(file),0,{source});await converter.load();converter.applyCoverage(entry.functions);map.merge(converter.toIstanbul());
}
const added=JSON.parse(await readFile('tools/stocking-replies-changed-lines.json','utf8'));
const lineReport={covered:0,total:0,uncovered:[],missingFiles:[],files:{}};
for(const file of files){
  const path=resolve(file);if(!map.files().includes(path)){lineReport.missingFiles.push(file);continue;}
  const executed=map.fileCoverageFor(path).getLineCoverage(),lines=added[file].filter(line=>Object.hasOwn(executed,line));
  const missing=lines.filter(line=>!executed[line]);lineReport.total+=lines.length;lineReport.covered+=lines.length-missing.length;
  lineReport.uncovered.push(...missing.map(line=>({file,line})));lineReport.files[file]={covered:lines.length-missing.length,total:lines.length};
}
await writeFile(`${out}/changed-line-coverage.json`,JSON.stringify(lineReport,null,2));

const mutations=[
  ['assigned-yard requirement removed','src/regular-stock-stocking-access.js','if(!authorized.some(value=>yardId(value)))','if(false)','unit/stocking-replies.test.js',true],
  ['origin visibility widened to other methods','src/regular-stock-stocking-access.js',"request.regular?.deliveryMethod==='stocking'",'true','unit/stocking-replies.test.js',true],
  ['impossible ETA accepted','src/regular-stock-reply-domain.js',"new Date(instant).toISOString().slice(0,10)!==eta",'false','unit/stocking-replies.test.js',false],
  ['stale reply writes allowed','src/regular-stock-replies.js','if(Number(row.revision)!==reply.expectedRevision)','if(false)','integration/stocking-replies-http.test.js',false],
  ['SCM reply alert omitted','src/regular-stock-replies.js','manual_decision_event_id=CASE WHEN $3 THEN $4 ELSE manual_decision_event_id END','manual_decision_event_id=CASE WHEN $3 AND $4<0 THEN $4 ELSE manual_decision_event_id END','integration/stocking-replies-http.test.js',false],
  ['manual SO PDF gate restored','src/special-stock-documents.js',"const manualSalesLink = sales && detail.salesOrderSource === 'manual_link';",'const manualSalesLink = false;','unit/special-manual-so-preview.test.js',false]
];
const temporary=await mkdtemp(join(tmpdir(),'stocking-reply-mutations-')),mutants=[];
try{
  for(const directory of ['src','public','test'])await cp(resolve(directory),join(temporary,directory),{recursive:true});
  await cp('package.json',join(temporary,'package.json'));await cp('tools/stocking-replies-checks.mjs',join(temporary,'checks.mjs'));
  // Keep the runner's normal relative test/support imports in the scratch tree.
  await cp(resolve('tools'),join(temporary,'tools'),{recursive:true});
  await symlink(resolve('node_modules'),join(temporary,'node_modules'),'dir');
  for(const [index,[name,file,needle,replacement,suite,property]] of mutations.entries()){
    const original=await readFile(file,'utf8');assert.equal(original.split(needle).length,2,name);
    await writeFile(join(temporary,file),original.replace(needle,replacement));
    const killed=await record(run(`mutant-${index}`,['tools/stocking-replies-checks.mjs',suite],{cwd:temporary}));
    assert.equal(killed.exitCode,1,name);assert.ok(failures(killed.output).length,name+': must fail a behavior assertion');
    if(property){
      const check=await record(run(`mutant-${index}-properties`,['--test','--test-reporter=spec','--test-name-pattern=property:', 'test/mbt/unit/stocking-replies.test.js'],{cwd:temporary}));
      assert.equal(check.exitCode,1,name+' property suite');assert.ok(failures(check.output).length);
    }
    await writeFile(join(temporary,file),original);mutants.push({name,killed:true,propertySuiteVerified:property});
  }
}finally{await rm(temporary,{recursive:true,force:true});}
assert.deepEqual(await state(),sourceBefore,'Mutations never modify the validated source');
const restored=await record(run('restored-final',['tools/stocking-replies-checks.mjs','unit/stocking-replies.test.js','unit/special-manual-so-preview.test.js','integration/stocking-replies-http.test.js']));assert.equal(restored.exitCode,0,restored.output);
await writeFile(`${out}/gauntlet.json`,JSON.stringify({passed:true,at:new Date().toISOString(),sourceHashes:sourceBefore,layers,mutants,coverage:lineReport,regressionFailures:baseline},null,2));
console.log(JSON.stringify({passed:true,suites:suites.length,tests:totals.reduce((a,b)=>a+b,0),preExistingFailures:baseline.length,newFailures:0,mutantsKilled:mutants.length,changedLinesCovered:lineReport.covered,changedLinesTotal:lineReport.total}));
