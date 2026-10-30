import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
const files=JSON.parse(readFileSync('tools/mbr-aggregate-files.json','utf8'));
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const sourceHashes=Object.fromEntries(files.map(file=>[file,hash(file)]));
const steps=[
  ['static',['tools/mbr-aggregate-static.mjs']],
  ['tests',['node_modules/c8/bin/c8.js','--all','--check-coverage=false',...files.filter(f=>f.endsWith('.js')).map(f=>`--include=${f}`),
    '--temp-directory=test-artifacts/mbr-aggregate-c8','--report-dir=test-artifacts/mbr-aggregate-coverage','--reporter=json',
    'node','tools/mbr-aggregate-check.mjs','node','tools/mbr-aggregate-suites.mjs','all']],
  ['reverse-order',['tools/mbr-aggregate-check.mjs','node','tools/mbr-aggregate-suites.mjs','all'],{BIN_PLANNING_REVERSE:'1'}],
  ['browser-stability',['tools/mbr-aggregate-check.mjs','node','tools/mbr-aggregate-browser-stability.mjs']],
  ['mutations',['tools/mbr-aggregate-mutations.mjs']],
  ['guard-mutations',['tools/mbr-aggregate-guard-mutations.mjs']],
  ['coverage',['tools/mbr-aggregate-coverage.mjs']]
];
const results=[];
for(const [name,args,environment] of steps) {
  console.log(`Starting MBR/Agg ${name}`);const start=Date.now();
  const child=spawn(process.execPath,args,{env:{...process.env,...environment,NODE_OPTIONS:'--require=/app/tools/bin-order-workflow-browser-env.cjs'}});
  let output='',pending='';
  child.stdout.on('data',value=>{
    output+=value;pending+=value;const lines=pending.split('\n');pending=lines.pop();
    for(const line of lines) {const progress=line.match(/^\[isolation\] \S+ (\d+)\/(\d+)/u);
      if(progress && (Number(progress[1])%20===0 || progress[1]===progress[2])) console.log(line);}
  });child.stderr.on('data',value=>{output+=value;});
  child.on('error',error=>{throw error;});
  const status=await new Promise(resolve=>child.on('close',(code,signal)=>resolve(signal?1:(code ?? 1))));
  writeFileSync(`test-artifacts/mbr-aggregate-${name}.log`,output);
  const summary=output.split('\n').findLast(line=>line.startsWith('{"command":'));
  results.push({name,exitCode:status,durationMs:Date.now()-start,...(summary?{tests:JSON.parse(summary)}:{})});
  console.log(JSON.stringify(results.at(-1)));
  if(status || !summary) console.log(output.slice(-18000));
}
const packages=['typescript','eslint','c8','fast-check','playwright','pg'];
const json=name=>existsSync(`test-artifacts/mbr-aggregate-${name}.json`)?JSON.parse(readFileSync(`test-artifacts/mbr-aggregate-${name}.json`,'utf8')):null;
const coverage=json('changed-coverage');
const report={createdAt:new Date().toISOString(),sourceHashes,sourceDrift:files.filter(file=>hash(file)!==sourceHashes[file]),
  sourceTreeHash:createHash('sha256').update(JSON.stringify(sourceHashes)).digest('hex'),
  toolchain:{node:process.version,...Object.fromEntries(packages.map(name=>[name,JSON.parse(readFileSync(`node_modules/${name}/package.json`,'utf8')).version]))},
  steps:results,static:json('static'),mutations:json('mutations'),guardMutations:json('guard-mutations'),
  coverage:coverage?{covered:coverage.covered,total:coverage.total,branches:coverage.branches,unmeasured:coverage.unmeasured,
    files:Object.fromEntries(Object.entries(coverage.files).map(([file,counts])=>[file,{covered:counts.covered,total:counts.total}]))}:null};
report.passed=!report.sourceDrift.length && results.every(row=>row.exitCode===0);
writeFileSync('test-artifacts/mbr-aggregate-gauntlet.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));if(!report.passed) process.exitCode=1;
