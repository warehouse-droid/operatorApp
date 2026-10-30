import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,readdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
const files=JSON.parse(readFileSync('tools/mbt-planning-repairs-files.json','utf8'));
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const sourceHashes=Object.fromEntries(files.map(file=>[file,hash(file)]));
const suites=[];
for(const directory of ['unit','integration','concurrency','property']) for(const file of readdirSync(`test/mbt/${directory}`).sort()) {
  if(/^(frontdesk-|customer-charge-|bin-(asset-search-browser|garbage-deposit|planning-browser|transport-browser|transport-errors|selection-browser|order-workflow-browser|collection-request))/.test(file) && file.endsWith('.test.js')) suites.push(`test/mbt/${directory}/${file}`);
}
const focused=['test/mbt/integration/frontdesk-quote-edit.test.js','test/mbt/integration/frontdesk-item-deposit-quote.test.js','test/mbt/property/frontdesk-quote-edit.property.test.js','test/mbt/integration/frontdesk-quote-edit-browser.test.js','test/mbt/integration/bin-transport-browser.test.js','test/mbt/integration/bin-asset-search-browser.test.js'];
const steps=[
  ['static',['tools/mbr-aggregate-static.mjs'],{BIN_FEATURE_FILES:'tools/mbt-planning-repairs-files.json'}],
  ['tests',['node_modules/c8/bin/c8.js','--all','--check-coverage=false',...files.filter(file=>file.endsWith('.js')).map(file=>`--include=${file}`),
    '--temp-directory=test-artifacts/repairs-c8','--report-dir=test-artifacts/mbr-aggregate-coverage','--reporter=json','node','tools/mbt-uat-checks.mjs',...suites]],
  ['coverage',['tools/mbt-planning-repairs-coverage.mjs','--require-complete']],
  ['reverse',['tools/mbt-uat-checks.mjs',...focused.reverse()]],
  ['mutations',['tools/mbt-planning-repairs-mutations.mjs']]
];
const results=[];
for(const [name,args,env] of steps) {
  console.log(`Starting MBT repairs ${name}`);
  const child=spawn(process.execPath,args,{env:{...process.env,...env,NODE_OPTIONS:'--require=/app/tools/bin-order-workflow-browser-env.cjs'}});
  let output='';child.stdout.on('data',value=>{output+=value;process.stdout.write(value);});child.stderr.on('data',value=>{output+=value;process.stdout.write(value);});
  const exitCode=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>resolve(code ?? 1));});
  writeFileSync(`test-artifacts/repairs-${name}.log`,output);
  const audit=['tests','reverse'].includes(name)?JSON.parse(readFileSync('test-artifacts/mbt-uat-results.json','utf8')):null;
  results.push({name,exitCode,...(audit?{tests:audit.tests,pass:audit.pass,fail:audit.fail,fileCount:audit.fileCount}: {})});
  if(exitCode && name==='static') break;
}
const json=name=>existsSync(`test-artifacts/${name}.json`)?JSON.parse(readFileSync(`test-artifacts/${name}.json`,'utf8')):null;
const report={createdAt:new Date().toISOString(),sourceHashes,steps:results,sourceDrift:files.filter(file=>hash(file)!==sourceHashes[file]),
  static:json('mbr-aggregate-static'),coverage:json('mbr-aggregate-changed-coverage'),mutations:json('mbt-planning-repairs-mutations'),
  toolchain:{node:process.version,...Object.fromEntries(['typescript','eslint','c8','fast-check','playwright','pg'].map(name=>[name,JSON.parse(readFileSync(`node_modules/${name}/package.json`,'utf8')).version]))}};
report.passed=results.length===steps.length && results.every(row=>row.exitCode===0) && !report.sourceDrift.length;
writeFileSync('test-artifacts/mbt-planning-repairs-validation.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));if(!report.passed) process.exitCode=1;
