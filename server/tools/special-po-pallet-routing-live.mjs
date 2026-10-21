import assert from 'node:assert/strict';
import {closeDb} from '../src/db.js';
import {getSpecialStockCase} from '../src/special-stock-request-repository.js';
import {getScmPurchaseOrderCatalogOrder} from '../src/scm-purchase-order-catalog-repository.js';
import {resolveSpecialOrderUnitsFromNetSuite} from '../src/netsuite.js';
import {buildSpecialPurchaseOrderPayload} from '../src/special-stock-request-netsuite.js';
import {specialPoRoutingHtml} from '../public/special-stock-po-routing.js';

try {
  const detail=await getSpecialStockCase(83,{audience:'scm'});
  assert.equal(detail.requestRef,'SPREQ-000017');assert.equal(detail.purchaseOrderRef,'POB03976');assert.equal(detail.attention,false);
  const lines=await resolveSpecialOrderUnitsFromNetSuite(detail.purchaseOrderLines);
  const payload=buildSpecialPurchaseOrderPayload({caseId:83,vendorId:detail.vendorId,netsuiteLocationId:1,lines,vendorDiscountReview:detail.vendorDiscountReview});
  const pallets=payload.item.items.filter(line=>line.item.id==='1784');assert.equal(pallets.length,1);
  assert.deepEqual([pallets[0].quantity,pallets[0].rate,pallets[0].units],[1,35,'246']);
  const order=await getScmPurchaseOrderCatalogOrder('POB03976',{includeRestricted:true});assert(order);
  const html=specialPoRoutingHtml(detail,{ref:detail.purchaseOrderRef,order});
  assert.match(html,/scm-mini-row scm-mini-routing-row/);assert.match(html,/Save Schedule/);
  assert.match(html,/data-scm-field="method"/);assert.match(html,/data-scm-field="packingSlipRef"/);
  console.log(JSON.stringify({readOnly:true,requestRef:detail.requestRef,poRef:detail.purchaseOrderRef,
    attention:false,pallet:{quantity:1,purchaseCost:35,unitId:246},payloadVerified:true,routingRendered:true,
    payloadSubmitted:false,netSuiteOrdersChanged:false}));
} finally {await closeDb();}
