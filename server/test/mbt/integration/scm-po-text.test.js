import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {beginRollbackContext,closeDb,query} from '../../../src/db.js';
import {getScmPurchaseOrderCatalogOrder,upsertScmPurchaseOrderCatalog,listScmPurchaseOrderCatalog} from '../../../src/scm-purchase-order-catalog-repository.js';
import {updateScmScheduleEntry,listScmSchedule} from '../../../src/dispatch-repository.js';

after(closeDb);
test('PO remark and Note read current source fields, share local edits and reset without changing the PO',async()=>{
  const rollback=await beginRollbackContext();
  try {await rollback.run(async()=>{
    const id=9_100_000_000_000+Date.now(),ref='TEST-PO-TEXT-'+id;
    await query(`INSERT INTO purchase_orders(netsuite_id,tranid,trandate,vendor,status,status_text,memo,dispatch_instructions,netsuite_active,synced_at)
      VALUES($1,$2,current_date,'TEST','pendingReceipt','Pending Receipt','Pickering Yard - Unilock','Mon-Fri',true,now())`,[id,ref]);
    await upsertScmPurchaseOrderCatalog({orders:[{id:ref,type:'PO',originalPoRef:ref,notes:'Old cached instructions',scm:{method:'MBT',status:'Hold',notes:''},items:[]}],source:'po-text-test'});
    let order=await getScmPurchaseOrderCatalogOrder(ref);
    assert.equal(order.scm.netSuiteMemo,'Pickering Yard - Unilock');
    assert.equal(order.scm.remark,'Pickering Yard - Unilock');
    assert.equal(order.scm.remarkOverride,'');
    assert.equal(order.scm.notes,'Mon-Fri');
    await updateScmScheduleEntry({orderKind:'PO',orderRef:ref,patch:{remarkOverride:'Call before pickup',notes:'Bring the signed PO'},updatedBy:'test-po-text',expectedUpdatedAt:null});
    order=await getScmPurchaseOrderCatalogOrder(ref);
    assert.equal(order.scm.remark,'Call before pickup');
    assert.equal(order.scm.notes,'Bring the signed PO');
    const card=(await listScmPurchaseOrderCatalog({search:ref})).orders.find(o=>o.id===ref);
    assert.equal(card.scm.remarkOverride,'Call before pickup');
    const schedule=(await listScmSchedule({exactRef:ref})).find(row=>row.orderRef===ref);
    assert.equal(schedule.remark,'Call before pickup');
    assert.equal(schedule.netSuiteMemo,'Pickering Yard - Unilock');
    assert.equal(schedule.notes,'Bring the signed PO');
    await assert.rejects(()=>updateScmScheduleEntry({orderKind:'PO',orderRef:ref,patch:{notes:'Stale overwrite'},expectedUpdatedAt:null}),{status:409});
    await updateScmScheduleEntry({orderKind:'PO',orderRef:ref,patch:{remarkOverride:'',notes:''},updatedBy:'test-po-text',expectedUpdatedAt:order.scm.updatedAt});
    order=await getScmPurchaseOrderCatalogOrder(ref);
    assert.equal(order.scm.remark,'Pickering Yard - Unilock');
    assert.equal(order.scm.notes,'Mon-Fri');
    assert.equal((await listScmSchedule({exactRef:ref,remarkSearch:'Pickering Yard'})).length,1);
    assert.deepEqual((await query('SELECT memo,dispatch_instructions FROM purchase_orders WHERE netsuite_id=$1',[id])).rows,[{memo:'Pickering Yard - Unilock',dispatch_instructions:'Mon-Fri'}]);
    await query("UPDATE purchase_orders SET memo='Updated source remark',dispatch_instructions='Updated source Note' WHERE netsuite_id=$1",[id]);
    order=await getScmPurchaseOrderCatalogOrder(ref);
    assert.equal(order.scm.remark,'Updated source remark');
    assert.equal(order.scm.notes,'Updated source Note');
  });} finally {await rollback.rollback();}
});

test('a newly discovered PO returns mapped Remark and Note on its first catalog API response',async()=>{
  const rollback=await beginRollbackContext();
  try {await rollback.run(async()=>{
    const id=9_200_000_000_000+Date.now(),ref='TEST-NEW-TEXT-'+id;
    await query(`INSERT INTO purchase_orders(netsuite_id,tranid,trandate,vendor,status,memo,dispatch_instructions,netsuite_active,synced_at)
      VALUES($1,$2,current_date,'TEST','pendingReceipt','New PO remark','New PO Note',true,now())`,[id,ref]);
    const source=await readFile('src/server.js','utf8');
    const start=source.indexOf('app.get("/api/dispatch/scm/v2/purchase-orders/:ref",');
    const end=source.indexOf('\n});',start)+4;
    assert.ok(start>=0 && end>start);
    let handler,response;
    runInNewContext(source.slice(start,end),{
      app:{get:(_path,fn)=>{handler=fn;}},dispatchPrivateNoStore:()=>{},canViewRestrictedScmOrders:()=>true,
      getScmPurchaseOrderCatalogOrder,upsertScmPurchaseOrderCatalog,
      targetedScmPurchaseOrdersForResponse:async()=>[{id:ref,originalPoRef:ref,type:'PO',scm:{notes:'',remarkOverride:''},items:[]}]
    });
    await handler({params:{ref},operator:{role:'scm'}},{json:value=>{response=value;},status:()=>{throw new Error('PO should be found');}},error=>{throw error;});
    assert.equal(response.order.scm.remark,'New PO remark');
    assert.equal(response.order.scm.notes,'New PO Note');
    assert.equal(response.order.scm.netSuiteMemo,'New PO remark');
  });} finally {await rollback.rollback();}
});
