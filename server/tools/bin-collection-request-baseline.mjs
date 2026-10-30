import {cpSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const file='test/mbt/unit/frontdesk-pricing-adapter.test.js';
const expected='the production MBT router is wired to the server-owned pricing adapter';
const root=mkdtempSync('test-artifacts/bin-collection-baseline-');
try {
  for(const source of ['src/server.js','src/mbt/frontdesk-pricing-adapter.js']) {
    assert.deepEqual(readFileSync(source),readFileSync(`test-artifacts/bin-selection-baseline/${source}`),`Baseline failure source changed: ${source}`);
  }
  cpSync('test-artifacts/bin-selection-baseline/src',`${root}/src`,{recursive:true});
  cpSync('package.json',`${root}/package.json`);
  mkdirSync(dirname(`${root}/${file}`),{recursive:true});cpSync(file,`${root}/${file}`);
  symlinkSync('/app/node_modules',`${root}/node_modules`);
  const run=spawnSync(process.execPath,['--test','--test-reporter=spec',resolve(root,file)],{encoding:'utf8',maxBuffer:32*1024*1024});
  const output=run.stdout+run.stderr;
  writeFileSync('test-artifacts/bin-collection-baseline.log',output);
  const failures=[...new Set(output.split('\n').filter(l=>l.startsWith('✖ ')&&!l.startsWith('✖ failing tests:')).map(l=>l.slice(2).replace(/ \([\d.]+ms\)$/u,'')))];
  assert.equal(run.status,1);assert.deepEqual(failures,[expected]);assert.match(output,/ℹ pass 3\nℹ fail 1/u);
  const report={file,failures,passed:3,failed:1,unchangedSourceVerified:true,
    reason:'Existing source-pattern assertion expects frontdeskPricing to be the first router option; the live router has earlier options.'};
  writeFileSync('test-artifacts/bin-collection-baseline.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
} finally {rmSync(root,{recursive:true,force:true});}
