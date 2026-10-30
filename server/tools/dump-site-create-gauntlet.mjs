import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import crypto from 'node:crypto';
const files=JSON.parse(readFileSync('tools/dump-site-create-files.json','utf8'));
const hash=file=>crypto.createHash('sha256').update(readFileSync(file)).digest('hex');
const sourceHashes=Object.fromEntries(files.map(file=>[file,hash(file)]));
process.env.BIN_FEATURE_FILES='tools/dump-site-create-files.json';
const tests=[
  'test/mbt/unit/dump-site-code.test.js',
  'test/mbt/integration/dump-site-create-browser.test.js',
  'test/mbt/unit/local-master-data-validation-boundaries.test.js',
  'test/mbt/unit/dump-site-hours-and-bin-estimate.test.js',
  'test/mbt/unit/local-master-import-adapter.test.js',
  'test/mbt/unit/local-item-settings.test.js',
  'test/mbt/property/local-item-settings.property.test.js',
  'test/mbt/integration/item-owned-dump-site.test.js',
  'test/mbt/integration/local-master-data-service-boundaries.test.js',
  'test/mbt/integration/local-master-import-foundation.test.js',
  'test/mbt/integration/local-item-catalog-p3.test.js',
  'test/mbt/integration/local-item-settings.test.js',
  'test/mbt/integration/local-item-settings-http.test.js',
  'test/mbt/integration/guarded-master-and-asset-deletion.test.js',
  'test/mbt/integration/custom-bin-item-and-manual-address.test.js',
  'test/mbt/integration/rate-card-configuration.test.js',
  'test/mbt/concurrency/local-item-settings-races.test.js'
];
const steps=[
  ['static',['tools/bin-cargo-static.mjs']],
  ['tests',['node_modules/c8/bin/c8.js','--all=false','--check-coverage=false','--include=src/**/*.js','--include=public/*.js',
    '--temp-directory=test-artifacts/bin-selection-c8','--report-dir=test-artifacts/bin-selection-coverage','--reporter=json','--reporter=json-summary',
    'node','tools/bin-planning-suites.mjs','selected',...tests]],
  ['mutations',['tools/dump-site-create-mutations.mjs']],
  ['reverse-order',['tools/bin-planning-suites.mjs','selected',...tests.slice(0,2),tests[8],tests[9],tests[13]],{BIN_PLANNING_REVERSE:'1'}],
  ['coverage',['tools/dump-site-create-coverage.mjs','--require-complete']]
];
const results=[];
for(const [name,args,environment] of steps) {
  console.log(`Starting dump-site ${name}`);const start=Date.now();
  const result=spawnSync(process.execPath,args,{encoding:'utf8',maxBuffer:32*1024*1024,
    env:{...process.env,...environment,NODE_OPTIONS:'--require=/app/tools/bin-order-workflow-browser-env.cjs'}});
  const output=result.stdout+result.stderr;writeFileSync(`test-artifacts/bin-selection-${name}.log`,output);
  const count=kind=>[...output.matchAll(new RegExp(`^ℹ ${kind} (\\d+)$`,'gmu'))].reduce((n,m)=>n+Number(m[1]),0);
  results.push({name,exitCode:result.status,signal:result.signal,tests:count('tests'),passed:count('pass'),failed:count('fail'),durationMs:Date.now()-start,
    summary:output.split('\n').filter(line=>line.startsWith('Isolated ')),failures:[...new Set(output.split('\n').filter(l=>l.startsWith('✖ ')&&!l.startsWith('✖ failing tests:')))]});
  console.log(JSON.stringify(results.at(-1)));
  if(result.status || !['tests','reverse-order'].includes(name)) console.log(output.slice(-7500));
}
const report={createdAt:new Date().toISOString(),sourceHashes,sourceDrift:files.filter(f=>hash(f)!==sourceHashes[f]),
  toolchain:{node:process.version,...Object.fromEntries(['typescript','eslint','c8','fast-check','playwright','pg'].map(name=>[name,JSON.parse(readFileSync(`node_modules/${name}/package.json`,'utf8')).version]))},steps:results};
writeFileSync('test-artifacts/bin-selection-gauntlet.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
if(report.sourceDrift.length || results.some(r=>r.exitCode!==0)) process.exitCode=1;
