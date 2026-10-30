import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const focused='test/mbt/integration/scm-cancelled-split-schedule.test.js';
const suites=[focused,'test/mbt/integration/scm-schedule-search.test.js',
  'test/dispatch/integration/scm-po-split-schedule-remaining.test.js',
  'test/mbt/integration/scm-schedule-status-http.test.js'];
const runtime='src/dispatch-repository.js';
const digest=()=>createHash('sha256').update(readFileSync(runtime)).digest('hex');
const full=process.argv[2]==='final';
const report={passed:true,hashes:{[runtime]:digest()},layers:[],toolchain:{node:process.version}};

function run(name,args,{mustFail=false}={}) {
  const result=spawnSync(process.execPath,args,{encoding:'utf8',timeout:240000,maxBuffer:8*1024*1024});
  const output=(result.stdout||'')+(result.stderr||'');
  const passed=mustFail ? result.status!==0 && /not ok/.test(output) : result.status===0;
  const summary=output.split('\n').filter(line=>/^# (tests|pass|fail|duration_ms)|^not ok|^  error:/.test(line));
  report.layers.push({name,passed,exitCode:result.status,summary,...(!passed ? {details:output.slice(-7000)} : {})});
  report.passed &&= passed;
  if (!passed) {process.stdout.write(output);}
}

writeFileSync('test-artifacts/c8-config.json','{}');
const args=['--test','--test-concurrency=1',...(full ? suites : [focused])];
run('affected suites',full ? ['node_modules/c8/bin/c8.js','--config=test-artifacts/c8-config.json','--include=src/dispatch-repository.js',
  '--reporter=json','--reports-dir=test-artifacts/coverage',process.execPath,...args] : args);
if (full) {
  run('syntax',['--check',runtime]);
  run('lint: checker',['node_modules/eslint/bin/eslint.js','--config','eslint.mbt.config.js','--max-warnings=0','tools/scm-retired-po-search-checks.mjs']);
  const source=readFileSync(runtime,'utf8');
  const marker="AND NOT EXISTS (\n          SELECT 1\n            FROM dispatch_scm_po_splits cancelled_split\n           WHERE cancelled_split.split_po_id = po.netsuite_id\n             AND cancelled_split.status = 'cancelled'\n        )";
  if (!source.includes(marker)) {throw Error('Cancellation filter anchor changed');}
  const mutations=[
    ['search bypass',marker.replace('AND NOT EXISTS (','AND ($26::boolean OR NOT EXISTS (')+')'],
    ['shared reference',marker.replace('cancelled_split.split_po_id = po.netsuite_id','cancelled_split.split_po_ref = po.tranid')],
    ['hide active child',marker.replace("AND cancelled_split.status = 'cancelled'",'AND true')]
  ];
  for (const [name,replacement] of mutations) {
    try {
      writeFileSync(runtime,source.replace(marker,replacement));
      run('mutation: '+name,['--test','--test-concurrency=1',focused],{mustFail:true});
    } finally {writeFileSync(runtime,source);}
  }
  report.restored=digest()===report.hashes[runtime];
  report.passed &&= report.restored;
  const changed=JSON.parse(readFileSync('test-artifacts/changed-lines.json','utf8'))[runtime];
  const coverage=JSON.parse(readFileSync('test-artifacts/coverage/coverage-final.json','utf8'));
  const data=Object.entries(coverage).find(([path])=>path.endsWith('/'+runtime))?.[1];
  const uncovered=changed.filter(line=>!Object.entries(data.statementMap).some(([id,range])=>
    range.start.line<=line && range.end.line>=line && data.s[id]>0));
  report.changedCoverage={lines:changed.length,uncovered};
  report.passed &&= uncovered.length===0;
}
writeFileSync('test-artifacts/report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
process.exitCode=report.passed ? 0 : 1;
