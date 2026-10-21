import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {ESLint} from 'eslint';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const mode=process.argv[2],out='test-artifacts',layers=[];
const files=['public/backorder-workflow.js','public/backorder-stock-requests.js','src/backorder-request-service.js','src/special-stock-request-repository.js'];
const hashes=Object.fromEntries(await Promise.all(files.map(async file=>[file,createHash('sha256').update(await readFile(file)).digest('hex')])));
async function run(name,args,options={}) {
  const result=spawnSync(process.execPath,args,{encoding:'utf8',maxBuffer:40_000_000,timeout:600000,...options});
  const output=(result.stdout || '')+(result.stderr || '');await writeFile(`${out}/${name}.log`,output);
  const count=label=>Number(output.match(new RegExp('^# '+label+' (\\d+)$','m'))?.[1] || 0);
  const record={name,exitCode:result.status,tests:count('tests'),passed:count('pass'),failed:count('fail'),failures:[...output.matchAll(/^not ok \d+ - (.+)$/gm)].map(match=>match[1])};
  layers.push(record);console.log(JSON.stringify(record));assert.equal(result.signal,null,name+' timed out');return {record,output};
}
const focused=['test/mbt/integration/backorder-already-ordered.test.js','test/mbt/property/backorder-already-ordered.property.test.js'];
const first=await run('focused',['--test','--test-concurrency=1',...focused]);
assert.equal(first.record.exitCode,mode==='red'?1:0);
const browser=await run('browser',['--test','test/mbt/integration/backorder-already-ordered-browser.test.js']);
assert.equal(browser.record.exitCode,mode==='red'?1:0);
const suite=[];
for(const folder of ['unit','integration','property'])for(const file of await readdir('test/mbt/'+folder)) {
  if(/^(backorder-|stocking-backorder-|special-stock-request-|special-workflow-)/.test(file) && file.endsWith('.test.js') && !file.includes('already-ordered'))suite.push(`test/mbt/${folder}/${file}`);
}
const regression=await run('regressions',['--test','--test-concurrency=1',...suite]);
const types=await run('types',['node_modules/typescript/bin/tsc','--allowJs','--checkJs','--noEmit','--skipLibCheck','--module','nodenext','--target','es2023','--lib','es2023,dom,dom.iterable',...files]);
const diagnostics=[...types.output.matchAll(/^(.+?)\(\d+,\d+\): (error TS\d+: .+)$/gm)].map(match=>match[1]+': '+match[2]);
const lint=new ESLint({overrideConfigFile:'tools/regular-stock-v2-eslint.config.mjs'});
const lintResults=await lint.lintFiles(files);
const lintDiagnostics=lintResults.flatMap(entry=>entry.messages.map(({ruleId,severity,message})=>({file:entry.filePath.replace(process.cwd()+'/',''),ruleId,severity,message})));
await writeFile(`${out}/lint.json`,JSON.stringify(lintDiagnostics,null,2));
const added=(current,previous)=>{const remaining=previous.map(x=>JSON.stringify(x));return current.filter(x=>{const i=remaining.indexOf(JSON.stringify(x));if(i<0)return true;remaining.splice(i,1);return false;});};
if(mode!=='red') {
  const baseline=JSON.parse(await readFile('/red/report.json','utf8'));
  assert.deepEqual(added(regression.record.failures,baseline.regressionFailures),[],'No new shared regressions');
  assert.deepEqual(added(diagnostics,baseline.typeDiagnostics),[],'No new type diagnostics');
  assert.deepEqual(added(lintDiagnostics,baseline.lintDiagnostics),[],'No new lint diagnostics');
  const coverage=await run('coverage',['node_modules/c8/bin/c8.js','--all=false',...files.map(file=>'--include='+file),'--check-coverage=false','--reporter=json','--report-dir=test-artifacts/coverage','--temp-directory=/tmp/already-ordered-coverage','node','--test','--test-concurrency=1',...focused]);
  assert.equal(coverage.record.exitCode,0);
}
const report={passed:mode!=='red',hashes,layers,suite,regressionFailures:regression.record.failures,typeDiagnostics:diagnostics,lintDiagnostics};
await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));
