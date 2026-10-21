import assert from 'node:assert/strict';
import test, {before,after} from 'node:test';
import {readFile} from 'node:fs/promises';
import {fixture} from '../../support/operator-suiteql-fixture.mjs';
import {createSpecialStockRequestService} from '../../../src/special-stock-request-service.js';
import {fetchPurchaseOrdersFromNetSuite,fetchPurchaseOrderFromNetSuite,fetchPurchaseOrderReferenceFromNetSuite,
  fetchPurchaseOrderHistorySnapshotFromNetSuite} from '../../../src/netsuite.js';
import {beginRollbackContext,query} from '../../../src/db.js';
import {upsertPurchaseOrders} from '../../../src/order-sync-repository.js';
import {getNetSuiteMirrorOrderSnapshot} from '../../../src/netsuite-mirror-repository.js';
import {getScmPurchaseOrderCatalogOrder,upsertScmPurchaseOrderCatalog} from '../../../src/scm-purchase-order-catalog-repository.js';
import {listScmSchedule,updateScmScheduleEntry} from '../../../src/dispatch-repository.js';
import {specialPoRoutingHtml} from '../../../public/special-stock-po-routing.js';

let transport;
before(async()=>{transport=await fixture();});
after(async()=>{await transport.close();});

for(const lostResponse of [false,true]) test(`the standalone PO POST carries the SO Note${lostResponse?' and recovers a lost response':''}`,async()=>{
  const calls=[];
  let posted=false;
  const material={caseLineId:1,itemId:2055,quantity:24,uom:'PC',unitId:865,unitPurchaseCost:33.87,description:'Material',vendorDiscountPercent:0};
  const detail={id:83,revision:7,salesOrderId:1030576,salesOrderRef:'SOB121819',salesOrderApproved:true,vendorId:331,
    operationalYardLocationId:1,vendorDiscountReview:{mode:'per_line',lines:[{caseLineId:1,vendorDiscountPercent:0}]},
    salesOrderLines:[{...material,remoteLineId:5058992,rate:48.39}],purchaseOrderLines:[material,
      {itemId:1784,ancillary:true,quantity:1,uom:'EACH',unitId:246,unitPurchaseCost:35,description:'PALLET'}]};
  transport.state.handle=async request=>{
    calls.push(request);
    assert.equal(request.method,'POST');
    assert.ok(request.url.pathname.endsWith('/record/v1/purchaseOrder'));
    posted=true;
    return lostResponse?{status:400,data:{error:'Response lost after commit'}}:
      {status:204,headers:{location:'/services/rest/record/v1/purchaseOrder/1030348'}};
  };
  const service=createSpecialStockRequestService({getCase:async()=>detail,claimOperation:async()=>detail,markSubmitted:async()=>detail,
    resolveLocations:async()=>[{netsuiteLocationId:1}],resolveOrderUnits:async value=>value,
    findMarkerOrders:async()=>posted?[{id:1030348,entity_id:331,location_id:1}]:[],findLinkedPurchaseOrder:async()=>null,
    synchronizeSalesDescriptions:async()=>{throw Error('SO must not be changed');},
    finalizeLinkedPurchaseOrder:async()=>{throw Error('No native PO link is created');},
    fetchPurchaseOrderReference:async()=>({tranid:'POB03976'}),recordPurchaseOrderCreation:async()=>{},
    linkPurchaseOrder:async(_id,value)=>({...detail,purchaseOrderId:value.purchaseOrderId}),failOperation:async()=>{},sleep:async()=>{}});
  const result=await service.createPurchaseOrder(83,{expectedRevision:7,operationId:'so-note-post'});
  assert.equal(result.purchaseOrderId,1030348);
  assert.equal(calls.length,1);
  assert.equal(calls[0].body.custbody7,'for SOB121819');
  assert.equal(calls[0].body.externalId,'MBBS-SPECIAL-PO:83');
  assert.equal(calls[0].body.createdFrom,undefined);
  assert.deepEqual(calls[0].body.item.items.map(line=>[line.item.id,line.quantity,line.rate,line.units]),
    [['2055',24,33.87,'865'],['1784',1,35,'246']]);
});

test('PO discovery, targeted reads and history query the actual Note independently of memo',async()=>{
  transport.state.handle=async request=>{
    assert.match(request.body.q,/t\.custbody7 AS netsuite_note/);
    return {data:{items:[{id:'1030348',tranid:'POB03976',memo:'Pickering Yard - Unilock',netsuite_note:'for SOB121819'}]}};
  };
  for(const read of [async()=>(await fetchPurchaseOrdersFromNetSuite(1))[0],
    ()=>fetchPurchaseOrderFromNetSuite(1030348),()=>fetchPurchaseOrderReferenceFromNetSuite(1030348)]) {
    const order=await read();
    assert.equal(order.memo,'Pickering Yard - Unilock');
    assert.equal(order.netsuite_note,'for SOB121819');
  }
  const history=await fetchPurchaseOrderHistorySnapshotFromNetSuite(1030348);
  assert.equal(history.memo,'Pickering Yard - Unilock');
  assert.equal(history.note,'for SOB121819');
  transport.state.handle=async()=>({data:{items:[{id:'1030348',tranid:'POB03976',memo:'Remark'}]}});
  assert.equal((await fetchPurchaseOrderReferenceFromNetSuite(1030348)).netsuite_note,'');
  assert.equal((await fetchPurchaseOrderHistorySnapshotFromNetSuite(1030348)).note,'');
});

test('canonical sync, mirror and both mini-bar sources retain actual Notes, local edits and aliases',async()=>{
  const rollback=await beginRollbackContext();
  try {await rollback.run(async()=>{
    const migration=await readFile('migrations/247_purchase_order_note.sql','utf8');
    await query(migration);await query(migration);
    const id=9_300_000_000_000+Date.now(),ref='TEST-PO-SO-NOTE-'+id;
    const header={id,tranid:ref,trandate:'2099-01-01',vendor_id:8899331,vendor:'TEST note vendor',status:'B',
      status_text:'Pending Receipt',memo:'Pickering Yard - Unilock',netsuite_note:'for SOB121819',
      destination_location_id:1,destination_location:'3445',foreigntotal:953.52};
    await upsertPurchaseOrders([header]);
    await query("UPDATE purchase_orders SET dispatch_instructions='Mon-Fri',dispatch_ref=$2 WHERE netsuite_id=$1",[id,ref+'-PACK']);
    assert.equal((await getNetSuiteMirrorOrderSnapshot('purchase_order',id)).header.netsuite_note,'for SOB121819');
    await upsertScmPurchaseOrderCatalog({orders:[{id:ref+'-PACK',type:'PO',originalPoRef:ref,notes:'Cached Note',instructions:'Mon-Fri',
      scm:{method:'MBT',status:'Hold',notes:''},items:[]}],source:'so-note-test'});
    let order=await getScmPurchaseOrderCatalogOrder(ref+'-PACK');
    assert.equal(order.scm.remark,'Pickering Yard - Unilock');
    assert.equal(order.notes,'for SOB121819');
    assert.equal(order.scm.notes,'for SOB121819');
    assert.equal(order.instructions,'Mon-Fri');
    const html=specialPoRoutingHtml({purchaseOrderId:id,purchaseOrderRef:ref},{ref,order});
    assert.match(html,/data-scm-field="notes"[^>]*>for SOB121819<\/textarea>/);
    assert.equal((await listScmSchedule({exactRef:ref+'-PACK'}))[0].notes,'for SOB121819');
    await updateScmScheduleEntry({orderKind:'PO',orderRef:ref+'-PACK',patch:{notes:'SCM pickup note'},expectedUpdatedAt:null});
    order=await getScmPurchaseOrderCatalogOrder(ref+'-PACK');
    assert.equal(order.scm.notes,'SCM pickup note');
    await updateScmScheduleEntry({orderKind:'PO',orderRef:ref+'-PACK',patch:{notes:''},expectedUpdatedAt:order.scm.updatedAt});
    assert.equal((await getScmPurchaseOrderCatalogOrder(ref+'-PACK')).scm.notes,'for SOB121819');
    const {netsuite_note,...partial}=header;
    assert.equal(netsuite_note,'for SOB121819');
    await upsertPurchaseOrders([partial]);
    assert.equal((await getNetSuiteMirrorOrderSnapshot('purchase_order',id)).header.netsuite_note,'for SOB121819');
    await upsertPurchaseOrders([{...header,netsuite_note:'for SOB121820'}]);
    assert.equal((await getScmPurchaseOrderCatalogOrder(ref+'-PACK')).scm.notes,'for SOB121820');
    await upsertPurchaseOrders([{...header,netsuite_note:''}]);
    assert.equal((await getScmPurchaseOrderCatalogOrder(ref+'-PACK')).scm.notes,'');
    assert.equal((await getNetSuiteMirrorOrderSnapshot('purchase_order',id)).header.netsuite_note,'');
    const stored=(await query('SELECT memo,foreign_total,destination_location_id FROM purchase_orders WHERE netsuite_id=$1',[id])).rows[0];
    assert.deepEqual(stored,{memo:header.memo,foreign_total:'953.52',destination_location_id:'1'});
  });} finally {await rollback.rollback();}
});
