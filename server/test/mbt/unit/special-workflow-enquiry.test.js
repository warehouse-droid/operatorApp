import assert from 'node:assert/strict';
import test from 'node:test';
import {minimumSpecialCaseRequiredDate,normalizeSpecialCaseDraft,normalizeSpecialSalesOrderDraft} from '../../../src/special-stock-request-domain.js';
import {earliestSpecialDeliveryDate} from '../../../public/special-stock-pricing.js';
test('enquiry date starts today while SO delivery starts three Ontario working days after placement',()=>{
 const now=new Date('2026-10-08T15:00:00Z');
 assert.equal(minimumSpecialCaseRequiredDate(now),'2026-10-08');
 const draft={storeLocationId:1,fulfillmentMethod:'yard_pickup',inquiryDate:'2026-10-08',customerName:'TEST',vendorName:'TEST vendor',lines:[{productName:'TEST',quantity:2,uom:'PLT',rate:120,requiredDate:'2026-10-09'}]};
 assert.equal(normalizeSpecialCaseDraft(draft,{authorizedStoreLocationIds:[1],minimumRequiredDate:minimumSpecialCaseRequiredDate(now)}).lines[0].requiredDate,'2026-10-09');
 assert.equal(earliestSpecialDeliveryDate(now),'2026-10-14');
 assert.throws(()=>normalizeSpecialSalesOrderDraft({customerId:7988,operationalYardLocationId:1,fulfillmentMethod:'mbt_delivery',deliveryAddress:'TEST',deliveryDate:'2026-10-13',palletTotal:0,materialLines:[{caseLineId:1,itemId:2055,description:'TEST',quantity:2,uom:'PC',rate:108}]},{now}),{code:'SPECIAL_DELIVERY_DATE_TOO_SOON'});
});
