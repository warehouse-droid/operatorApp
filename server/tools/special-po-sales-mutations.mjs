import assert from 'node:assert/strict';
import {cpSync,mkdtempSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {buildIsolatedTestEnvironment} from '../test/support/test-foundation.mjs';
import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const scratch=mkdtempSync('/tmp/special-po-sales-mutants-'),results=[];
const mutants=[
  {name:'omit Sales for delivery and yard pickup',file:'public/special-stock-po-reference.js',from:"['sales','dispatch']",to:"['dispatch']",suite:'test/mbt/unit/special-po-reference.test.js'},
  {name:'allow unsupported fulfillment methods',file:'public/special-stock-po-reference.js',from:'primary ? [primary] : []',to:"primary ? [primary] : ['sales']",suite:'test/mbt/unit/special-po-reference.test.js'},
  {name:'skip Queued filter',file:'src/special-po-reference-alerts.js',from:"audience!=='sales' || !rows.length",to:'true',db:true},
  {name:'skip Sales ownership',file:'src/special-po-reference-alerts.js',from:'AND request.requested_by=$3',to:'AND $3::text IS NOT NULL',db:true},
  {name:'skip authorized Sales yard',file:'src/special-po-reference-alerts.js',from:'request.destination_location_id=ANY($4::bigint[])',to:'$4::bigint[] IS NOT NULL',db:true},
  {name:'read receipts from both audiences',file:'src/special-po-reference-alerts.js',from:'WHERE operator_id=$1 AND audience=$2',to:'WHERE operator_id=$1 AND $2::text IS NOT NULL',db:true}
];
try {
  for(const name of ['src','public','test/mbt','test/support','migrations']) {cpSync(name,`${scratch}/${name}`,{recursive:true});}
  cpSync('package.json',`${scratch}/package.json`);symlinkSync('/app/node_modules',`${scratch}/node_modules`,'dir');
  symlinkSync('/app/test-artifacts',`${scratch}/test-artifacts`,'dir');
  const environment=buildIsolatedTestEnvironment(process.env,{databaseUrl:process.env.DATABASE_URL});delete environment.NODE_V8_COVERAGE;
  for(const [index,mutant] of mutants.entries()) {
    const file=`${scratch}/${mutant.file}`,source=readFileSync(file,'utf8');assert.ok(source.includes(mutant.from));let killed=false;
    try {
      writeFileSync(file,source.replace(mutant.from,mutant.to));
      if(mutant.db) {
        const exitCode=await runNodeTestFilesIsolated([`${scratch}/test/mbt/integration/special-po-reference-http.test.js`],{environment,label:`PO Sales mutant ${index}`});
        killed=exitCode===1;
      } else {
        const run=spawnSync(process.execPath,['--test','--test-name-pattern=Sales delivery alert:',mutant.suite],{cwd:scratch,env:environment,encoding:'utf8',timeout:60000});
        writeFileSync(`test-artifacts/mutant-${index}.log`,run.stdout+run.stderr);killed=run.status===1 && /(?:not ok|✖)/u.test(run.stdout);
      }
    } finally {writeFileSync(file,source);}
    assert.equal(readFileSync(file,'utf8'),source);results.push({name:mutant.name,killed,restored:true});
    process.stdout.write(`${mutant.name}: ${killed?'KILLED':'SURVIVED'}\n`);
  }
} finally {rmSync(scratch,{recursive:true,force:true});writeFileSync('test-artifacts/mutations.json',JSON.stringify(results,null,2)+'\n');}
assert.equal(results.length,mutants.length);assert.ok(results.every(result=>result.killed));
