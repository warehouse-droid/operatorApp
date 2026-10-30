import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {query,closeDb} from '../../../src/db.js';
import {transportFixture,transportInput} from '../support/bin-transport-fixtures.js';
import {readTransportSource} from '../../../src/mbt/bin-transport-sources.js';
import {saveTransportTrip,getTransportOptions} from '../../../src/mbt/bin-transport-service.js';
import {getTransportPlanning} from '../../../src/mbt/bin-transport-read.js';
import {filterOrdinaryTransportOrders} from '../../../src/mbt/bin-transport-ownership.js';
import {getBinCargoOptions} from '../../../src/mbt/bin-cargo-service.js';
after(closeDb);
test('Transport Front Desk: mixed aggregate lines share one original order, exact quantities, no duplicated billing and no ordinary/custom cargo pool entry',async()=>{
  const f=await transportFixture(),charge=crypto.randomUUID(),ref=`MBT-AGG-${Date.now()}`;
  const pricing={calculation:{lines:[{lineType:'aggregate_material',itemCode:'GRAVEL',label:'Gravel',quantityMilliUnits:1250,derivedWeightLbs:3250},
    {lineType:'aggregate_material',itemCode:'SAND',label:'Sand',quantityMilliUnits:500,derivedWeightLbs:1300},
    {lineType:'aggregate_delivery',itemCode:'FEE',label:'Delivery fee',quantityMilliUnits:1000}]}};
  await query(`INSERT INTO mbt_frontdesk_charge_requests(charge_request_id,request_number,request_kind,status,payment_method,payment_category,tax_mode,
    netsuite_export_policy,pricing_snapshot,pre_tax_revenue_minor,request_total_minor,resulting_contract_total_minor,
    billing_address_text,service_address_text,contract_telephone,reason,confirmed_at,confirmed_by,created_by,updated_by)
    VALUES($1,$2,'aggregate_order','confirmed','cash','cash','included','excluded_cash',$3::jsonb,10000,10000,10000,
      '100 Test Billing Road','200 Aggregate Customer Road','4165550100','Transport fixture',now(),'test','test','test')`,[charge,ref,JSON.stringify(pricing)]);
  await query(`INSERT INTO dispatch_custom_orders(ref_number,pickup_location,dropoff_location,order_details,weight_lbs,mbt_source,mbt_charge_request_id)
    VALUES($1,'Yard 150','200 Aggregate Customer Road','Mixed material delivery',4550,'frontdesk_aggregate',$2)`,[ref,charge]);
  const source=await readTransportSource(ref);
  assert.equal(source.snapshot.kind,'frontdesk_aggregate');assert.deepEqual(source.snapshot.lines.map(l=>l.quantity),['1.25','0.5']);
  assert.equal((await getTransportPlanning({planDate:f.planDate,search:ref})).pool.items[0].transport.sourceRef,ref);
  assert.deepEqual(await filterOrdinaryTransportOrders([source.order]),[]);
  assert.equal((await getBinCargoOptions(f.part.visitId)).customOrders.some(o=>o.refNumber===ref),false);
  const customId=(await query('SELECT id FROM dispatch_custom_orders WHERE ref_number=$1',[ref])).rows[0].id;
  await query(`INSERT INTO mbt_bin_cargo_plans(order_id,part_role,plan,custom_order_id,created_by,updated_by)
    VALUES($1,'delivery','{}',$2,'test','test')`,[(await getBinCargoOptions(f.part.visitId)).orderId,customId]);
  await assert.rejects(saveTransportTrip(await transportInput({...f,sourceRef:ref},source.snapshot.lines.map(l=>({lineKey:l.key,quantity:l.quantity})))),/cargo|another BIN/i);
  await query('DELETE FROM mbt_bin_cargo_plans WHERE custom_order_id=$1',[customId]);
  const trip=(await saveTransportTrip(await transportInput({...f,sourceRef:ref},source.snapshot.lines.map(l=>({lineKey:l.key,quantity:l.quantity}))))).body.trip;
  assert.equal(trip.sourceRef,ref);assert.equal(trip.allocations.length,2);
  assert.deepEqual((await getTransportOptions({sourceRef:ref,planDate:f.planDate})).lines.map(l=>l.remaining),['0','0']);
  assert.equal((await query('SELECT count(*)::int AS n FROM mbt_frontdesk_charge_requests WHERE charge_request_id=$1',[charge])).rows[0].n,1);
  assert.equal((await query('SELECT count(*)::int AS n FROM mbt_service_visits WHERE visit_reference=$1',[ref])).rows[0].n,0);
});
