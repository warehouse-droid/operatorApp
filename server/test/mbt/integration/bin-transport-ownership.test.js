import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {query,closeDb} from '../../../src/db.js';
import {assertTransportSourceOpen,readTransportSource} from '../../../src/mbt/bin-transport-sources.js';
import {transportFixture,transportInput} from '../support/bin-transport-fixtures.js';
import {saveTransportTrip} from '../../../src/mbt/bin-transport-service.js';
import {assertTransportOrderOwnership,filterOrdinaryTransportOrders} from '../../../src/mbt/bin-transport-ownership.js';
import {upsertDispatchOrderCatalog,listDispatchOrderPool} from '../../../src/dispatch-order-catalog-repository.js';
after(closeDb);
const plan=order=>({orders:[order],trucks:[{id:'1',loads:[{id:'load',stops:[{id:'pick',type:'pick',orderId:order.id},{id:'drop',type:'drop',orderId:order.id}]}]}]});
test('Transport ownership: aggregate is absent from ordinary browse/search and new assignments; existing route history remains',async()=>{
  const f=await transportFixture();
  assert.deepEqual(await filterOrdinaryTransportOrders([f.order]),[]);
  assert.equal((await listDispatchOrderPool({search:f.sourceRef})).orders.length,0);
  await assert.rejects(assertTransportOrderOwnership({},plan(f.order)),e=>e.code==='MBT_TRANSPORT_BIN_REQUIRED');
  await assertTransportOrderOwnership(plan(f.order),plan(f.order));
});
test('Transport ownership: SOR is shared until BIN trip claim, and forged card items cannot bypass canonical source ownership',async()=>{
  const f=await transportFixture();
  f.order={...f.order,items:f.order.items.map(item=>({...item,itemId:777}))};
  await upsertDispatchOrderCatalog({orders:[f.order],source:'test'});
  assert.equal((await filterOrdinaryTransportOrders([f.order])).length,1);
  await assertTransportOrderOwnership({},plan(f.order));
  await saveTransportTrip(await transportInput(f,[{lineKey:'loose-1',quantity:'1'}]));
  assert.deepEqual(await filterOrdinaryTransportOrders([f.order]),[]);
  await assert.rejects(assertTransportOrderOwnership({},plan({...f.order,items:[],type:'CUSTOM'})),e=>e.code==='MBT_TRANSPORT_ALREADY_CLAIMED');
});
test('Transport ownership: independent grouped orders and an existing ordinary assignment cannot acquire a BIN claim',async()=>{
  const f=await transportFixture(),source=await readTransportSource(f.sourceRef);
  await assert.rejects(assertTransportSourceOpen({...source,order:{...source.order,childOrders:['SOR1','SOR2']}}),/Ungroup/i);
  const input=await transportInput(f,[{lineKey:'loose-1',quantity:'1'}]);
  await query('INSERT INTO dispatch_plan_order_assignments(plan_id,plan_date,order_ref,load_id) VALUES($1,$2,$3,$4)',
    [f.planId,f.planDate,f.sourceRef,f.binLoadIds[0]]);
  await assert.rejects(saveTransportTrip(input),/already assigned in Dispatch/i);
  assert.equal((await query('SELECT count(*)::int AS n FROM mbt_transport_trips WHERE source_key=lower($1)',[f.sourceRef])).rows[0].n,0);
  await query('DELETE FROM dispatch_plan_order_assignments WHERE plan_id=$1 AND order_ref=$2',[f.planId,f.sourceRef]);
  assert.equal((await saveTransportTrip(input)).body.trip.sourceRef,f.sourceRef);
});
