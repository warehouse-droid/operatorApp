import crypto from 'node:crypto';
import {query} from '../../../src/db.js';
import {cargoFixture,yard150} from './bin-cargo-fixtures.js';
import {upsertDispatchOrderCatalog} from '../../../src/dispatch-order-catalog-repository.js';
import {getTransportOptions} from '../../../src/mbt/bin-transport-service.js';
export async function transportFixture(options={}) {
  const f=await cargoFixture(options);
  const ref=`SOR${Date.now()}${Math.floor(Math.random()*1000)}`;
  const order={id:ref,type:'SO',customer:'Rental customer',address:'100 Machine Road',pickupLocations:['3445'],
    sourceYard:'3445',sourceAddress:'3445 Kennedy Road, Toronto, ON',windowStart:'09:00',windowEnd:'17:00',
    expectedDeliveryDate:f.planDate,eligible:true,items:[{itemId:9909,lineRowId:'loose-1',lineId:1,itemName:'Screening',quantity:2.5,unit:'YARD',lineWeight:6500},
      {itemId:777,lineRowId:'machine-2',lineId:2,itemName:'Machine',quantity:1,unit:'EACH',lineWeight:0}]};
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='sor_rental_workflow'");
  await upsertDispatchOrderCatalog({orders:[order],source:'test'});
  return {...f,sourceRef:ref,order};
}
export async function transportInput(f,allocations) {
  const options=await getTransportOptions({sourceRef:f.sourceRef,planDate:f.planDate});
  return {sourceRef:f.sourceRef,expectedSourceRevision:options.revision,sourceFingerprint:options.fingerprint,
    actor:f.actor,assetId:f.assetId,allocations,weightLbs:6000,planDate:f.planDate,
    pickup:{kind:'yard',id:yard150},returnDestination:{kind:'yard',id:yard150},
    idempotencyKey:crypto.randomUUID(),correlationId:crypto.randomUUID(),requestId:crypto.randomUUID()};
}
