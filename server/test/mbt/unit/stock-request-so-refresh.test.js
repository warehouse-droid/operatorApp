import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { STOCK_REQUEST_SO_REFRESH_INTERVAL_MS, stockRequestSalesOrderObservation as observe } from '../../../src/stock-request-so-refresh-domain.js';
import { createStockRequestSalesOrderRefresh, startStockRequestSalesOrderRefresh } from '../../../src/stock-request-so-refresh.js';
import { regularStockStatusSummary } from '../../../public/regular-stock-status.js';
const candidate={id:8123456,ref:'SO-HOURLY'};
const remote=(quantity=10,fulfilled=0,status='B')=>({id:candidate.id,tranid:candidate.ref,status,
 status_text:{B:'Sales Order : Pending Fulfillment',D:'Sales Order : Partially Fulfilled',F:'Sales Order : Pending Billing',G:'Sales Order : Billed',H:'Sales Order : Closed'}[status],
 lines:[{line_id:17,item_id:2055,item_type:'NonInvtPart',quantity,netsuite_received_qty:fulfilled}]});
test('hourly cadence is 60 minutes and the runtime registers the guarded hourly check',()=>{
 assert.equal(STOCK_REQUEST_SO_REFRESH_INTERVAL_MS,3600000);
 let interval,callback,ticks=0,unref=0,cleared=0;
 const stop=startStockRequestSalesOrderRefresh({runOnce:async()=>{ticks++;},setInterval:(fn,ms)=>{callback=fn;interval=ms;return {unref(){unref++;}};},clearInterval:()=>{cleared++;}});
 assert.equal(interval,3600000);assert.equal(ticks,1);callback();assert.equal(ticks,2);assert.equal(unref,1);stop();assert.equal(cleared,1);
});
test('generated quantities distinguish partial from full fulfillment without treating fees as cargo',()=>{
 fc.assert(fc.property(fc.integer({min:1,max:100000}),fc.integer({min:0,max:999}), (qty,fraction)=>{
  const partial=observe(candidate,remote(qty,qty*fraction/1000,'D'));
  assert.equal(partial.completed,false);assert.equal(partial.fulfillmentStatus,fraction?'partial_fulfilled':'not_fulfilled');
  const done=remote(qty,qty,'D');done.lines.push({line_id:18,item_id:1987,item_type:'OthCharge',quantity:1,netsuite_received_qty:0});
  assert.equal(observe(candidate,done).completed,true);
 }),{seed:20261028,numRuns:100});
});
test('fully fulfilled accounting headers complete non-inventory SOs; closed orders do not imply fulfillment',()=>{
 for(const status of ['F','G'])assert.equal(observe(candidate,remote(10,0,status)).completed,true);
 const closed=observe(candidate,remote(10,3,'H'));assert.equal(closed.completed,false);assert.equal(closed.terminal,true);
});
test('a real NetSuite synthetic subtotal line is retained but never counts as cargo',()=>{
 const order=remote();order.lines.push({line_id:18,item_id:-2,quantity:0,netsuite_received_qty:0});
 const result=observe(candidate,order);assert.equal(result.completed,false);assert.equal(result.lines[1].itemId,-2);
});
test('reject missing identities, quantities, duplicate lines and mismatched order responses',()=>{
 for(const bad of [null,{...remote(),id:99},{...remote(),tranid:'OTHER'},{...remote(),status:'?'},{...remote(),lines:[]},
  {...remote(),lines:[...remote().lines,...remote().lines]},
  ...[null,'bad',Infinity,-1].map(value=>({...remote(),lines:[{...remote().lines[0],netsuite_received_qty:value}]})),
  {...remote(),lines:[{...remote().lines[0],item_id:null}]}])assert.throws(()=>observe(candidate,bad),/invalid|missing|match|duplicate/i);
});
test('disabled and busy workers never claim the slot or fetch NetSuite',async()=>{
 for(const extra of [{enabled:()=>false},{enabled:()=>true,operationalSyncRunning:()=>true}]){
  const worker=createStockRequestSalesOrderRefresh({...extra,withSlot:()=>assert.fail('must not claim')});
  assert.equal((await worker.runOnce()).started,false);
 }
});
test('worker retains failed orders, continues good ones, and emits only committed updates',async()=>{
 const audits=[],events=[],applied=[];
 const worker=createStockRequestSalesOrderRefresh({enabled:()=>true,withSlot:async(_now,run)=>run(async()=>{}),
  listCandidates:async()=>[candidate,{id:2,ref:'OTHER'},{id:3,ref:'STALE'}],
  fetchProgress:async id=>{if(id===2)throw Error('NetSuite unavailable');return {...remote(),id,tranid:id===3?'STALE':candidate.ref};},
  applyObservation:async(c,o)=>{applied.push(c.id);return {updated:c.id!==3,requestIds:[7],completed:o.completed};},
  audit:async value=>audits.push(value),emit:value=>events.push(value)});
 const result=await worker.runOnce();assert.deepEqual([result.checked,result.updated,result.failed,result.stale],[3,1,1,1]);
 assert.deepEqual(applied,[candidate.id,3]);assert.equal(events.length,1);assert.ok(audits.some(a=>a.action.endsWith('.failed')&&a.details.error.includes('unavailable')));
});
test('a running worker refuses an overlapping tick and resets after an unexpected failure',async()=>{
 let open,entered;const gate=new Promise(r=>{open=r;}),start=new Promise(r=>{entered=r;});
 const worker=createStockRequestSalesOrderRefresh({enabled:()=>true,withSlot:async(_now,run)=>run(async()=>{}),
  listCandidates:async()=>{entered();await gate;throw Error('database unavailable');}});
 const first=worker.runOnce();await start;assert.equal((await worker.runOnce()).reason,'already_running');open();
 await assert.rejects(first,/database unavailable/);await assert.rejects(worker.runOnce(),/database unavailable/);
});
test('loss of the database run lock prevents applying an already fetched response',async()=>{
 let checks=0;
 const worker=createStockRequestSalesOrderRefresh({enabled:()=>true,withSlot:async(_now,run)=>run(async()=>{if(++checks>1)throw Error('lock connection lost');}),
  listCandidates:async()=>[candidate],fetchProgress:async()=>remote(),applyObservation:()=>assert.fail('must not apply'),audit:async()=>{}});
 await assert.rejects(worker.runOnce(),/lock connection lost/);
});
test('Regular pickup completion and summary expose verified status and escape remote text',()=>{
 const request={workflowVersion:2,status:'active',regular:{deliveryMethod:'pickup',salesOrderRef:candidate.ref,
  salesOrderProgress:{completed:true,statusText:'Sales Order : Pending Billing',checkedAt:'2026-10-28T10:00:00.000Z'}},lines:[{id:1,status:'converted'}]};
 assert.equal(regularStockStatusSummary(request).status,'completed');assert.equal(regularStockStatusSummary(request).detail,'so_fulfilled');
 const context={window:{},Intl,Date};vm.createContext(context);vm.runInContext(readFileSync('public/regular-stock-ui.js','utf8'),context);
 const html=context.window.RegularStockUI.summary(request);assert.match(html,/Pending Billing/);assert.match(html,/Last checked/);
 request.regular.salesOrderProgress.statusText='<img src=x onerror=alert(1)>';assert.doesNotMatch(context.window.RegularStockUI.summary(request),/<img/);
});
