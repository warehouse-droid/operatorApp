import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { query, closeDb } from '../../src/db.js';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
assert.equal(new URL(process.env.DATABASE_URL).hostname,'db');
const sql=readFileSync('migrations/292_sales_order_line_sync_holds.sql','utf8');
const out='test-artifacts/som06964-release-20261015';
const mutants=[
  ['drop-source-protection','NEW := jsonb_populate_record(NEW, held_source);','NEW := NEW;'],
  ['accept-synced-loaded-quantity','NEW.loaded_qty := OLD.loaded_qty;','NEW.loaded_qty := NEW.loaded_qty;'],
  ['ignore-hold-release',' AND released_at IS NULL',''],
  ['freeze-unrelated-line','sales_order_line_id = OLD.id AND released_at IS NULL','released_at IS NULL ORDER BY sales_order_line_id LIMIT 1']
];
const results=[];
try {
  for(const [name,before,after] of mutants){
    assert.equal(sql.split(before).length,2,name);
    await query(sql.replace(before,after));
    const run=pattern=>spawnSync(process.execPath,['--test',...(pattern?['--test-name-pattern='+pattern]:[]),
      'test/dispatch/integration/sales-line-sync-hold.test.js'],{env:process.env,encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
    // The rollback/reapply test deliberately reinstalls the original function;
    // choose the relevant behavior before that rehearsal.
    const pattern=name==='ignore-hold-release'?'^explicit release':name==='freeze-unrelated-line'?'^holding one line':'^held line remains';
    const r=run(pattern),log=r.stdout+r.stderr;
    writeFileSync(`${out}/hold-mutant-${name}.log`,log);
    const p=run('^property:'),propertyLog=p.stdout+p.stderr;
    writeFileSync(`${out}/hold-mutant-${name}-property.log`,propertyLog);
    const killed=r.status===1&&/ERR_ASSERTION|ERR_TEST_FAILURE|duplicate key value/u.test(log);
    results.push({name,killed,exit:r.status,propertyKilled:p.status===1&&/Property failed/u.test(propertyLog)});
    writeFileSync(`${out}/hold-mutations.json`,JSON.stringify(results,null,2)+'\n');
    assert.equal(killed,true,name+' survived: '+log.slice(-1500));
    await query(sql);
  }
  console.log(JSON.stringify(results));
} finally {await query(sql);await closeDb();}
