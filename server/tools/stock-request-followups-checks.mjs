import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,readdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
const files=JSON.parse(readFileSync('tools/stock-request-followups-files.json','utf8'));
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const sourceHashes=Object.fromEntries(files.map(file=>[file,hash(file)]));
const suites=[];
for(const directory of ['unit','integration','concurrency','property']) for(const file of readdirSync(`test/mbt/${directory}`).sort()) {
  if(/^(stock-request-followups|regular-stock-controls|regular-stock-resolution|stocking-line-actions|backorder-review-flow|backorder-already-ordered|backorder-pending-po|regular-stock-status|ui-toronto-timestamp|stock-check-(domain|lines|description|ollama|browser)|boss-history-browser|regular-waitlist-http-browser)/.test(file) && file.endsWith('.test.js')) suites.push(`test/mbt/${directory}/${file}`);
}
suites.push('test/repair/browser.test.js');
const evidenceFiles=[...suites,'test/stock-request-followups-spec.md',...readdirSync('tools').filter(name=>name.startsWith('stock-request-followups-')&&!name.endsWith('.py')).map(name=>'tools/'+name)];
const evidenceHashes=Object.fromEntries(evidenceFiles.map(file=>[file,hash(file)]));
const focused=suites.filter(file=>file.includes('/stock-request-followups'));
const steps=[
  ['static',['tools/stock-request-followups-static.mjs'],{BIN_FEATURE_FILES:'tools/stock-request-followups-files.json'}],
  ['tests',['node_modules/c8/bin/c8.js','--all','--check-coverage=false',...files.filter(file=>file.endsWith('.js')).map(file=>`--include=${file}`),
    '--temp-directory=test-artifacts/repairs-c8','--report-dir=test-artifacts/mbr-aggregate-coverage','--reporter=json','node','tools/stock-request-followups-report.mjs',...suites]],
  ['coverage',['tools/stock-request-followups-coverage.mjs','--require-complete']],
  ['reverse',['tools/stock-request-followups-report.mjs',...focused.reverse()]],
  ['mutations',['tools/stock-request-followups-mutations.mjs']]
];
const results=[];
for(const [name,args,env] of steps) {
  console.log(`Starting Stock request followups ${name}`);
  const child=spawn(process.execPath,args,{env:{...process.env,...env,NODE_OPTIONS:'--require=/app/tools/stock-request-followups-browser-env.cjs'}});
  let output='';child.stdout.on('data',value=>{output+=value;process.stdout.write(value);});child.stderr.on('data',value=>{output+=value;process.stdout.write(value);});
  const exitCode=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>resolve(code ?? 1));});
  writeFileSync(`test-artifacts/repairs-${name}.log`,output);
  const audit=['tests','reverse'].includes(name)?JSON.parse(readFileSync('test-artifacts/mbt-uat-results.json','utf8')):null;
  results.push({name,exitCode,...(audit?{tests:audit.tests,pass:audit.pass,fail:audit.fail,fileCount:audit.fileCount,baselineFailures:audit.baselineFailures,newFailures:audit.newFailures}: {})});
  if(exitCode && name==='static') break;
}
const json=name=>existsSync(`test-artifacts/${name}.json`)?JSON.parse(readFileSync(`test-artifacts/${name}.json`,'utf8')):null;
const report={createdAt:new Date().toISOString(),sourceHashes,evidenceHashes,steps:results,sourceDrift:[...files.filter(file=>hash(file)!==sourceHashes[file]),...evidenceFiles.filter(file=>hash(file)!==evidenceHashes[file])],
  static:json('mbr-aggregate-static'),coverage:json('mbr-aggregate-changed-coverage'),mutations:json('stock-request-followups-mutations'),
  toolchain:{node:process.version,...Object.fromEntries(['typescript','eslint','c8','fast-check','playwright','pg'].map(name=>[name,JSON.parse(readFileSync(`node_modules/${name}/package.json`,'utf8')).version]))}};
report.passed=results.length===steps.length && results.every(row=>row.exitCode===0) && !report.sourceDrift.length;
writeFileSync('test-artifacts/stock-request-followups-validation.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));if(!report.passed) process.exitCode=1;
