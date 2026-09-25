import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import { query,withTransaction,closeDb } from '../../src/db.js';
import { createFieldSalesRuntime } from '../../src/field-sales/runtime.js';
after(closeDb);
if(process.env.MBT_TEST_ISOLATED!=='1'){throw new Error('Disposable database required.');}
test('W1 runtime starts once, does no gated work, records network failure and stops both workers',()=>withTransaction(async()=>{
  const original={setInterval,clearInterval,fetch,error:console.error},timers=[],errors=[];
  try{
    globalThis.setInterval=(fn,ms)=>{const timer={fn,ms,unrefs:0,unref(){this.unrefs++;}};timers.push(timer);return timer;};
    globalThis.clearInterval=timer=>{timer.cleared=true;};console.error=(...message)=>errors.push(message.join(' '));
    globalThis.fetch=async()=>{throw new Error('City unavailable in runtime test');};
    await query(`UPDATE field_sales_settings SET data=data||'{"enabled":false,"importsEnabled":false}'::jsonb`);
    await query('DELETE FROM field_sales_import_stage');await query('DELETE FROM field_sales_import_runs');
    const runtime=createFieldSalesRuntime({maps:{},browserMap:async()=>({available:false})});
    runtime.start();runtime.start();assert.deepEqual(timers.map(t=>t.ms),[15000,60000]);assert.ok(timers.every(t=>t.unrefs===1));
    await timers[0].fn();await timers[1].fn();assert.equal((await query('SELECT count(*)::int AS n FROM field_sales_import_runs')).rows[0].n,0);
    await query(`UPDATE field_sales_settings SET data=data||'{"enabled":true,"importsEnabled":true}'::jsonb`);
    await Promise.all([timers[1].fn(),timers[1].fn()]);
    const runs=(await query('SELECT * FROM field_sales_import_runs')).rows;assert.equal(runs.length,1);assert.equal(runs[0].state,'failed');assert.match(runs[0].error,/City unavailable/);assert.ok(errors.some(e=>e.includes('[field-sales worker]')&&e.includes('City unavailable')));
    runtime.stop();assert.ok(timers.every(t=>t.cleared));runtime.start();assert.equal(timers.length,4);runtime.stop();
  }finally{globalThis.setInterval=original.setInterval;globalThis.clearInterval=original.clearInterval;globalThis.fetch=original.fetch;console.error=original.error;}
},{rollback:true}));
