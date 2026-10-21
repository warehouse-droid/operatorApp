import assert from "node:assert/strict";
import test from "node:test";

import { createSpecialStockRequestService } from "../../../src/special-stock-request-service.js";

function caseDetail(overrides = {}) {
  return {
    id: 42,
    revision: 7,
    customerId: 800833,
    vendorId: 3243,
    vendorName: "Techo-Bloc",
    operationalYardLocationId: 15,
    storeName: "12441",
    fulfillmentMethod: "yard_pickup",
    estimateId: null,
    deliveryAddress: "",
    deliveryDate: null,
    windowStart: null,
    windowEnd: null,
    deliveryInstructions: "",
    salesOrderLines: [{ caseLineId: 1, itemId: 2055, quantity: 10, uom: "PC", rate: 4.25, description: "Special" }],
    vendorDiscountReview: { mode: 'per_line', amount: 0, lines: [{caseLineId:1,vendorDiscountPercent:0}] }, purchaseOrderLines: [{ caseLineId: 1, itemId: 2055, quantity: 10, uom: "PC", unitPurchaseCost: 2.1, description: "Special" }],
    ...overrides
  };
}

function harness({ markerRows = [], createResult = { id: 91 }, detail = caseDetail(), overrides = {} } = {}) {
  const calls = [];
  let current = detail;
  const service = createSpecialStockRequestService({ assertPurchaseOrderReady: async () => {}, selectSalesRep: async () => ({ id: 123, name: 'TEST NetSuite Rep' }),
    findLinkedPurchaseOrder: async () => null,
    getCase: async () => current,
    markSubmitted: async () => current,
    resolveOrderUnits: async lines => lines.map(line => ({ ...line, unitId: 1 })),
    claimOperation: async (_id, input) => {
      calls.push(["claim", input]);
      current = { ...current, revision: current.revision + 1, [`${input.orderKind === "sales_order" ? "salesOrder" : "purchaseOrder"}OperationId`]: input.operationId };
      return current;
    },
    linkSalesOrder: async (_id, input) => {
      calls.push(["link-so", input]);
      current = { ...current, revision: current.revision + 1, salesOrderId: input.salesOrderId, salesOrderRef: input.salesOrderRef };
      return current;
    },
    linkPurchaseOrder: async (_id, input) => {
      calls.push(["link-po", input]);
      current = { ...current, revision: current.revision + 1, purchaseOrderId: input.purchaseOrderId, purchaseOrderRef: input.purchaseOrderRef };
      return current;
    },
    failOperation: async (_id, input) => calls.push(["fail", input]),
    resolveLocations: async () => [{ localLocationId: 15, netsuiteLocationId: 10, subsidiaryId: 2 }],
    findMarkerOrders: async () => markerRows,
    createSalesOrder: async (payload) => {
      calls.push(["create-so", payload]);
      return createResult;
    },
    transformEstimate: async (_id, payload) => {
      calls.push(["transform-so", payload]);
      return createResult;
    },
    createPurchaseOrder: async (payload) => {
      calls.push(["create-po", payload]);
      return createResult;
    },
    fetchSalesOrderReference: async (id) => ({ id, tranid: `SO${id}`, status_text: "Pending Fulfillment" }),
    fetchPurchaseOrderReference: async (id) => ({ id, tranid: `PO${id}`, status_text: "Pending Receipt" }),
    recordPurchaseOrderCreation: async (input, operatorId) => calls.push(["record-po-history", input, operatorId]),
    config: { subsidiaryId: "2", deliveryMethodId: "2", pickupMethodId: "1" },
    sleep: async () => {}, ...overrides
  });
  return { service, calls };
}
test('PO creation after a local request adjustment never synchronizes the existing SO',async()=>{
 const detail=caseDetail({salesOrderId:51,salesOrderRef:'SO51',salesOrderApproved:true,localAdjustedAt:'2026-10-13T00:00:00Z',
  purchaseOrderLines:[{caseLineId:1,itemId:2055,description:'Locally adjusted material',quantity:5,uom:'PC',unitPurchaseCost:2.1}]});
 const f=harness({detail,overrides:{synchronizeSalesDescriptions:async()=>assert.fail('Existing SO must stay as created'),
  recordDescriptionSync:async()=>assert.fail('Existing SO snapshot must stay as created')}});
 await f.service.createPurchaseOrder(42,{expectedRevision:7,operationId:'local-adjusted-po'});
 const payload=f.calls.find(([name])=>name==='create-po')[1];
 assert.equal(payload.item.items[0].quantity,5);assert.equal(payload.item.items[0].description,'Locally adjusted material');
 assert.equal(f.calls.filter(([name])=>name==='create-so').length,0);
});

test('all SO creation paths forward the public Note and disable emailing', async () => {
  for (const path of ['standalone', 'estimate_transform', 'discounted']) {
    const remarks = 'TERMS / 条款\n\nCustomer-facing Note';
    const detail = caseDetail({ remarks, salesInternalRemark: 'PRIVATE MARGIN', estimateId: 777 });
    let submitted;
    const capture = async payload => { submitted = payload; return { id: 91 }; };
    if (path === 'discounted') { detail.salesOrderLines[0].nativeDiscountPercent = 5; }
    const f = harness({ detail, overrides: {
      createSalesOrder: capture,
      transformEstimate: async (_id, payload) => capture(payload),
      createDiscountSalesOrder: capture,
      assertDiscountReady: async () => {},
      verifyDiscountSalesOrder: async () => {}
    } });
    await f.service.createSalesOrder(42, { expectedRevision: 7, source: path });
    assert.ok(submitted, path);
    assert.equal(submitted.custbody7, remarks, path);
    assert.equal(submitted.toBeEmailed, false, path);
    assert.equal(JSON.stringify(submitted).includes('PRIVATE MARGIN'), false, path);
    assert.equal(f.calls.filter(([name]) => name === 'link-so').length, 1);
  }
});

test('SO creation and marker recovery use the selected NetSuite account while retaining the original customer',async()=>{
  const detail=caseDetail({netsuiteCustomerId:800999});
  const created=harness({detail});await created.service.createSalesOrder(42,{expectedRevision:7});
  assert.equal(created.calls.find(([name])=>name==='create-so')[1].entity.id,'800999');assert.equal(detail.customerId,800833);
  const recovered=harness({detail,markerRows:[{id:88,entity_id:800999,location_id:10}]});
  assert.equal((await recovered.service.createSalesOrder(42,{expectedRevision:7})).salesOrderId,88);
  assert.equal(recovered.calls.some(([name])=>name==='create-so'),false);
});

test('discounted SO creation checks readiness before submission and links its number without content verification',async()=>{
  const detail=caseDetail();detail.salesOrderLines[0].nativeDiscountPercent=12.5;
  const actions=[];
  const f=harness({detail,overrides:{assertDiscountReady:async()=>actions.push('ready'),
    markSubmitted:async()=>{actions.push('submitted');return detail;},
    createDiscountSalesOrder:async payload=>{actions.push('create');assert.equal(payload.item.items[0].rate,4.25);assert.equal(payload.item.items[1].rate,-5.31);return {id:91};},
    verifyDiscountSalesOrder:async()=>assert.fail('SO creation must not verify content after submission')}});
  await f.service.createSalesOrder(42,{expectedRevision:7,operationId:'discount-test'});
  assert.deepEqual(actions,['ready','submitted','create']);assert.equal(f.calls.filter(([name])=>name==='link-so').length,1);
  const blocked=harness({detail,overrides:{assertDiscountReady:async()=>{throw Error('Discount item unavailable');},markSubmitted:async()=>{throw Error('Must not submit');}}});
  await assert.rejects(()=>blocked.service.createSalesOrder(42,{expectedRevision:7}),/Discount item unavailable/);
  assert.equal(blocked.calls.some(([name])=>name==='create-so'||name==='link-so'),false);
});
test('a recovered discounted SO links by identity and still requires its NetSuite number',async()=>{
  const detail=caseDetail();detail.salesOrderLines[0].nativeDiscountPercent=10;
  const f=harness({detail,markerRows:[{id:88,entity_id:800833,location_id:10}],overrides:{verifyDiscountSalesOrder:async()=>{throw Error('Discount differs');}}});
  const linked=await f.service.createSalesOrder(42,{expectedRevision:7});
  assert.equal(linked.salesOrderId,88);
  assert.equal(f.calls.filter(([name])=>name==='link-so').length,1);
  assert.equal(f.calls.some(([name])=>name==='create-so'),false);
  const missing=harness({detail,markerRows:[{id:88,entity_id:800833,location_id:10}],overrides:{fetchSalesOrderReference:async()=>null}});
  await assert.rejects(()=>missing.service.createSalesOrder(42,{expectedRevision:7}),{code:'SPECIAL_REMOTE_HYDRATION_FAILED'});
});

test("SO execution recovers marker before create and never submits a duplicate", async () => {
  const { service, calls } = harness({ markerRows: [{ id: 88, tranid: "SO88", entity_id: 800833, location_id: 10 }] });
  const result = await service.createSalesOrder(42, { expectedRevision: 7, operationId: "01911111-1111-7111-8111-111111111111", source: "standalone" }, { operatorId: "sales" });
  assert.equal(result.salesOrderId, 88);
  assert.equal(calls.some(([name]) => name === "create-so"), false);
  assert.equal(calls.filter(([name]) => name === "link-so").length, 1);
});

test("standalone and estimate SO paths share exact payload but use different remote operations", async () => {
  const standalone = harness();
  await standalone.service.createSalesOrder(42, { expectedRevision: 7, operationId: "01911111-1111-7111-8111-111111111112", source: "standalone" }, { operatorId: "sales" });
  assert.equal(standalone.calls.filter(([name]) => name === "create-so").length, 1);

  const transformed = harness({ detail: caseDetail({ estimateId: 777 }) });
  await transformed.service.createSalesOrder(42, { expectedRevision: 7, operationId: "01911111-1111-7111-8111-111111111113", source: "estimate_transform" }, { operatorId: "sales" });
  assert.equal(transformed.calls.filter(([name]) => name === "transform-so").length, 1);
  assert.equal(transformed.calls.filter(([name]) => name === "create-so").length, 0);
});

test('PO creation forwards the public Note with the SO reference and disables emailing', async () => {
  const remarks = 'PUBLIC supplier instructions / 条款\nKeep all pallets together.';
  const { service, calls } = harness({ detail: caseDetail({
    salesOrderId: 80, salesOrderRef: 'SOTEST80', salesOrderApproved: true,
    remarks, salesInternalRemark: 'PRIVATE MARGIN'
  }) });
  await service.createPurchaseOrder(42, { expectedRevision: 7 });
  const payload = calls.find(([name]) => name === 'create-po')[1];
  assert.equal(payload.toBeEmailed, false);
  assert.equal(payload.custbody7, `for SOTEST80\n\n${remarks}`);
  assert.equal(JSON.stringify(payload).includes('PRIVATE MARGIN'), false);
});

test("PO executes only after approved SO and uses purchase costs", async () => {
  const { service, calls } = harness({ detail: caseDetail({ salesOrderId: 80, salesOrderApproved: true }) });
  const result = await service.createPurchaseOrder(42, { expectedRevision: 7, operationId: "01911111-1111-7111-8111-111111111114" }, { operatorId: "scm" });
  assert.equal(result.purchaseOrderId, 91);
  const payload = calls.find(([name]) => name === "create-po")[1];
  assert.equal(payload.item.items[0].rate, 2.1);
  const history = calls.find(([name]) => name === "record-po-history");
  assert.equal(history[1].creationSnapshot.requestId, 42);
  assert.equal(history[2], "scm");
});

test('missing vendor discount confirmation prevents a new PO claim or remote submission', async () => {
  const { service, calls } = harness({ detail: caseDetail({ salesOrderId: 80, salesOrderApproved: true, vendorDiscountReview: {} }) });
  await assert.rejects(service.createPurchaseOrder(42, { expectedRevision: 7 }), { code: 'SPECIAL_VENDOR_DISCOUNT_REQUIRED' });
  assert.deepEqual(calls, []);
});

test("uncertain remote result is marked attention and is never blindly resubmitted in the same call", async () => {
  const { service, calls } = harness({ createResult: {} });
  await assert.rejects(
    () => service.createSalesOrder(42, { expectedRevision: 7, operationId: "01911111-1111-7111-8111-111111111115", source: "standalone" }, { operatorId: "sales" }),
    (error) => error?.code === "SPECIAL_REMOTE_OUTCOME_UNCERTAIN"
  );
  assert.equal(calls.filter(([name]) => name === "create-so").length, 1);
  assert.equal(calls.filter(([name]) => name === "fail").length, 1);
});

for (const orderKind of ['sales_order', 'purchase_order']) {
  const sales = orderKind === 'sales_order';
  test(`${orderKind} confirmed NetSuite rejection releases the request for a fresh retry`, async () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const rejected = Object.assign(new Error('Please specify an email address to send to.'), {
        status, netsuiteResponseReceived: true, netsuiteErrorCodes: ['USER_ERROR']
      });
      const { service, calls } = harness({ detail: caseDetail({ salesOrderId: sales ? null : 80, salesOrderApproved: true }),
        overrides: { [sales ? 'createSalesOrder' : 'createPurchaseOrder']: async () => { throw rejected; } } });
      await assert.rejects(service[sales ? 'createSalesOrder' : 'createPurchaseOrder'](42, {
        expectedRevision: 7, operationId: '01911111-1111-7111-8111-111111111180'
      }), error => error.code === 'SPECIAL_REMOTE_REJECTED' && /unlocked/i.test(error.message));
      const failure = calls.find(([name]) => name === 'fail')[1];
      assert.equal(failure.errorCode, 'SPECIAL_REMOTE_REJECTED');
    }
  });

  test(`${orderKind} failure before submission can release its claim`, async () => {
    const { service, calls } = harness({ detail: caseDetail({ salesOrderId: sales ? null : 80, salesOrderApproved: true }),
      overrides: { resolveLocations: async () => { throw new Error('Location mapping unavailable'); } } });
    await assert.rejects(service[sales ? 'createSalesOrder' : 'createPurchaseOrder'](42, {
      expectedRevision: 7, operationId: '01911111-1111-7111-8111-111111111181'
    }), /Location mapping unavailable/);
    assert.equal(calls.find(([name]) => name === 'fail')[1].retryable, true);
    assert.equal(calls.some(([name]) => name === 'create-so' || name === 'create-po'), false);
  });

  test(`${orderKind} known remote order hydration failure cannot release duplicate protection`, async () => {
    const { service, calls } = harness({ detail: caseDetail({ salesOrderId: sales ? null : 80, salesOrderApproved: true }),
      overrides: { [sales ? 'fetchSalesOrderReference' : 'fetchPurchaseOrderReference']: async () => null } });
    await assert.rejects(service[sales ? 'createSalesOrder' : 'createPurchaseOrder'](42, {
      expectedRevision: 7, operationId: '01911111-1111-7111-8111-111111111182'
    }), { code: 'SPECIAL_REMOTE_HYDRATION_FAILED' });
    assert.equal(calls.find(([name]) => name === 'fail')[1].retryable, false);
  });
}

test('a rejected POST followed by a recovered marker links the SO without releasing or recreating', async () => {
  let reads = 0;
  let posts = 0;
  const { service, calls } = harness({ overrides: {
    findMarkerOrders: async () => ++reads === 1 ? [] : [{ id: 91, entity_id: 800833, location_id: 10, memo: 'MBBS-SPECIAL-SO:42' }],
    createSalesOrder: async () => { posts++; throw Object.assign(new Error('Rejected'), {
      status: 400, netsuiteResponseReceived: true, netsuiteErrorCodes: ['USER_ERROR']
    }); }
  } });
  const result = await service.createSalesOrder(42, { expectedRevision: 7, operationId: '01911111-1111-7111-8111-111111111183' });
  assert.equal(result.salesOrderId, 91);
  assert.equal(posts, 1);
  assert.equal(calls.some(([name]) => name === 'fail'), false);
});


test('a durable prior submission cannot be posted again while its marker is invisible', async () => {
  for (const orderKind of ['sales_order','purchase_order']) {
    const sales=orderKind==='sales_order';
    const {service,calls}=harness({detail:caseDetail({salesOrderId:sales?null:80,salesOrderApproved:true,
      [sales?'salesOrderSubmissionStartedAt':'purchaseOrderSubmissionStartedAt']:'2026-09-24T12:00:00Z'})});
    await assert.rejects(()=>service[sales?'createSalesOrder':'createPurchaseOrder'](42,{expectedRevision:7,operationId:'01911111-1111-7111-8111-111111111117'}),error=>error.code==='SPECIAL_REMOTE_OUTCOME_UNCERTAIN');
    assert.equal(calls.some(([name])=>name==='create-so'||name==='create-po'),false);
  }
});

test('SO creation rejects an aged delivery date before claiming, but prior submissions remain recoverable',async()=>{
  const detail=caseDetail({fulfillmentMethod:'mbt_delivery',deliveryAddress:'TEST address',deliveryDate:'2000-01-01'});
  const fresh=harness({detail});
  for(const source of ['standalone','estimate_transform']) {
    await assert.rejects(()=>fresh.service.createSalesOrder(42,{expectedRevision:7,source}),{code:'SPECIAL_DELIVERY_DATE_TOO_SOON'});
    assert.deepEqual(fresh.calls,[]);
  }
  const recovery=harness({detail:{...detail,salesOrderSubmissionStartedAt:'2000-01-01T12:00:00Z'},markerRows:[{id:88,tranid:'SO88',entity_id:800833,location_id:10}]});
  assert.equal((await recovery.service.createSalesOrder(42,{expectedRevision:7})).salesOrderId,88);
  assert.equal(recovery.calls.some(([name])=>name==='create-so'),false);
});


test('new SO total-discount payload includes the selected NetSuite rep and missing selection makes no remote claim', async () => {
  const d=caseDetail({netsuiteSalesRepId:123,salesDiscountMode:'total',salesOrderLines:[{caseLineId:1,itemId:2055,quantity:10,uom:'PC',rate:4.25,description:'Special',nativeDiscountPercent:12.5}]});
  const f=harness({detail:d,overrides:{selectSalesRep:async id=>{assert.equal(id,123);return{id:123,name:'TEST Rep'};},assertDiscountReady:async()=>{},
    createDiscountSalesOrder:async payload=>{assert.deepEqual(payload.salesRep,{id:'123'});assert.deepEqual(payload.discountItem,{id:'10716'});assert.equal(payload.discountRate,-5.31);assert.equal(payload.item.items.length,1);return{id:91};},verifyDiscountSalesOrder:async()=>{}}});
  await f.service.createSalesOrder(d.id,{expectedRevision:d.revision,operationId:'00000000-0000-4000-8000-000000000099'});
  assert.equal(f.calls[0][1].netsuiteSalesRep.id,123);
  const missing=harness({overrides:{selectSalesRep:async()=>{throw Object.assign(Error('Choose a rep'),{code:'SPECIAL_SALES_REP_REQUIRED'});}}});
  await assert.rejects(missing.service.createSalesOrder(42,{}),{code:'SPECIAL_SALES_REP_REQUIRED'});
  assert.deepEqual(missing.calls,[]);
});


test('standalone PO creation does not require the native RESTlet action',async()=>{
  let submitted=0,created=0;
  const detail=caseDetail({salesOrderId:80,salesOrderApproved:true});
  const f=harness({detail,overrides:{
    assertPurchaseOrderReady:async()=>{throw Object.assign(Error('Update RESTlet'),{code:'SPECIAL_NATIVE_PO_SETUP_REQUIRED'});},
    markSubmitted:async()=>{submitted++;return detail;},createPurchaseOrder:async payload=>{created++;assert.equal(payload.createdFrom,undefined);return{id:91};}}});
  const result=await f.service.createPurchaseOrder(42,{expectedRevision:7,operationId:'01911111-1111-7111-8111-111111111114'});
  assert.equal(result.purchaseOrderId,91);assert.equal(submitted,1);assert.equal(created,1);
});
