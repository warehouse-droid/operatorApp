/* global structuredClone */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { beginRollbackContext, closeDb, query } from '../../../src/db.js';
import * as repo from '../../../src/special-stock-request-repository.js';
import { createSpecialStockRequestService } from '../../../src/special-stock-request-service.js';
import { synchronizeSpecialDescriptions } from '../../../src/special-stock-netsuite-adapter.js';
import { findLinkedSpecialPurchaseOrder, finalizeLinkedSpecialPurchaseOrder } from '../../../src/special-stock-native-po-adapter.js';
import { createSpecialQuantityService } from '../../../src/special-stock-quantity-service.js';
import { prepareSpecialQuantityPlan, applySpecialQuantityPlan } from '../../../src/special-stock-quantity-adapter.js';
import { prepareSpecialAdjustmentPlan,applySpecialAdjustmentPlan } from '../../../src/special-stock-adjustment-adapter.js';
import { createSpecialOrderDocumentService } from '../../../src/special-stock-documents.js';

after(closeDb);
const context = { operatorId: 'special-description-race', authorizedStoreLocationIds: [1] };
const soId = 8899801, poId = 8899802;
const operationId = '01911111-1111-7111-8111-111111111132';

test('discount and pallet adjustment survives an early webhook and lost SO response before committing locally',()=>fixture(async(d,review)=>{
  review[0].description='Original';
  d=await repo.prepareSpecialPurchaseOrder(d.id,{ vendorDiscountAmount: 0,expectedRevision:d.revision,lines:review},context);
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,vendor_id,destination_location_id,status_text,netsuite_active) VALUES($1,'TEST-RACE-PO',8899200,1,'Pending Receipt',true)",[poId]);
  await query("INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,item_description,quantity,unit,netsuite_active) VALUES($1,90201,2055,'MBBS-Special Order','Original',500,'PC',true)",[poId]);
  d=await repo.linkSpecialPurchaseOrder(d.id,{expectedRevision:d.revision,purchaseOrderId:poId,purchaseOrderRef:'TEST-RACE-PO'},context);
  const remoteLine=(remoteLineId,itemId,quantity,rate)=>({remoteLineId,itemId,quantity,rate:String(rate),unitId:itemId===1784?246:865,
    description:itemId===1784?'PALLET':'Original',locationId:1,taxCode:'13',createdPoId:null,createPo:''});
  const remote=new Map([[soId,{header:{entity:1},lines:[remoteLine(90101,2055,500,17),remoteLine(90102,1784,11,40)]}],
    [poId,{header:{entity:2},lines:[remoteLine(90201,2055,500,5)]}]]);
  const patches=[];
  const boundary={snapshot:async order=>structuredClone(remote.get(order.id)),apply:async order=>{
    patches.push(order.kind);const target=structuredClone(order.target);target.lines.forEach(line=>{line.remoteLineId??=90103;});remote.set(order.id,target);
    for(const line of target.lines){
      if(line.itemId===10716)await query("INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,item_description,quantity,unit,netsuite_active,item_type) VALUES($1,$2,10716,'Custom Discount%','',0,NULL,true,'Discount') ON CONFLICT(sales_order_id,line_id) DO NOTHING",[order.id,line.remoteLineId]);
      else await query(`UPDATE ${order.kind}_lines SET quantity=$3 WHERE ${order.kind}_id=$1 AND line_id=$2`,[order.id,line.remoteLineId,line.quantity]);
    }
    assert.equal((await repo.reconcileSpecialOrderWebhook({orderKind:order.kind,orderId:order.id})).attention,false);
    if(patches.length===1)throw Error('Lost adjustment response');
  }};
  const service=createSpecialQuantityService({resolveOrderUnits:async lines=>lines.map(line=>({...line,unitId:line.itemId===1784?246:865})),
    prepareAdjustmentPlan:input=>prepareSpecialAdjustmentPlan(input,boundary),applyAdjustmentPlan:plan=>applySpecialAdjustmentPlan(plan,boundary)});
  d=await repo.requestSpecialQuantityChange(d.id,{expectedRevision:d.revision,palletTotal:12,lines:[{caseLineId:d.lines[0].id,quantity:50,discountPercent:10}]},context);
  const confirm=()=>service.reviewQuantityChange(d.id,{expectedRevision:d.revision,reviewId:d.quantityReview.id,decision:'approve'},context);
  await assert.rejects(confirm(),/Lost adjustment response/);d=await repo.getSpecialStockCase(d.id);
  assert.equal(d.lines[0].discountPercent,0);assert.equal(d.palletTotal,11);assert.equal(d.quantityReview.status,'attention');
  await query('UPDATE sales_order_lines SET quantity=99 WHERE sales_order_id=$1 AND line_id=90102',[soId]);
  assert.equal((await repo.reconcileSpecialOrderWebhook({orderKind:'sales_order',orderId:soId})).attention,true,'Unreviewed pallet quantities are not an authorized transition');
  await query('UPDATE sales_order_lines SET quantity=12 WHERE sales_order_id=$1 AND line_id=90102',[soId]);
  d=await repo.getSpecialStockCase(d.id);
  d=await repo.claimSpecialQuantityReview(d.id,{expectedRevision:d.revision,reviewId:d.quantityReview.id},context);
  await assert.rejects(()=>repo.finishSpecialQuantityReview(d.id,{reviewId:d.quantityReview.id,verifiedOrderIds:[soId,poId]},context),{code:'SPECIAL_QUANTITY_NOT_VERIFIED'});
  d=await repo.getSpecialStockCase(d.id);assert.equal(d.lines[0].discountPercent,0);assert.equal(d.palletTotal,11);
  d=await confirm();assert.equal(d.quantityReview.status,'approved');assert.equal(d.attention,false);
  assert.equal(d.salesOrderLines[0].quantity,50);assert.equal(d.salesOrderLines[0].rate,17);assert.equal(d.salesOrderLines[0].nativeDiscountPercent,10);
  assert.equal(d.lines[0].discountPercent,10);assert.equal(d.palletTotal,12);assert.equal(d.salesOrderLines.find(line=>line.itemId===1784).quantity,12);
  assert.equal(d.purchaseOrderLines[0].quantity,50);assert.equal(d.purchaseOrderLines[0].unitPurchaseCost,5);
  assert.deepEqual(patches,['sales_order','purchase_order']);
  assert.equal((await repo.reconcileSpecialOrderWebhook({orderKind:'sales_order',orderId:soId})).attention,false);
  await query('UPDATE sales_order_lines SET netsuite_active=false WHERE sales_order_id=$1 AND item_id=10716',[soId]);
  assert.equal((await repo.reconcileSpecialOrderWebhook({orderKind:'sales_order',orderId:soId})).attention,false,'Discount rows are independent from canonical material coverage');
  await query("INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,quantity,netsuite_active,item_type) VALUES($1,90110,-2,'Subtotal',0,true,NULL),($1,90111,2022,'10% discount',0,true,'Discount')",[soId]);
  await query("INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,quantity,netsuite_active,item_type) VALUES($1,90210,2023,'Independent vendor discount',0,true,'Discount')",[poId]);
  assert.equal((await repo.reconcileSpecialOrderWebhook({orderKind:'sales_order',orderId:soId})).attention,false,'Alternate discount items and subtotal rows are not material coverage');
  assert.equal((await repo.reconcileSpecialOrderWebhook({orderKind:'purchase_order',orderId:poId})).attention,false,'PO discount identity and count may differ from SO');
  await query("INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,quantity,unit,netsuite_active,item_type) VALUES($1,90211,9999,'Unreviewed material',1,'PC',true,'InvtPart')",[poId]);
  assert.equal((await repo.reconcileSpecialOrderWebhook({orderKind:'purchase_order',orderId:poId})).attention,true,'Unreviewed materials still block reconciliation');
}));

for (const loseResponse of [false, true]) {
  test(`issued quantity confirmation tolerates exact SO/PO webhook transitions${loseResponse ? ' across recovery' : ''}`, () => fixture(async (d, review) => {
    review[0].description = 'Original';
    d = await repo.prepareSpecialPurchaseOrder(d.id, { vendorDiscountAmount: 0, expectedRevision: d.revision, lines: review }, context);
    await query("INSERT INTO purchase_orders(netsuite_id,tranid,vendor_id,destination_location_id,status_text,netsuite_active) VALUES($1,'TEST-RACE-PO',8899200,1,'Pending Receipt',true)", [poId]);
    await query("INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,item_description,quantity,unit,netsuite_active) VALUES($1,90201,2055,'MBBS-Special Order','Original',500,'PC',true)", [poId]);
    d = await repo.linkSpecialPurchaseOrder(d.id, { expectedRevision: d.revision, purchaseOrderId: poId, purchaseOrderRef: 'TEST-RACE-PO' }, context);
    d = await repo.requestSpecialQuantityChange(d.id, { expectedRevision: d.revision, lines: [{ caseLineId: d.lines[0].id, quantity: 50 }] }, context);
    const remote = {
      sales_order: [{ line: 1, item: { id: '2055' }, units: '865', quantity: 500, rate: 17, description: 'Original' },
        { line: 2, item: { id: '1784' }, units: '246', quantity: 11, rate: 40, description: 'PALLET' }],
      purchase_order: [{ line: 1, item: { id: '2055' }, units: '865', quantity: 500, rate: 5, description: 'Original' }]
    };
    const patches = [];
    const boundary = {
      queryAll: async sql => [{ uniquekey: sql.includes(String(soId)) ? 90101 : 90201, rest_line_id: 1, item: 2055,
        execution_quantity: 0, billed_quantity: 0, line_closed: 'F', status_text: 'Pending Fulfillment' }],
      rest: async (path, options = {}) => {
        const kind = path.includes('/salesOrder/') ? 'sales_order' : 'purchase_order', orderId = kind === 'sales_order' ? soId : poId;
        if (options.method === 'PATCH') {
          patches.push(kind);
          for (const patch of options.body.item.items) Object.assign(remote[kind].find(l => l.line === patch.line), patch);
          await query(`UPDATE ${kind}_lines SET quantity=50 WHERE ${kind}_id=$1 AND item_id=2055`, [orderId]);
          assert.equal((await repo.reconcileSpecialOrderWebhook({ orderKind: kind, orderId })).attention, false, 'A confirmed target is an expected transition');
          const during = await repo.getSpecialStockCase(d.id);
          assert.equal(during.quantityReviewPending, true);
          assert.notEqual(during.handoff?.status, 'ready');
          if (loseResponse && patches.length === 1) throw Error('Response lost after SO update');
        }
        return { data: { item: { items: structuredClone(remote[kind]) } } };
      }
    };
    const service = createSpecialQuantityService({
      resolveOrderUnits: async lines => lines.map(l => ({ ...l, unitId: l.itemId === 2055 ? 865 : 246 })),
      preparePlan: input => prepareSpecialQuantityPlan(input, boundary), applyPlan: plan => applySpecialQuantityPlan(plan, boundary)
    });
    const confirm = () => service.reviewQuantityChange(d.id, { expectedRevision: d.revision, reviewId: d.quantityReview.id, decision: 'approve' }, context);
    if (loseResponse) {
      await assert.rejects(confirm(), /Response lost/);
      d = await repo.getSpecialStockCase(d.id);
      assert.equal(d.quantityReview.status, 'attention');
      assert.equal((await repo.reconcileSpecialOrderWebhook({ orderKind: 'sales_order', orderId: soId })).attention, false);
      d = await repo.getSpecialStockCase(d.id);
    }
    const completed = await confirm();
    assert.equal(completed.quantityReview.status, 'approved');
    assert.equal(completed.attention, false);
    assert.deepEqual(patches, ['sales_order', 'purchase_order']);
    assert.deepEqual(completed.salesOrderLines.map(l => [l.quantity, l.rate]), [[50,17],[11,40]]);
    assert.equal(completed.purchaseOrderLines[0].quantity, 50);
    assert.equal(completed.purchaseOrderLines[0].unitPurchaseCost, 5);
    assert.equal((await query("SELECT id FROM sales_special_stock_events WHERE request_id=$1 AND event_type='special_order_line_reconciliation_attention'", [d.id])).rowCount, 0);
    await query('UPDATE sales_order_lines SET quantity=500 WHERE sales_order_id=$1 AND item_id=2055', [soId]);
    assert.equal((await repo.reconcileSpecialOrderWebhook({ orderKind: 'sales_order', orderId: soId })).attention, true, 'Completed reviews must reject an old quantity');
  }));
}
async function fixture(run) {
  const rollback = await beginRollbackContext();
  try { await rollback.run(async () => {
    await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids) VALUES($1,$1,'TEST','hash','salt','admin',ARRAY['admin'],ARRAY[1]) ON CONFLICT DO NOTHING", [context.operatorId]);
    await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(2055,'MBBS-Special Order','PC','{}',now()),(1784,'PALLET','EACH','{}',now()) ON CONFLICT DO NOTHING");
    await query("INSERT INTO netsuite_customers(netsuite_id,entity_number,legal_name,display_name,currency,active,source_modified_at,source_version,payload_hash) VALUES(8899100,'TEST','TEST','TEST','CAD',true,now(),'test',repeat('d',64)) ON CONFLICT DO NOTHING");
    let d = await repo.createSpecialStockCase({ storeLocationId: 1, inquiryDate: '2099-01-01', customerId: 8899100,
      customerName: 'TEST', vendorId: 8899200, vendorName: 'TEST', fulfillmentMethod: 'yard_pickup',
      lines: [{ productName: 'Original', quantity: 500, uom: 'Pcs', rate: 17, requiredDate: '2099-02-01' }] }, context);
    d = await repo.respondSpecialStockLine(d.id, d.lines[0].id, { expectedRevision: d.revision, supplyStatus: 'in_stock',
      availableDate: '2099-01-20', availabilityMode: 'dated', vendorId: 8899200, vendorName: 'TEST', vendorYard: 'TEST' }, context);
    d = await repo.decideSpecialStockLine(d.id, d.lines[0].id, { expectedRevision: d.revision, decision: 'accepted' }, context);
    d = await repo.saveSpecialSalesOrderDraft(d.id, { expectedRevision: d.revision, customerId: 8899100,
      operationalYardLocationId: 1, fulfillmentMethod: 'yard_pickup', palletTotal: 11, palletRate: 40,
      materialLines: [{ caseLineId: d.lines[0].id, itemId: 2055, description: 'Original', quantity: 500, packageQuantity: 500, conversionToPc: 1, uom: 'PC', rate: 17 }] }, context);
    await query("INSERT INTO sales_orders(netsuite_id,tranid,customer_id,order_location_id,order_location,outbound_location_id,outbound_location,status_text,netsuite_active,sales_order_type,delivery_method_id,trandate) VALUES($1,'TEST-RACE-SO',8899100,1,'3445',1,'3445','Pending Fulfillment',true,'Customer Pickup',1,current_date)", [soId]);
    await query("INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,item_description,quantity,unit,netsuite_active) VALUES($1,90101,2055,'MBBS-Special Order','Original',500,'PC',true),($1,90102,1784,'PALLET','PALLET',11,'EACH',true)", [soId]);
    d = await repo.linkSpecialSalesOrder(d.id, { expectedRevision: d.revision, source: 'standalone', salesOrderId: soId, salesOrderRef: 'TEST-RACE-SO' }, context);
    const review = [{ caseLineId: d.lines[0].id, description: 'SCM reviewed', quantity: 500, uom: 'PC', vendorDiscountPercent:0,unitPurchaseCost: 5 }];
    await run(d, review);
  }); } finally { await rollback.rollback(); }
}

test('document cache retains a valid PDF on rendering failure and checks authorization before a hit', () => fixture(async d => {
  let renders = 0, fail = false;
  const documents = createSpecialOrderDocumentService({
    fetchPdf: async (kind, id) => { assert.equal(kind, 'sales_order'); assert.equal(id, soId); renders++;
      return { buffer: fail ? Buffer.from('invalid') : Buffer.from(`%PDF-NETSUITE-${renders}`), filename: 'Native-SO.pdf' }; } });
  const options = { audience: 'sales', authorizedStoreLocationIds: [1] };
  await query(`INSERT INTO sales_special_stock_document_cache(request_id,order_kind,audience,snapshot_hash,filename,pdf)
    VALUES($1,'sales_order','sales',$2,'Legacy-local.pdf',$3)`, [d.id,'0'.repeat(64),Buffer.from('%PDF-LEGACY-LOCAL')]);
  const first = await documents.preview(d.id, 'sales_order', options);
  assert.equal(first.cached, false); assert.deepEqual(first.buffer, Buffer.from('%PDF-NETSUITE-1'));
  const repeat = await documents.preview(d.id, 'sales_order', options);
  assert.equal(repeat.cached, true); assert.deepEqual(repeat.buffer, first.buffer); assert.equal(renders, 1);
  await assert.rejects(documents.preview(d.id, 'sales_order', { audience: 'sales', authorizedStoreLocationIds: [28] }), { code: 'SPECIAL_CASE_STORE_FORBIDDEN' });
  assert.equal(renders, 1);
  await query("UPDATE sales_special_stock_order_lines SET description='Revised locally' WHERE request_id=$1 AND order_kind='sales_order' AND NOT ancillary", [d.id]);
  fail = true;
  await assert.rejects(documents.preview(d.id, 'sales_order', options), { status: 502 });
  assert.deepEqual((await query('SELECT pdf FROM sales_special_stock_document_cache WHERE request_id=$1', [d.id])).rows[0].pdf, first.buffer);
  fail = false;
  const updated = await documents.preview(d.id, 'sales_order', options);
  assert.equal(updated.cached, false); assert.notDeepEqual(updated.buffer, first.buffer);
}));

test('SCM PO creation survives SO webhooks after PATCH, before submission and before final linking', () => fixture(async (d, review) => {
  const remote = [
    { line: 1, item: { id: '2055' }, units: '865', quantity: 500, rate: 17, description: 'Original' },
    { line: 2, item: { id: '1784' }, units: '246', quantity: 11, rate: 40, description: 'PALLET' }
  ];
  let posts = 0, patches = 0;
  const webhook = async () => {
    const result = await repo.reconcileSpecialOrderWebhook({ orderKind: 'sales_order', orderId: soId });
    assert.equal(result.attention, false, 'The exact SCM description is an expected transition');
  };
  const service = createSpecialStockRequestService({ assertPurchaseOrderReady: async () => {}, selectSalesRep: async () => ({ id: 123, name: 'TEST NetSuite Rep' }),
    findLinkedPurchaseOrder: async () => null,
    resolveOrderUnits: async lines => lines.map(l => ({ ...l, unitId: l.itemId === 2055 ? 865 : 246 })),
    synchronizeSalesDescriptions: input => synchronizeSpecialDescriptions(input, {
      queryAll: async () => [{ uniquekey: 90101, rest_line_id: 1, item: 2055 }],
      rest: async (_path, options = {}) => {
        if (options.method === 'PATCH') {
          patches++;
          for (const patch of options.body.item.items) Object.assign(remote.find(l => l.line === patch.line), patch);
          await query("UPDATE sales_order_lines SET item_description='SCM reviewed' WHERE sales_order_id=$1 AND line_id=90101", [soId]);
          await webhook();
        }
        return { data: { item: { items: structuredClone(remote) } } };
      }
    }),
    resolveLocations: async () => { await webhook(); return [{ netsuiteLocationId: 1 }]; },
    findMarkerOrders: async () => [],
    createPurchaseOrder: async payload => {
      posts++;
      assert.equal(remote[0].description, 'SCM reviewed');
      assert.equal((await repo.getSpecialStockCase(d.id)).salesOrderLines[0].description, 'SCM reviewed');
      assert.equal(payload.item.items[0].description, 'SCM reviewed');
      await query("INSERT INTO purchase_orders(netsuite_id,tranid,vendor_id,destination_location_id,status_text,netsuite_active) VALUES($1,'TEST-RACE-PO',8899200,1,'Pending Receipt',true)", [poId]);
      await query("INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,item_description,quantity,unit,netsuite_active) VALUES($1,90201,2055,'MBBS-Special Order','SCM reviewed',500,'PC',true)", [poId]);
      await webhook();
      return { id: poId };
    },
    fetchPurchaseOrderReference: async () => ({ tranid: 'TEST-RACE-PO', status_text: 'Pending Receipt' }),
    sleep: async () => {}
  });
  const linked = await service.createPurchaseOrder(d.id, { vendorDiscountAmount: 0, expectedRevision: d.revision, operationId, lines: review }, context);
  assert.equal(linked.purchaseOrderId, poId);
  assert.equal(linked.purchaseOrderOperationStatus, 'linked');
  assert.equal(linked.attention, false);
  assert.equal(posts, 1); assert.equal(patches, 1);
  assert.deepEqual(remote.map(l => [l.quantity, l.units, l.rate]), [[500, '865', 17], [11, '246', 40]]);
  assert.equal(remote[1].description, 'PALLET');
  const warnings = await query("SELECT id FROM sales_special_stock_events WHERE request_id=$1 AND event_type='special_order_line_reconciliation_attention'", [d.id]);
  assert.equal(warnings.rowCount, 0);
}));

test('webhook revision changes do not grant another operation ownership or allow a future revision', () => fixture(async (d, review) => {
  d = await repo.prepareSpecialPurchaseOrder(d.id, { vendorDiscountAmount: 0, expectedRevision: d.revision, lines: review }, context);
  const owned = await repo.claimSpecialOrderOperation(d.id, { expectedRevision: d.revision, orderKind: 'purchase_order', operationId }, context);
  await repo.reconcileSpecialOrderWebhook({ orderKind: 'sales_order', orderId: soId });
  await assert.rejects(repo.recordSpecialSalesDescriptionsSynced(d.id, { expectedRevision: owned.revision, operationId: '01911111-1111-7111-8111-111111111199', changes: [] }, context), { code: 'SPECIAL_REMOTE_OPERATION_BUSY' });
  await assert.rejects(repo.markSpecialOrderSubmitted(d.id, { expectedRevision: owned.revision + 100, orderKind: 'purchase_order', operationId }, context), { code: 'SPECIAL_REVISION_CONFLICT' });
  const submitted = await repo.markSpecialOrderSubmitted(d.id, { expectedRevision: owned.revision, orderKind: 'purchase_order', operationId }, context);
  assert.ok(submitted.purchaseOrderSubmissionStartedAt);
  await assert.rejects(repo.markSpecialOrderSubmitted(d.id, { expectedRevision: submitted.revision, orderKind: 'purchase_order', operationId }, context), { code: 'SPECIAL_REMOTE_OUTCOME_UNCERTAIN' });
}));

test('loss of SO approval during the claimed operation blocks PO submission', () => fixture(async (d, review) => {
  d = await repo.prepareSpecialPurchaseOrder(d.id, { vendorDiscountAmount: 0, expectedRevision: d.revision, lines: review }, context);
  const owned = await repo.claimSpecialOrderOperation(d.id, { expectedRevision: d.revision, orderKind: 'purchase_order', operationId }, context);
  await query("UPDATE sales_orders SET status_text='Closed' WHERE netsuite_id=$1", [soId]);
  await repo.reconcileSpecialOrderWebhook({ orderKind: 'sales_order', orderId: soId });
  await assert.rejects(repo.markSpecialOrderSubmitted(d.id, { expectedRevision: owned.revision, orderKind: 'purchase_order', operationId }, context), { code: 'SPECIAL_PO_SO_NOT_APPROVED' });
  assert.equal((await repo.getSpecialStockCase(d.id)).purchaseOrderSubmissionStartedAt, null);
}));

for (const [name, sql, expected] of [
  ['case closes', "UPDATE sales_special_stock_cases SET close_status='closed' WHERE request_id=$1", 'SPECIAL_CASE_CLOSED'],
  ['SO becomes planned', 'UPDATE sales_orders SET dispatch_planned=true WHERE netsuite_id=$1', 'SPECIAL_PO_SO_ALREADY_PLANNED'],
  ['SO quantity changes', 'UPDATE sales_order_lines SET quantity=501 WHERE sales_order_id=$1 AND line_id=90101', 'SPECIAL_ORDER_COVERAGE_MISMATCH'],
  ['SO UOM changes', "UPDATE sales_order_lines SET unit='SQFT' WHERE sales_order_id=$1 AND line_id=90101", 'SPECIAL_ORDER_COVERAGE_MISMATCH'],
  ['SO description is unreviewed', "UPDATE sales_order_lines SET item_description='Unreviewed' WHERE sales_order_id=$1 AND line_id=90101", 'SPECIAL_ORDER_COVERAGE_MISMATCH']
]) {
  test(`owned PO submission still blocks when ${name}`, () => fixture(async (d, review) => {
    d = await repo.prepareSpecialPurchaseOrder(d.id, { vendorDiscountAmount: 0, expectedRevision: d.revision, lines: review }, context);
    const owned = await repo.claimSpecialOrderOperation(d.id, { expectedRevision: d.revision, orderKind: 'purchase_order', operationId }, context);
    await query(sql, [name === 'case closes' ? d.id : soId]);
    if (name !== 'case closes') await repo.reconcileSpecialOrderWebhook({ orderKind: 'sales_order', orderId: soId });
    await assert.rejects(repo.markSpecialOrderSubmitted(d.id, { expectedRevision: owned.revision, orderKind: 'purchase_order', operationId }, context), { code: expected });
    assert.equal((await repo.getSpecialStockCase(d.id)).purchaseOrderSubmissionStartedAt, null);
  }));
}

test('a stopped owner cannot finalize, and description recording cannot conceal a changed commercial line', () => fixture(async (d, review) => {
  d = await repo.prepareSpecialPurchaseOrder(d.id, { vendorDiscountAmount: 0, expectedRevision: d.revision, lines: review }, context);
  const owned = await repo.claimSpecialOrderOperation(d.id, { expectedRevision: d.revision, orderKind: 'purchase_order', operationId }, context);
  const material = owned.salesOrderLines.find(l => !l.ancillary);
  for (const patch of [{ quantity: 501 }, { uom: 'SQFT' }, { rate: 18 }]) {
    await assert.rejects(repo.recordSpecialSalesDescriptionsSynced(d.id, { expectedRevision: owned.revision, operationId,
      changes: [{ ...material, previousDescription: 'Original', description: 'SCM reviewed', ...patch }] }, context), { code: 'SPECIAL_SO_LINE_CONFLICT' });
  }
  assert.equal((await repo.getSpecialStockCase(d.id)).salesOrderLines[0].description, 'Original');
  await repo.failSpecialOrderOperation(d.id, { orderKind: 'purchase_order', operationId, errorMessage: 'Stopped' }, context);
  await assert.rejects(repo.recordSpecialSalesDescriptionsSynced(d.id, { expectedRevision: owned.revision, operationId, changes: [] }, context), { code: 'SPECIAL_REMOTE_OPERATION_BUSY' });
  await assert.rejects(repo.linkSpecialPurchaseOrder(d.id, { expectedRevision: owned.revision, operationId, purchaseOrderId: poId,
    purchaseOrderRef: 'TEST-RACE-PO', verifiedRemote: true }, context), { code: 'SPECIAL_REMOTE_OPERATION_BUSY' });
}));

for (const [exists, lost] of [[false, false], [true, false], [false, true]]) {
  test(`real SCM workflow corrects SO quantity/UOM before ${exists ? 'updating the existing native PO' : 'creating a standalone PO'} despite webhooks${lost ? ' and a lost creation response' : ''}`,  () => fixture(async (d, review) => {
    review[0] = { ...review[0], quantity: 501, uom: 'EACH' };
    const so = { id: String(soId), orderStatus: { id: 'B' }, item: { items: [
      { line: 1, lineUniqueKey: '90101', item: { id: '2055' }, quantity: 500, units: '865', rate: 17, description: 'Original',
        ...(exists ? { createdPo: { id: String(poId) }, createPo: { id: 'SpecOrd' } } : {}) },
      { line: 2, lineUniqueKey: '90102', item: { id: '1784' }, quantity: 11, units: '246', rate: 40, description: 'PALLET' }
    ] } };
    let po = exists ? { id: String(poId), tranId: 'TEST-RACE-PO', createdFrom: { id: String(soId) }, entity: { id: '8899200' },
      location: { id: '1' }, orderStatus: { id: 'B' }, memo: 'Vendor note', item: { items: [
        { line: 4, item: { id: '2055' }, quantity: 500, units: '865', rate: 4, description: 'Previous' }
      ] } } : null;
    let creates = 0, soCorrections = 0, poUpdates = 0;
    const mirrorPo = async () => {
      await query("INSERT INTO purchase_orders(netsuite_id,tranid,vendor_id,destination_location_id,status_text,netsuite_active) VALUES($1,'TEST-RACE-PO',8899200,1,'Pending Receipt',true)", [poId]);
      await query("INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,item_description,quantity,unit,netsuite_active) VALUES($1,90201,2055,'MBBS-Special Order','SCM reviewed',501,'EACH',true)", [poId]);
      await repo.reconcileSpecialOrderWebhook({ orderKind: 'sales_order', orderId: soId });
    };
    const boundary = {
      queryAll: async sql => sql.includes('NextTransactionLineLink') ? [{ previousline: 1, nextline: 4, linktype: 'SpecOrd' }]
        : [{ uniquekey: 90101, rest_line_id: 1, item: 2055, execution_quantity: 0, billed_quantity: 0, line_closed: 'F' }],
      rest: async (path, options = {}) => {
        const isSo = path.includes('/salesOrder/');
        if (options.method === 'POST') {
          assert.equal(path, '/record/v1/purchaseOrder');assert.equal(exists,false);assert.equal(po,null);
          assert.equal(options.body.createdFrom,undefined);assert.equal(options.body.externalId,`MBBS-SPECIAL-PO:${d.id}`);
          assert.equal(so.item.items[0].quantity,501);assert.equal(so.item.items[0].units,'873');assert.equal(so.item.items[0].description,'SCM reviewed');
          creates++;
          po={...structuredClone(options.body),id:String(poId),tranId:'TEST-RACE-PO',orderStatus:{id:'B'}};
          po.item.items.forEach((line,index)=>{line.line=4+index;});
          await mirrorPo();
          if(lost)throw Error('Standalone creation response lost');
          return {id:poId};
        }
        if (options.method === 'PATCH' && isSo) {
          for (const patch of options.body.item.items) {
            const line = so.item.items.find(l => l.line === patch.line);
            assert.equal(patch.createPo,undefined,'Standalone creation must not set native creation flags');
            Object.assign(line, patch);
            soCorrections++;
          }
          await query('UPDATE sales_order_lines SET item_description=$2,quantity=$3,unit=$4 WHERE sales_order_id=$1 AND line_id=90101',
            [soId, so.item.items[0].description, so.item.items[0].quantity, so.item.items[0].units === '865' ? 'PC' : 'EACH']);
          assert.equal((await repo.reconcileSpecialOrderWebhook({ orderKind: 'sales_order', orderId: soId })).attention, false);
        }
        if (options.method === 'PATCH' && !isSo) {
          poUpdates++;
          assert.equal(so.item.items[0].quantity, 501); assert.equal(so.item.items[0].units, '873');
          if (options.body.memo !== undefined) po.memo = options.body.memo;
          for (const patch of options.body.item?.items || []) Object.assign(po.item.items.find(l => l.line === patch.line), patch);
          await mirrorPo();
        }
        return { data: structuredClone(isSo ? so : po) };
      }
    };
    const service = createSpecialStockRequestService({ assertPurchaseOrderReady: async () => {}, selectSalesRep: async () => ({ id: 123, name: 'TEST NetSuite Rep' }),
      resolveOrderUnits: async ls => ls.map(l => ({ ...l, unitId: l.uom === 'PC' ? 865 : 873 })),
      synchronizeSalesDescriptions: input => synchronizeSpecialDescriptions(input, boundary),
      resolveLocations: async () => [{ netsuiteLocationId: 1 }], findMarkerOrders: async () => po?.memo.includes(`MBBS-SPECIAL-PO:${d.id}`)
        ? [{id:poId,entity_id:8899200,location_id:1,nativeLink:exists}] : [],
      findLinkedPurchaseOrder: input => findLinkedSpecialPurchaseOrder(input, boundary),
      createPurchaseOrder: payload => boundary.rest('/record/v1/purchaseOrder',{method:'POST',body:payload}),
      finalizeLinkedPurchaseOrder: input => finalizeLinkedSpecialPurchaseOrder(input, boundary),
      fetchPurchaseOrderReference: async () => ({ tranid: 'TEST-RACE-PO', status_text: 'Pending Receipt' }), sleep: async () => {}
    });
    const linked = await service.createPurchaseOrder(d.id, { vendorDiscountAmount: 0, expectedRevision: d.revision, operationId, lines: review }, context);
    assert.equal(linked.purchaseOrderId, poId); assert.equal(linked.purchaseOrderOperationStatus, 'linked'); assert.equal(linked.attention, false);
    assert.equal(creates, exists ? 0 : 1); assert.equal(soCorrections, 1); assert.equal(poUpdates, exists ? 1 : 0);
    assert.equal(po.createdFrom?.id,exists?String(soId):undefined);
    assert.equal(so.item.items[0].createdPo?.id,exists?String(poId):undefined);
    assert.deepEqual(linked.salesOrderLines.filter(l => !l.ancillary).map(l => [l.quantity, l.uom, l.rate, l.description]), [[501, 'EACH', 17, 'SCM reviewed']]);
    assert.deepEqual(linked.purchaseOrderLines.map(l => [l.quantity, l.uom, l.unitPurchaseCost, l.description]), [[501, 'EACH', 5, 'SCM reviewed']]);
    assert.deepEqual(so.item.items[1], { line: 2, lineUniqueKey: '90102', item: { id: '1784' }, quantity: 11, units: '246', rate: 40, description: 'PALLET' });
  }));
}

test('a confirmed quantity change preserves gross PO costs, updates the vendor summary and private review, and accepts its webhook',()=>fixture(async(d,review)=>{
  review[0].description='Original';review[0].vendorDiscountPercent=25;
  d=await repo.prepareSpecialPurchaseOrder(d.id,{expectedRevision:d.revision,lines:review},context);
  assert.equal(d.vendorDiscountReview.amount,625);
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,vendor_id,destination_location_id,status_text,netsuite_active) VALUES($1,'TEST-RACE-PO',8899200,1,'Pending Receipt',true)",[poId]);
  await query("INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,item_description,quantity,unit,netsuite_active,item_type) VALUES($1,90201,2055,'MBBS-Special Order','Original',500,'PC',true,'NonInvtPart'),($1,90202,4981,'Discount','Vendor discount',1,NULL,true,'NonInvtPart')",[poId]);
  d=await repo.linkSpecialPurchaseOrder(d.id,{expectedRevision:d.revision,purchaseOrderId:poId,purchaseOrderRef:'TEST-RACE-PO'},context);
  const line=(remoteLineId,itemId,quantity,rate,description='Original')=>({remoteLineId,itemId,quantity,rate:String(rate),unitId:itemId===1784?246:865,
    description,locationId:1,taxCode:'13',createdPoId:null,createPo:''});
  const remote=new Map([[soId,{header:{entity:1},lines:[line(90101,2055,500,17),line(90102,1784,11,40,'PALLET')]}],
    [poId,{header:{entity:2},lines:[line(90201,2055,500,5),line(90202,4981,1,-625,`Vendor discount | MBBS-SPECIAL-PO:${d.id}`)]}]]);
  let writes=0;
  const boundary={snapshot:async o=>structuredClone(remote.get(o.id)),apply:async o=>{
    writes++;remote.set(o.id,structuredClone(o.target));
    await query(`UPDATE ${o.kind}_lines SET quantity=50 WHERE ${o.kind}_id=$1 AND item_id=2055`,[o.id]);
    assert.equal((await repo.reconcileSpecialOrderWebhook({orderKind:o.kind,orderId:o.id})).attention,false);
  }};
  const service=createSpecialQuantityService({resolveOrderUnits:async ls=>ls.map(l=>({...l,unitId:l.itemId===1784?246:865})),
    prepareAdjustmentPlan:input=>prepareSpecialAdjustmentPlan(input,boundary),applyAdjustmentPlan:plan=>applySpecialAdjustmentPlan(plan,boundary)});
  d=await repo.requestSpecialQuantityChange(d.id,{expectedRevision:d.revision,lines:[{caseLineId:d.lines[0].id,quantity:50}]},context);
  d=await service.reviewQuantityChange(d.id,{expectedRevision:d.revision,reviewId:d.quantityReview.id,decision:'approve'},context);
  assert.equal(writes,2);assert.equal(d.purchaseOrderLines[0].unitPurchaseCost,5);
  assert.deepEqual([d.vendorDiscountReview.grossTotal,d.vendorDiscountReview.amount,d.vendorDiscountReview.netTotal],[250,62.5,187.5]);
  assert.equal(d.vendorDiscountReview.lines[0].vendorDiscountPercent,25);
  assert.equal(remote.get(poId).lines[1].rate,'-62.5');
  assert.equal((await repo.reconcileSpecialOrderWebhook({orderKind:'purchase_order',orderId:poId})).attention,false);
}));
