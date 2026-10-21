import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import pg from 'pg';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const databaseUrl=new URL(process.env.DATABASE_URL);
assert.equal(databaseUrl.pathname,'/mbt_test');
const adminUrl=new URL(databaseUrl); adminUrl.pathname='/postgres';
const admin=new pg.Pool({connectionString:adminUrl.toString()});
let database, databaseName, sequence=0, activeUrl=databaseUrl.toString();
async function disposeDatabase() {
  if(database) { await database.end(); database=null; }
  if(databaseName) { await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`); databaseName=null; }
}
async function isolatedDatabase() {
  await disposeDatabase();
  databaseName=`mbt_test_file_direct_po_${sequence++}`;
  await admin.query(`CREATE DATABASE "${databaseName}" TEMPLATE mbt_test`);
  const target=new URL(databaseUrl); target.pathname='/'+databaseName; activeUrl=target.toString();
  database=new pg.Pool({connectionString:activeUrl});
}
const query=(...args)=>database.query(...args);
const out='test-artifacts/direct-po-split-status-20261015';
await mkdir(out,{recursive:true});
const migration='migrations/291_direct_po_materialized_split_status.sql';
const focused='test/mbt/integration/direct-po-materialized-split.test.js';
const recovery='tools/direct-po-split-status-recovery.mjs';
const files=[
  'test/dispatch/integration/direct-linked-po-group-lifecycle.test.js',
  'test/dispatch/integration/direct-linked-po-lifecycle.test.js',
  'test/dispatch/integration/direct-ship-po-planning.test.js',
  'test/dispatch/integration/scm-direct-ship-schedule.test.js',
  'test/mbt/unit/direct-ship-posting.test.js',
  'test/mbt/integration/direct-ship-posting.test.js',
  'test/dispatch/integration/dispatch-driver-completion-split-isolation.red.test.js',
  focused
];
async function execute(label,args,{mustPass=true,env={...process.env,DATABASE_URL:activeUrl}}={}) {
  const result=spawnSync(process.execPath,args,{encoding:'utf8',maxBuffer:16*1024*1024,env});
  const log=(result.stdout||'')+(result.stderr||'');
  await writeFile(`${out}/${label}.log`,log);
  const count=key=>Number(log.match(new RegExp(`^# ${key} (\\d+)$`,'m'))?.[1]||0);
  const failures=log.split(/(?=^not ok )/mu).slice(1).map(block=>({
    name:block.split('\n')[0].replace(/^not ok \d+ - /u,''),
    error:block.match(/^  error: (.*)$/mu)?.[1]||''}));
  const report={label,status:result.status,tests:count('tests'),passed:count('pass'),failed:count('fail'),failures};
  console.log(JSON.stringify(report));
  if(mustPass) { assert.equal(result.status,0,`${label}: see retained log`); }
  return report;
}
const sql=await readFile(migration,'utf8');
async function bootstrap() {
  await query(await readFile('migrations/257_direct_linked_po_group_completion.sql','utf8'));
  await query(sql);
}
const hashes={};
for(const file of [migration,recovery,focused]) {
  hashes[file]=createHash('sha256').update(await readFile(file)).digest('hex');
}
try {
  await execute('syntax',['--check',recovery]);
  await execute('lint',['node_modules/eslint/bin/eslint.js','--config','eslint.mbt.config.js','--max-warnings=0',
    recovery,focused,'tools/direct-po-split-status-checks.mjs','tools/direct-po-split-status-mutation-loader.mjs',files[0]]);
  const baseline=[];
  for(const [index,file] of files.slice(0,-1).entries()) {
    await isolatedDatabase();
    await query(await readFile('migrations/257_direct_linked_po_group_completion.sql','utf8'));
    baseline.push(await execute(`baseline-${index}`,['--test','--test-concurrency=1',file],
      {mustPass:false,env:{...process.env,DATABASE_URL:activeUrl,DIRECT_PO_SPLIT_BASELINE:'1'}}));
  }
  async function suite(label,index) {
    await isolatedDatabase();
    await bootstrap();
    const result=await execute(label,['--test','--test-concurrency=1',files[index]],{mustPass:false});
    const retained=new Set((baseline[index]?.failures||[]).map(f=>JSON.stringify(f)));
    assert.ok(result.failures.every(f=>retained.has(JSON.stringify(f))),label+' introduced failures');
    assert.ok(result.failed<=(baseline[index]?.failed||0),label+' increased failure count');
    assert.ok(result.tests>0,label+' did not run tests');
    return result;
  }
  const tests=[];
  for(const index of files.keys()) {
    tests.push(await suite(`suite-${index}`,index));
  }
  const shuffled=[];
  for(const index of [7,3,1,5,0,6,2,4]) {
    shuffled.push(await suite(`reordered-${index}`,index));
  }
  const exact="lower(btrim(child.detail->>'id'))=lower(btrim(allocation.sales_order_ref))";
  const variants=[
    ['missing_exact_split',exact,'false'],
    ['wrong_split_comparison',exact,exact.replace('))=','))<>')],
    ['requires_both_identities','\n        OR lower(regexp_replace','\n        AND lower(regexp_replace'],
    ['ignores_item_identity',"COALESCE(item.detail->>'itemId',allocation.item_id::text)=allocation.item_id::text",'true']
  ];
  const mutations=[];
  for(const [label,old,replacement] of variants) {
    assert.equal(sql.split(old).length,2,label);
    await isolatedDatabase();
    await bootstrap();
    await query(sql.replace(old,replacement));
    const result=await execute(`mutant-${label}`,['--test','--test-concurrency=1',focused],{mustPass:false});
    assert.notEqual(result.status,0,label);assert.ok(result.failed>0,label);
    const property=await execute(`property-mutant-${label}`,['--test','--test-name-pattern=property:',focused],{mustPass:false});
    assert.notEqual(property.status,0);assert.ok(property.failed>0);
    mutations.push({...result,killed:true,propertyKilled:true});
  }
  await isolatedDatabase();
  await bootstrap();
  const receipt=await execute('mutant-receipt-admission',['--loader','./tools/direct-po-split-status-mutation-loader.mjs',
    '--test','--test-concurrency=1',focused],{mustPass:false});
  assert.notEqual(receipt.status,0);assert.ok(receipt.failed>0);
  const receiptProperty=await execute('property-mutant-receipt-admission',['--loader','./tools/direct-po-split-status-mutation-loader.mjs',
    '--test','--test-name-pattern=property:',focused],{mustPass:false});
  assert.notEqual(receiptProperty.status,0);assert.ok(receiptProperty.failed>0);
  mutations.push({...receipt,killed:true,propertyKilled:true});
  await isolatedDatabase();
  await bootstrap();
  const coverage=await execute('coverage',['node_modules/c8/bin/c8.js','--include='+recovery,
    '--temp-directory='+out+'/coverage-tmp',
    '--reporter=json-summary','--reporter=text','--reports-dir='+out+'/coverage',
    'node','--test','--test-concurrency=1',focused]);
  const coverageReport=JSON.parse(await readFile(out+'/coverage/coverage-summary.json','utf8'));
  assert.ok(coverageReport.total.lines.total>0,'Recovery coverage must contain executable lines');
  assert.equal(coverageReport.total.lines.pct,100,'Recovery changed-line coverage');
  const summary={passed:true,sourceHashes:hashes,baseline,tests,shuffled,mutations,coverage,
    coverageReport:coverageReport.total,propertySeed:1401885,propertyCases:40,
    sqlCoverage:'PostgreSQL does not expose SQL line coverage here; exact/root identities and negative identity/quantity guards are exercised by integration and mutation tests.',
    types:'No TypeScript API change. PostgreSQL validates SQL argument and return types on installation/execution.',
    dependencies:'No dependencies added.',fullRepositorySuite:'Not run; all linked-PO lifecycle, planning, schedule, receipt-posting and split-isolation feature suites were run.'};
  await writeFile(out+'/checks.json',JSON.stringify(summary,null,2)+'\n');
  console.log(JSON.stringify({passed:true,tests:tests.reduce((n,r)=>n+r.tests,0),mutationsKilled:mutations.length,coverage:coverageReport.total.lines.pct}));
} finally {
  await disposeDatabase();
  await admin.end();
}
