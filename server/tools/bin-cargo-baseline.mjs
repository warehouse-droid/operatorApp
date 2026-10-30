import {cpSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const file='test/dispatch/integration/dispatch-v2-command-flow.red.test.js';
const expected=['DP-05: split → unsplit retires every global split definition',
  'history search reveals reconciliation-complete PO/SO orders but never Driver PWA-completed orders',
  'DP-11 and DP-12: targeted CO and atomic split commands return only affected records and exact retries'];
const root=mkdtempSync('test-artifacts/bin-cargo-baseline-');
try {
  for(const source of ['src/server.js','src/dispatch-planner-v2-repository.js','src/dispatch-history-mode.js']) {
    assert.deepEqual(readFileSync(source),readFileSync(`test-artifacts/bin-selection-baseline/${source}`),`Baseline failure source changed: ${source}`);
  }
  for(const directory of ['src','public','migrations']) cpSync(`test-artifacts/bin-selection-baseline/${directory}`,`${root}/${directory}`,{recursive:true});
  for(const directory of ['contracts','test/support','test/dispatch/support']) cpSync(directory,`${root}/${directory}`,{recursive:true});
  cpSync('package.json',`${root}/package.json`);mkdirSync(dirname(`${root}/${file}`),{recursive:true});cpSync(file,`${root}/${file}`);
  symlinkSync('/app/node_modules',`${root}/node_modules`);
  const run=spawnSync(process.execPath,['tools/bin-planning-suites.mjs','selected',resolve(root,file)],{encoding:'utf8',maxBuffer:32*1024*1024,env:process.env});
  const output=run.stdout+run.stderr;writeFileSync('test-artifacts/bin-cargo-baseline.log',output);
  const failures=[...new Set(output.split('\n').filter(l=>l.startsWith('✖ ')&&!l.startsWith('✖ failing tests:')).map(l=>l.slice(2).replace(/ \([\d.]+ms\)$/u,'')))];
  const report={file,failures,expected,passed:9,failed:3,unchangedSourceVerified:true};
  writeFileSync('test-artifacts/bin-cargo-baseline.json',JSON.stringify(report,null,2));
  if(run.status!==1 || JSON.stringify(failures)!==JSON.stringify(expected)) console.log(output.slice(-10000));
  assert.equal(run.status,1);assert.deepEqual(failures,expected);assert.match(output,/ℹ pass 9\nℹ fail 3/u);
  console.log(JSON.stringify(report));
} finally {rmSync(root,{recursive:true,force:true});}
