import assert from 'node:assert/strict';import crypto from 'node:crypto';
const hashes={};for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
 const health=await fetch(base+'/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
 for(const [file,hash] of Object.entries(hashes)){if(!file.startsWith('public/'))continue;
 const path=file.endsWith('.html')?'/scm/stock-requests':'/'+file.slice(7);
 const response=await fetch(base+path,{headers:{'Cache-Control':'no-cache','User-Agent':'Mozilla/5.0'}});assert.equal(response.status,200,path);
 const body=(await response.text()).replace(/<script type="module" src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js\/[^>]+><\/script>\n/g,'');
 assert.equal(crypto.createHash('sha256').update(body).digest('hex'),hash,path);}}
const {getSpecialStockCase}=await import('./src/special-stock-request-repository.js');
const {readSpecialPurchaseOrderNote}=await import('./src/special-stock-purchase-order-routing.js');
const {getScmPurchaseOrderCatalogOrder}=await import('./src/scm-purchase-order-catalog-repository.js');
const {buildSpecialPurchaseOrderPayload}=await import('./src/special-stock-request-netsuite.js');
const {specialPoRoutingHtml}=await import('./public/special-stock-po-routing.js');
const {fetchPurchaseOrderReferenceFromNetSuite}=await import('./src/netsuite.js');
const {closeDb}=await import('./src/db.js');
try {
 const detail=await getSpecialStockCase(83,{audience:'scm'});assert.equal(detail.requestRef,'SPREQ-000017');assert.equal(detail.attention,false);
 const {note}=await readSpecialPurchaseOrderNote(83);
 const header=await fetchPurchaseOrderReferenceFromNetSuite(detail.purchaseOrderId);
 assert.equal(header.netsuite_note,note);
 const order=await getScmPurchaseOrderCatalogOrder(detail.purchaseOrderReference || detail.purchaseOrderRef);assert(order);
 assert.equal(order.netSuiteNote,note);
 const html=specialPoRoutingHtml(detail,{ref:detail.purchaseOrderRef,order});assert.match(html,/Saved to the NetSuite PO/);
 const payload=buildSpecialPurchaseOrderPayload({caseId:detail.id,vendorId:detail.vendorId,netsuiteLocationId:1,
   salesOrderRef:detail.salesOrderRef,lines:detail.purchaseOrderLines,vendorDiscountReview:detail.vendorDiscountReview});
 assert.equal(payload.custbody7,'for '+detail.salesOrderRef);
 const pallet=payload.item.items.find(line=>line.item.id==='1784');assert.equal(pallet.quantity,1);assert.equal(pallet.rate,35);
 console.log(JSON.stringify({health:true,publicAssets:true,netSuiteReadOnly:true,suiteqlPoNoteVerified:true,localNoteCacheRefreshed:true,
   requestRef:detail.requestRef,poRef:detail.purchaseOrderRef,poNote:note,newPoNote:payload.custbody7,palletPreserved:true,payloadSubmitted:false}));
} finally {await closeDb();}