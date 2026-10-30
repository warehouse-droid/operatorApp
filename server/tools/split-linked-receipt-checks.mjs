import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
import {ESLint} from 'eslint';
import {runNodeTestFilesIsolated,describeIsolatedTestDatabase} from '../test/support/test-database-isolation.mjs';
import {primary,regression} from './partial-linked-posting-suites.mjs';

const focused='test/mbt/integration/split-linked-receipt.test.js';
const sqlFile='migrations/324_grouped_split_allocation_execution.sql';
const sql=fs.readFileSync(sqlFile,'utf8');
const files=[...primary,...regression];
describeIsolatedTestDatabase(process.env.DATABASE_URL);
if(process.argv[2]==='suite') {
  const selection=process.argv[3]==='baseline'?files:[focused,...files];
  process.exitCode=await runNodeTestFilesIsolated(process.argv[3]==='reverse'?selection.reverse():selection,{label:'split-receipt'});
} else {
  const output='test-artifacts/split-receipt';fs.mkdirSync(output,{recursive:true});
  const report={node:process.version,migrationSha256:crypto.createHash('sha256').update(sql).digest('hex')};
  async function apply(value) {
    const client=new pg.Client({connectionString:process.env.DATABASE_URL});await client.connect();
    try {await client.query(value);} finally {await client.end();}
  }
  function run(label,args) {
    const result=spawnSync(process.execPath,args,{encoding:'utf8',timeout:900000,maxBuffer:64*1024*1024});
    const text=(result.stdout||'')+(result.stderr||'');fs.writeFileSync(`${output}/${label}.log`,text);
    assert(!result.signal && !result.error,`${label}: ${result.error||result.signal}`);
    const counts={tests:0,pass:0,fail:0};for(const [,key,n] of text.matchAll(/^ℹ (tests|pass|fail) (\d+)$/gm)) counts[key]+=Number(n);
    const failures=[...new Set([...text.matchAll(/^✖ (.+?) \([\d.]+ms\)/gm)].map(match=>match[1]))];
    return {exit:result.status,...counts,failures};
  }
  const old=fs.readFileSync('migrations/180_sales_order_completion_fulfillment.sql','utf8');
  const oldDefinition=old.slice(old.indexOf('CREATE OR REPLACE FUNCTION dispatch_project_so_po_allocation_execution()'),old.indexOf('DROP TRIGGER IF EXISTS trg_dispatch_so_po_allocation_execution'));
  try {
    await apply(oldDefinition);
    report.baseline=run('baseline',[import.meta.filename,'suite','baseline']);
    console.log(JSON.stringify({stage:'baseline',...report.baseline}));
    await apply(sql);
    for(const mode of ['candidate','reverse']) {
      report[mode]=run(mode,[import.meta.filename,'suite',mode]);
      report[mode].newFailures=report[mode].failures.filter(name=>!report.baseline.failures.includes(name));
      console.log(JSON.stringify({stage:mode,...report[mode]}));
      assert.equal(report[mode].newFailures.length,0,`${mode}: new regression failures`);
      assert.equal(report[mode].fail,report[mode].failures.length,'Every failure must be identified');
      assert(report[mode].tests>report.baseline.tests);
    }
    const mutants=[
      ['wrong-group',"grouped->>'id' = allocation.dispatch_target_ref",'true'],
      ['wrong-line',"item->>'lineRowId' = allocation.sales_line_id::text",'true'],
      ['excess-quantity',"(item->>'quantity')::numeric ELSE 0 END >= (","(item->>'quantity')::numeric ELSE 0 END + 999999 >= ("],
      ['missing-split',"SELECT allocation.dispatch_target_kind = 'group'","SELECT false AND allocation.dispatch_target_kind = 'group'"]
    ];
    report.mutations=[];
    for(const [name,before,after] of mutants) {
      assert.equal(sql.split(before).length,2,name);await apply(sql.replace(before,after));
      const result=run(`mutant-${name}`,['--test','--test-concurrency=1','--test-reporter=spec','--test-name-pattern=^property:',focused]);
      report.mutations.push({name,killed:result.exit===1 && result.failures.length===1,propertyOnly:true});
      await apply(sql);
    }
    assert(report.mutations.every(m=>m.killed));
    const codeFiles=[focused,'test/support/split-linked-receipt-fixture.mjs','tools/split-linked-receipt-checks.mjs'];
    if(fs.existsSync('tools/pob04054-ir-recover.mjs')) codeFiles.push('tools/pob04054-ir-recover.mjs');
    const eslint=new ESLint({overrideConfigFile:true,overrideConfig:[{files:['**/*.js','**/*.mjs'],languageOptions:{ecmaVersion:'latest',sourceType:'module'},rules:{eqeqeq:'error','no-unreachable':'error','no-unused-vars':['error',{argsIgnorePattern:'^_'}],'prefer-const':'error'}}]});
    report.lint=(await eslint.lintFiles(codeFiles)).flatMap(row=>row.messages.map(m=>({file:row.filePath,line:m.line,message:m.message})));
    assert.equal(report.lint.length,0,JSON.stringify(report.lint));
    for(const file of codeFiles) assert.equal(spawnSync(process.execPath,['--check',file]).status,0,file);
    report.sqlCoverage='Scenario coverage; PL/pgSQL line instrumentation unavailable';
    console.log(`SPLIT_RECEIPT_REPORT ${JSON.stringify(report)}`);
  } finally {await apply(sql);}
}
