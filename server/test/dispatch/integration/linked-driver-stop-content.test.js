import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test,{after} from 'node:test';
import {beginRollbackContext,query,closeDb} from '../../../src/db.js';
import {getDriverDayJobs} from '../../../src/driver-repository.js';
import {materializeDriverOfflineJobs} from '../../../src/driver-offline-repository.js';
after(closeDb);
test('one TO pickup shared by two SOs includes both allocations online and offline',async()=>{
  const rollback=await beginRollbackContext();
  try {await rollback.run(async()=>{
    const suffix=crypto.randomUUID().slice(0,8),driver=`cargo-${suffix}`;
    const order=(tag,total,allocated)=>({id:`SO-${suffix}-${tag}`,type:'SO',sourceYard:'3445',pickupLocations:['3445','2967'],
      address:`Isolated ${tag} destination`,items:[{itemId:42,sku:'Goods',itemType:'InvtPart',quantity:total,pieces:total,unit:'PC'}],
      directPickupManifest:[{dependencyId:tag,transferOrderRef:`TO-${suffix}`,salesOrderRef:`SO-${suffix}-${tag}`,location:'2967',
        items:[{itemId:42,itemName:'Goods',quantity:allocated,pieceQty:allocated,unit:'PC'}]}]});
    const orders=[order('A',10,4),order('B',8,3)];
    const plan=(await query("INSERT INTO dispatch_plans(plan_date,status,note) VALUES('2098-08-26','confirmed','isolated linked cargo test') RETURNING id")).rows[0];
    const trucks=[{id:'truck',plate:`CARGO-${suffix}`,driverLogin:driver,driver,loads:[{id:'load',driverLogin:driver,stops:[
      {id:'to-pick',type:'pick',location:'2967',orderRefs:orders.map(o=>o.id)},
      {id:'so-pick',type:'pick',location:'3445',orderRefs:orders.map(o=>o.id)},
      ...orders.map((o,index)=>({id:`drop-${index}`,type:'drop',orderId:o.id,dropAddress:o.address}))]}]}];
    await query('INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks,summary) VALUES($1,$2::jsonb,$3::jsonb,$4::jsonb)',
      [plan.id,JSON.stringify(orders),JSON.stringify(trucks),JSON.stringify({ownYardCodes:['3445','2967','12441','150']})]);
    const route=await getDriverDayJobs(driver,{date:'2098-08-26'});
    const quantity=job=>(job.orders || []).flatMap(o=>o.items || []).flatMap(i=>i.units || [])
      .filter(unit=>unit.unit==='PCS').reduce((sum,unit)=>sum+unit.value,0);
    const pickup=route.jobs.find(job=>job.stopId==='to-pick');
    assert.ok(pickup,'TO pickup must be present in the real materialized driver route');
    assert.equal(quantity(pickup),7);
    assert.equal(quantity(route.jobs.find(job=>job.stopId==='so-pick')),11);
    assert.equal(route.jobs.filter(job=>job.stopType==='dropoff').reduce((sum,job)=>sum+quantity(job),0),18);
    const offline=materializeDriverOfflineJobs(route.jobs,driver).map(entry=>entry.snapshot);
    assert.equal(quantity(offline.find(job=>job.stopId==='to-pick')),7);
    assert.deepEqual(offline.map(job=>job.stopId),route.jobs.map(job=>job.stopId));
  });} finally {await rollback.rollback();}
});
test('a shared PO vendor pickup shows the full PO cargo without displaying its linked SO allocation twice',async()=>{
  const rollback=await beginRollbackContext();
  try {await rollback.run(async()=>{
    const suffix=crypto.randomUUID().slice(0,8),driver=`po-cargo-${suffix}`,poRef=`PO-${suffix}`,soRef=`SO-${suffix}`;
    const item=(quantity)=>({itemId:42,sku:'Goods',itemType:'InvtPart',quantity,pallets:quantity,unit:'PLT',lineRowId:'goods'});
    const po={id:poRef,type:'PO',sourceYard:'Vendor A',pickupLocations:['Vendor A'],items:[item(51)],
      poRouteProjection:{version:1,items:[item(13)],pallets:13,dropoffs:[{destinationYard:'3445',lineRowIds:['goods']}]}};
    const so={id:soRef,type:'SO',sourceYard:'3445',pickupLocations:['Vendor A'],items:[{...item(38),poAllocatedPallets:38,poAllocatedSalesQty:38}],
      poPickupManifest:[{poOrderRef:poRef,location:'Vendor A',items:[item(38)]}]};
    const plan=(await query("INSERT INTO dispatch_plans(plan_date,status,note) VALUES('2098-08-27','confirmed','isolated PO cargo test') RETURNING id")).rows[0];
    const trucks=[{id:'truck',driverLogin:driver,driver,plate:`PO-CARGO-${suffix}`,loads:[{id:'load',stops:[
      {id:'vendor',type:'pick',location:'Vendor A',orderRefs:[poRef,soRef]},
      {id:'customer',type:'drop',orderId:soRef,dropAddress:'Isolated customer'},
      {id:'yard',type:'drop',orderId:poRef,dropLocation:'3445',lineRowIds:['goods']}]}]}];
    await query('INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks,summary) VALUES($1,$2::jsonb,$3::jsonb,$4::jsonb)',
      [plan.id,JSON.stringify([po,so]),JSON.stringify(trucks),'{}']);
    const route=await getDriverDayJobs(driver,{date:'2098-08-27'});
    const pallets=job=>job.orders.flatMap(order=>order.items).flatMap(cargoItem=>cargoItem.units).filter(unit=>unit.unit==='PLT').reduce((sum,unit)=>sum+unit.value,0);
    assert.equal(pallets(route.jobs.find(job=>job.stopId==='vendor')),51);
    assert.equal(pallets(route.jobs.find(job=>job.stopId==='customer')),38);
    assert.equal(pallets(route.jobs.find(job=>job.stopId==='yard')),13);
    assert.deepEqual(route.jobs.find(job=>job.stopId==='vendor').orderRefs,[soRef,poRef]);
  });}finally{await rollback.rollback();}
});
