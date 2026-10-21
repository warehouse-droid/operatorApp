import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cp,mkdtemp,readFile,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {ESLint} from 'eslint';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const phase=process.argv[2]||'final',out=`test-artifacts/${phase}`;
const files=JSON.parse(await readFile('test-artifacts/baseline/files.json','utf8'));
const focused=['test/mbt/unit/regular-stock-remaining.test.js','test/mbt/property/regular-stock-remaining.property.test.js','test/mbt/integration/regular-stock-remaining.test.js'];
const knownFailures=new Set([
  'SQL lists and detail authorization agree across yards, methods and versions',
  'changing queues discards an unfinished Resolve reply without submitting or closing the case'
]);
const report={phase,layers:[],knownBaselineFailures:[...knownFailures],versions:{node:process.version}};
async function run(name,args,{cwd=process.cwd(),allowBaseline=false}={}) {
  const result=spawnSync(process.execPath,args,{cwd,encoding:'utf8',maxBuffer:50_000_000,timeout:600_000});
  const output=(result.stdout||'')+(result.stderr||'');
  await writeFile(`${out}/${name}.log`,output);
  const failures=[...output.matchAll(/^not ok \d+ - (.+)$/gm)].map(match=>match[1]);
  report.layers.push({name,exitCode:result.status,tests:Number(output.match(/^# tests (\d+)/m)?.[1]||0),passed:Number(output.match(/^# pass (\d+)/m)?.[1]||0),failures});
  assert(result.status===0 || (allowBaseline && result.status===1 && failures.length>0 && failures.every(name=>knownFailures.has(name))),output);
  return output;
}
if(phase==='reverse') {
  await run('suite',['tools/regular-stock-remaining-suite.mjs','reverse'],{allowBaseline:true});
  await run('runner-lint',['node_modules/eslint/bin/eslint.js','--config','tools/regular-stock-v2-eslint.config.mjs','tools/regular-stock-remaining-suite.mjs','tools/regular-stock-remaining-checks.mjs']);
} else {
  await run('focused',['--test','--test-concurrency=1',...focused]);
  await run('coverage',['node_modules/c8/bin/c8.js','--all=false','--check-coverage=false',...files.filter(file=>file.startsWith('src/')).map(file=>'--include='+file),
    '--reporter=json','--reporter=text',`--report-dir=${out}/coverage`,'--temp-directory=/tmp/remaining-c8','node','tools/regular-stock-remaining-suite.mjs'],{allowBaseline:true});
  await run('types',['node_modules/typescript/bin/tsc','-p','tools/regular-stock-delivery-simple-tsconfig.json']);
  const lint=new ESLint({overrideConfigFile:'tools/regular-stock-v2-eslint.config.mjs'});
  report.lint=[];
  for(const file of [...files,...focused,'tools/regular-stock-remaining-checks.mjs','tools/regular-stock-remaining-suite.mjs']) {
    const diagnostics=async text=>(await lint.lintText(text,{filePath:file}))[0].messages.map(({ruleId,severity,message})=>JSON.stringify({ruleId,severity,message}));
    const baseline=files.includes(file)?await diagnostics(await readFile('test-artifacts/baseline/'+file,'utf8')):[];
    const messages=await diagnostics(await readFile(file,'utf8'));
    const remaining=baseline.slice();
    for(const message of messages) {const index=remaining.indexOf(message);assert(index>=0,`${file}: ${message}`);remaining.splice(index,1);}
    report.lint.push({file,existingDiagnostics:messages.length,newDiagnostics:0});
  }
  for(const file of files)await run('syntax-'+file.replaceAll('/','-'),['--check',file]);

  const mutations=[
    ['billing blocks fulfillment','src/regular-stock-netsuite-adapter.js',"open: ['A','B','D','E'].includes(row.status)","open: Number(row.billed_quantity) === 0 && ['A','B','D','E'].includes(row.status)"],
    ['closed balance survives','src/regular-stock-domain.js','if (line.closed === true) return 0;','if (false) return 0;'],
    ['fulfilled quantity ignored','src/regular-stock-domain.js','Math.max(line.quantity - fulfilled, 0)','Math.max(line.quantity, 0)'],
    ['delivery transfers original quantity','src/regular-stock-delivery-domain.js','const balance = regularLineRemainingQuantity(line);','const balance = line.quantity;'],
    ['kit billing invalidates physical state','src/regular-stock-netsuite-adapter.js','const {billedQuantity:_billedQuantity,...physical} = component;','const physical = component;'],
    ['stale fulfillment accepted','src/regular-stock-netsuite-adapter.js','return (original.fulfilledQuantity ?? 0) === (current.fulfilledQuantity ?? 0)','return true'],
    ['native terminal status ignored','src/regular-stock-netsuite-adapter.js',"['A','B','D','E'].includes(row.status)",'true'],
    ['backorder exceeds physical balance','src/regular-stock-delivery-domain.js','line.backorderedQuantity > regularLineRemainingQuantity(line)','line.backorderedQuantity > line.quantity'],
    ['billing invalidates confirmation','src/regular-stock-confirmation.js'," && key!=='billedQuantity'",'']
  ];
  const temporary=await mkdtemp(join(tmpdir(),'remaining-mutants-'));
  report.mutations=[];
  try {
    for(const folder of ['src','public','test'])await cp(resolve(folder),join(temporary,folder),{recursive:true});
    await cp('package.json',join(temporary,'package.json'));await symlink(resolve('node_modules'),join(temporary,'node_modules'),'dir');
    for(const [name,file,needle,replacement] of mutations) {
      const original=await readFile(file,'utf8');assert.equal(original.split(needle).length,2,`Mutation must have exactly one target: ${name}`);
      await writeFile(join(temporary,file),original.replace(needle,replacement));
      const kills={name};
      for(const propertyOnly of [false,true]) {
        const result=spawnSync(process.execPath,['--test','--test-concurrency=1',...(propertyOnly?[focused[1]]:focused.slice(0,2))],{cwd:temporary,encoding:'utf8',timeout:30_000,maxBuffer:10_000_000});
        await writeFile(`${out}/mutant-${report.mutations.length}-${propertyOnly?'properties':'unit'}.log`,(result.stdout||'')+(result.stderr||''));
        const killed=result.status===1 && /^not ok /m.test(result.stdout||'');
        kills[propertyOnly?'properties':'unit']=killed;
        if(!propertyOnly)assert(killed,`Surviving mutation: ${name}`);
      }
      await writeFile(join(temporary,file),original);report.mutations.push(kills);
    }
    await run('restored',['--test','--test-concurrency=1',...focused.slice(0,2)],{cwd:temporary});
  } finally {await rm(temporary,{recursive:true,force:true});}

  const changed=JSON.parse(await readFile('test-artifacts/changed-lines.json','utf8'));
  const coverage=JSON.parse(await readFile(`${out}/coverage/coverage-final.json`,'utf8'));
  report.changedLineCoverage={covered:[],uncovered:[]};
  for(const file of files.filter(file=>file.startsWith('src/'))) {
    const record=coverage[resolve(file)];assert(record,'No coverage for '+file);
    for(const line of changed[file]) {
      const statements=Object.entries(record.statementMap).filter(([,location])=>location.start.line<=line && location.end.line>=line);
      if(!statements.length)continue;
      const key=statements.some(([key])=>record.s[key]>0)?'covered':'uncovered';
      report.changedLineCoverage[key].push(`${file}:${line}`);
    }
  }
  // The existing desktop/mobile browser suite collects V8 coverage for this UI.
  const ui='public/regular-stock-delivery.js',source=await readFile(ui,'utf8');
  const browserCoverage=JSON.parse(await readFile('test-artifacts/delivery-yard-access-20261007/browser/coverage-1440.json','utf8'));
  const browserRecord=browserCoverage.find(entry=>new URL(entry.url).pathname.endsWith('/regular-stock-delivery.js'));
  assert(browserRecord,'No browser coverage for the Delivery UI');
  assert.equal(browserRecord.source,source,'Browser evidence must match the tested source');
  const lines=source.split('\n');
  for(const line of changed[ui]) {
    const start=lines.slice(0,line-1).join('\n').length+(line>1?1:0)+lines[line-1].search(/\S/);
    const ranges=browserRecord.functions.flatMap(fn=>fn.ranges).filter(range=>range.startOffset<=start && range.endOffset>start)
      .sort((a,b)=>(a.endOffset-a.startOffset)-(b.endOffset-b.startOffset));
    const covered=ranges.length>0 && ranges[0].count>0;
    report.changedLineCoverage[covered?'covered':'uncovered'].push(`${ui}:${line}`);
  }
  await writeFile(`${out}/coverage-check.json`,JSON.stringify(report.changedLineCoverage,null,2));
  assert.deepEqual(report.changedLineCoverage.uncovered,[]);
  for(const name of ['fast-check','typescript','eslint','c8'])report.versions[name]=JSON.parse(await readFile(`node_modules/${name}/package.json`,'utf8')).version;
}
report.sourceHashes=Object.fromEntries(await Promise.all([...files,...focused].map(async file=>[file,createHash('sha256').update(await readFile(file)).digest('hex')])));
await writeFile(`${out}/report.json`,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
