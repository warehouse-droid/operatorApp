import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,rmSync,cpSync,mkdtempSync,symlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
assert.equal(new URL(process.env.DATABASE_URL).hostname,'mbbs-special-review-db');
const baseline=process.argv.includes('--baseline');
const root=baseline?mkdtempSync('/tmp/scm-po-text-remark-before-'):process.cwd();
if(baseline) {
  cpSync('src',root+'/src',{recursive:true});
  cpSync('public',root+'/public',{recursive:true});
  cpSync('package.json',root+'/package.json');
  cpSync('netsuite-smart-scm-picking-ticket-restlet.js',root+'/netsuite-smart-scm-picking-ticket-restlet.js');
  symlinkSync(resolve('node_modules'),root+'/node_modules','dir');
  const files=JSON.parse(readFileSync('tools/scm-po-text-files.json'));
  for(const file of files)cpSync('test-artifacts/scm-po-text-20260930/before/'+file,root+'/'+file);
}
const source=readFileSync(root+'/src/scm-schedule-remark-harness.js','utf8');
const setup='await rollback.run(async () => {';
assert.equal(source.split(setup).length,2);
const migration=readFileSync('migrations/242_dispatch_order_first_seen.sql','utf8');
const file=root+'/src/.scm-po-text-remark-harness-'+process.pid+'.mjs';
try {
  // Run the existing migration inside the harness's rollback transaction.
  // The harness's behavioral assertions and the shared test schema stay intact.
  writeFileSync(file,source.replace(setup,setup+'\n    await query('+JSON.stringify(migration)+');'));
  await import(pathToFileURL(file).href);
} finally {rmSync(file,{force:true});if(baseline)rmSync(root,{recursive:true,force:true});}
