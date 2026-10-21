import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {buildSpecialPurchaseOrderPayload} from '../../../src/special-stock-request-netsuite.js';
import {createSpecialStockRequestService} from '../../../src/special-stock-request-service.js';
import {specialVendorLineDiscountReview} from '../../../public/special-stock-purchase-pricing.js';

const materials = [{caseLineId:1,itemId:2055,quantity:24,uom:'PC',unitId:865,unitPurchaseCost:33.87,
  vendorDiscountPercent:10,description:'Reviewed material'}];
const lines = [...materials,{itemId:1784,ancillary:true,quantity:1,uom:'EACH',unitId:246,unitPurchaseCost:35,description:'PALLET'}];
const input = {caseId:83,vendorId:331,netsuiteLocationId:1,lines,vendorDiscountReview:specialVendorLineDiscountReview(materials)};

test('the Special PO Note matches POB03976 and only adds custbody7', () => {
  const plain = buildSpecialPurchaseOrderPayload(input);
  const mapped = buildSpecialPurchaseOrderPayload({...input,salesOrderRef:'  SOB121819  '});
  assert.equal(mapped.custbody7,'for SOB121819');
  const {custbody7,...rest} = mapped;
  assert.equal(custbody7,'for SOB121819');
  assert.deepEqual(rest,plain);
  assert.equal(mapped.externalId,'MBBS-SPECIAL-PO:83');
  assert.equal(mapped.createdFrom,undefined);
  assert.deepEqual(mapped.item.items.map(line=>[line.item.id,line.quantity,line.rate]),
    [['2055',24,33.87],['1784',1,35],['4981',1,-81.29]]);
});

test('property: each SO number becomes the Note without changing any other purchasing value', () => {
  fc.assert(fc.property(fc.constantFrom('SOB','SOM','SOV'),fc.integer({min:1,max:999999999}),
    (prefix,number)=>{
      const ref=prefix+number;
      const mapped=buildSpecialPurchaseOrderPayload({...input,salesOrderRef:'\t'+ref+'\n'});
      assert.equal(mapped.custbody7,'for '+ref);
      const {custbody7,...rest}=mapped;
      assert.ok(custbody7.endsWith(ref));
      assert.deepEqual(rest,buildSpecialPurchaseOrderPayload(input));
    }),{seed:2026100117,numRuns:200});
});

test('requests without an SO number omit the Note', () => {
  for(const salesOrderRef of [undefined,null,'',' \t ']) {
    assert.equal(Object.hasOwn(buildSpecialPurchaseOrderPayload({...input,salesOrderRef}),'custbody7'),false);
  }
});

function serviceFixture({salesOrderId=1030576,salesOrderRef='SOB121819',hydratedRef='SOB121819',marker=false}={}) {
  const actions=[];
  const detail={id:83,revision:7,vendorId:331,operationalYardLocationId:1,salesOrderId,salesOrderRef,
    salesOrderApproved:true,salesOrderLines:materials.map(line=>({...line,rate:48.39,remoteLineId:5058992})),
    purchaseOrderLines:lines,vendorDiscountReview:input.vendorDiscountReview};
  const service=createSpecialStockRequestService({getCase:async()=>detail,claimOperation:async()=>detail,
    resolveLocations:async()=>[{netsuiteLocationId:1}],resolveOrderUnits:async value=>value,
    findMarkerOrders:async()=>marker?[{id:1030348,entity_id:331,location_id:1}]:[],findLinkedPurchaseOrder:async()=>null,
    fetchSalesOrderReference:async id=>{actions.push(['hydrate',id]);return hydratedRef?{tranid:hydratedRef}:null;},
    markSubmitted:async()=>{actions.push(['submitted']);return detail;},
    createPurchaseOrder:async payload=>{actions.push(['post',payload]);return{id:1030348};},
    fetchPurchaseOrderReference:async()=>({tranid:'POB03976'}),recordPurchaseOrderCreation:async()=>{},
    linkPurchaseOrder:async(_id,value)=>({...detail,purchaseOrderId:value.purchaseOrderId}),
    failOperation:async()=>actions.push(['failed']),sleep:async()=>{}});
  return {service,actions};
}

test('PO creation uses the claimed case SO number without fetching or editing that SO', async()=>{
  const f=serviceFixture();
  await f.service.createPurchaseOrder(83,{expectedRevision:7,operationId:'note-test'});
  assert.deepEqual(f.actions.map(([action])=>action),['submitted','post']);
  assert.equal(f.actions[1][1].custbody7,'for SOB121819');
});

test('PO creation hydrates a missing SO number before submission', async()=>{
  const f=serviceFixture({salesOrderRef:' '});
  await f.service.createPurchaseOrder(83,{expectedRevision:7,operationId:'note-test'});
  assert.deepEqual(f.actions.map(([action])=>action),['hydrate','submitted','post']);
  assert.equal(f.actions[0][1],1030576);
  assert.equal(f.actions[2][1].custbody7,'for SOB121819');
});

test('an unavailable linked SO number stops before any PO submission', async()=>{
  const f=serviceFixture({salesOrderRef:'',hydratedRef:null});
  await assert.rejects(()=>f.service.createPurchaseOrder(83,{expectedRevision:7,operationId:'note-test'}),
    {code:'SPECIAL_REMOTE_HYDRATION_FAILED'});
  assert.deepEqual(f.actions.map(([action])=>action),['hydrate','failed']);
});

test('existing marker recovery needs no new SO read or PO write', async()=>{
  const f=serviceFixture({salesOrderRef:'',hydratedRef:null,marker:true});
  const result=await f.service.createPurchaseOrder(83,{expectedRevision:7,operationId:'note-test'});
  assert.equal(result.purchaseOrderId,1030348);
  assert.deepEqual(f.actions,[]);
});

test('a test request without a real SO creates its PO without a fabricated Note', async()=>{
  const f=serviceFixture({salesOrderId:null,salesOrderRef:''});
  await f.service.createPurchaseOrder(83,{expectedRevision:7,operationId:'note-test'});
  assert.deepEqual(f.actions.map(([action])=>action),['submitted','post']);
  assert.equal(Object.hasOwn(f.actions[1][1],'custbody7'),false);
});
