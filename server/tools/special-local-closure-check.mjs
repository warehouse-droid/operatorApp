import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,readdirSync,cpSync,mkdtempSync,symlinkSync,mkdirSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.ok(process.env.DATABASE_URL?.endsWith('/mbt_verify'));
const out='test-artifacts/special-local-closure';mkdirSync(out,{recursive:true});
for(const file of ['summary.json','changed-lines.json','coverage','c8']) {
  if(process.argv.includes('--resume-suite') && ['coverage','c8'].includes(file))continue;
  rmSync(`${out}/${file}`,{force:true,recursive:true});
}
const runtime=['src/special-stock-closed-orders.js','src/special-stock-closure-service.js','src/special-stock-request-repository.js'];
const focused=['test/mbt/unit/special-local-closure.test.js','test/mbt/integration/special-local-closure.test.js',
  'test/mbt/integration/special-workflow-closure.test.js','test/mbt/integration/special-operation-closure.test.js'];
const scripts=['tools/special-local-closure-check.mjs','tools/special-local-closure-coverage.mjs'];
let baselineFailures=[];
const tests=['unit','property','integration'].flatMap(kind=>readdirSync(`test/mbt/${kind}`).filter(name=>/^special-.*\.test\.js$/.test(name)).sort().map(name=>`test/mbt/${kind}/${name}`));
const failureNames=log=>log.split('\n').filter(line=>line.startsWith('not ok ')).map(line=>line.replace(/^not ok \d+ - /,''));
function compareBaseline(log) {
  const failures=failureNames(log);
  if(!failures.length)return;
  const failingFiles=[...new Set(log.split(/(?=^not ok )/m).slice(1).map(block=>{
    const location=/location: '([^']+):\d+:\d+'/.exec(block)?.[1];assert.ok(location,'Failure location required');
    return location.slice(process.cwd().length+1);
  }))];
  assert.ok(!failingFiles.some(file=>focused.slice(0,2).includes(file)),'New closure acceptance tests must all pass');
  const root=mkdtempSync('/tmp/special-local-close-baseline-');
  for(const directory of ['src','public','test','tools','migrations','contracts'])cpSync(directory,`${root}/${directory}`,{recursive:true});
  for(const file of ['package.json','netsuite-smart-scm-picking-ticket-restlet.js'])cpSync(file,`${root}/${file}`);
  symlinkSync(resolve('node_modules'),`${root}/node_modules`,'dir');
  for(const file of runtime.slice(1))cpSync(`${out}/baseline/${file}`,`${root}/${file}`);
  const result=spawnSync(process.execPath,['--test','--test-concurrency=1',...failingFiles],{cwd:root,encoding:'utf8',timeout:300000,maxBuffer:30*1024*1024});
  const baseline=(result.stdout||'')+(result.stderr||'');writeFileSync(`${out}/baseline-final.txt`,baseline);
  const originalFailures=failureNames(baseline);
  assert.deepEqual(failures.filter(name=>!originalFailures.includes(name)),[],'Zero new related-suite failures against the same frozen tests');
  baselineFailures=failures;
  console.log(JSON.stringify({check:'baseline-comparison',candidateFailures:failures.length,originalFailures:originalFailures.length,newFailures:0}));
}
function run(name,command,args,failure=false,cwd=process.cwd()) {
  const result=spawnSync(command,args,{cwd,encoding:'utf8',timeout:300000,maxBuffer:40*1024*1024});
  const log=(result.stdout||'')+(result.stderr||'');writeFileSync(`${out}/${name}.txt`,log);
  if(failure)assert.ok(result.status!==0 && /^not ok /m.test(log),`${name} survived`);
  else if(name==='related-tests') {
    compareBaseline(log);assert.equal(Number(/^# fail (\d+)$/m.exec(log)?.[1]),baselineFailures.length);
  } else assert.equal(result.status,0,`${name} failed; see ${out}/${name}.txt: ${log.slice(-1000)}`);
  console.log(JSON.stringify({check:name,passed:true}));return log;
}
const suite=process.argv.includes('--resume-suite')?readFileSync(`${out}/related-tests.txt`,'utf8'):
  run('related-tests','node_modules/.bin/c8',['--all=false','--check-coverage=false',...runtime.map(file=>`--include=${file}`),
    `--temp-directory=${out}/c8`,`--report-dir=${out}/coverage`,'--reporter=json',process.execPath,'--test','--test-concurrency=1',...tests]);
if(process.argv.includes('--resume-suite'))compareBaseline(suite);
run('types','node_modules/.bin/tsc',['--noEmit','--allowJs','--checkJs','--skipLibCheck','--types','node','--target','ES2022','--module','NodeNext','src/special-stock-closed-orders.js']);
run('lint','node_modules/.bin/eslint',['--config','tools/special-workflow-native-eslint.config.mjs','--max-warnings=0',...runtime,...focused,...scripts]);
for(const file of [...runtime,...scripts])run(`syntax-${file.split('/').pop()}`,process.execPath,['--check',file]);
run('coverage',process.execPath,['tools/special-local-closure-coverage.mjs']);
const root=mkdtempSync('/tmp/special-local-close-mutants-');
for(const directory of ['src','public'])cpSync(directory,`${root}/${directory}`,{recursive:true});
cpSync('package.json',`${root}/package.json`);symlinkSync(resolve('node_modules'),`${root}/node_modules`,'dir');mkdirSync(`${root}/test/mbt/unit`,{recursive:true});
cpSync(focused[0],`${root}/${focused[0]}`);
const mutants=[
  ['src/special-stock-closed-orders.js',"const closedStatus=value=>/^(?:Closed|Cancelled|Canceled)$/i.test(String(value || '').replace(/^(Sales Order|Purchase Order)\\s*:\\s*/i,''));",'const closedStatus=_value=>true;'],
  ['src/special-stock-closed-orders.js','|| row.tranid!==order.reference || row.type!==order.type','|| row.type!==order.type'],
  ['src/special-stock-closure-service.js','if(!current || JSON.stringify(current)!==JSON.stringify(closedOrders)) {','if(false) {']
];
for(const [index,[file,before,after]] of mutants.entries()) {
  const target=`${root}/${file}`,source=readFileSync(target,'utf8');assert.equal(source.split(before).length,2);
  try {
    writeFileSync(target,source.replace(before,after));
    run(`mutant-${index+1}-contract`,process.execPath,['--test',focused[0]],true,root);
    run(`mutant-${index+1}-property`,process.execPath,['--test','--test-name-pattern=^property:',focused[0]],true,root);
  } finally {writeFileSync(target,source);}
  assert.equal(readFileSync(file,'utf8'),source);
}
run('suite-health',process.execPath,['--test','--test-concurrency=1',...focused.toReversed()]);
run('secrets',process.execPath,['test/support/scan-diff-secrets.mjs',...runtime,...focused,...scripts]);
const files=[...new Set([...runtime,...tests,...scripts,'tools/special-local-closure-check.py','test/special-local-closure-spec.md'])];
const hashes=Object.fromEntries(files.map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
writeFileSync(`${out}/source-manifest.json`,JSON.stringify(hashes,null,2));
const summary={completed:true,tests:Number(/^# tests (\d+)$/m.exec(suite)?.[1]),passed:Number(/^# pass (\d+)$/m.exec(suite)?.[1]),
  baselineFailures,newFailures:0,
  coverage:JSON.parse(readFileSync(`${out}/changed-lines.json`)),contractMutants:mutants.length,propertyMutants:mutants.length,
  sourceHash:createHash('sha256').update(JSON.stringify(hashes)).digest('hex'),runtimeHashes:Object.fromEntries(runtime.map(file=>[file,hashes[file]])),
  tools:{node:process.version,...Object.fromEntries(['typescript','eslint','c8','fast-check'].map(name=>[name,JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version]))}};
writeFileSync(`${out}/summary.json`,JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
