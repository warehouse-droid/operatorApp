import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {buildStockRequestTransferPayload} from '../../../src/stock-request-service.js';
import {findTransferOrdersByStockRequestMarkerFromNetSuite} from '../../../src/netsuite.js';

const locations={source:{netsuiteLocationId:1,subsidiaryId:1},destination:{netsuiteLocationId:28,subsidiaryId:1}};
const transfer={workflowVersion:2,id:42,requestId:81,transferRef:'STTO-000042',palletQuantity:0,lines:[{itemId:10,salesQty:5}]};

test('property: Delivery memo is exactly the SO reference and preserves the stable TO identity',()=>{
 fc.assert(fc.property(fc.integer({min:1,max:999999999}),fc.integer({min:1,max:100000}), (number,quantity)=>{
  const salesOrderRef=`SOB${number}`;
  const payload=buildStockRequestTransferPayload({transfer:{...transfer,deliverySalesOrderRef:salesOrderRef,lines:[{itemId:10,salesQty:quantity}]},locations});
  assert.equal(payload.memo,salesOrderRef);
  assert.equal(payload.externalId,'MBBS_REGULAR_STOCK_81_42');
  assert.equal(payload.item.items[0].quantity,quantity);
 }),{seed:121732,numRuns:100});
});

test('legacy, Pickup and Stocking payloads retain their existing memo',()=>{
 for(const workflowVersion of [1,2]){
  const payload=buildStockRequestTransferPayload({transfer:{...transfer,workflowVersion},locations});
  assert.equal(payload.memo,'Sales stock request STTO-000042 | MBBS-STOCK-REQUEST-TO:42');
 }
});

test('invalid request identity cannot broaden the remote TO recovery query',async()=>{
 for(const requestId of [0,-1,1.5,'81 OR 1=1'])await assert.rejects(
  ()=>findTransferOrdersByStockRequestMarkerFromNetSuite({transferId:42,requestId,sourceLocationId:1,destinationLocationId:28}),
  /valid local stock request ID/);
});
