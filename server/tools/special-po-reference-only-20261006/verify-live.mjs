import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {getSpecialStockCase} from '../../src/special-stock-request-repository.js';
import {specialItemDescription} from '../../public/special-stock-line-details.js';
import {query,withTransaction,closeDb} from '../../src/db.js';

try{
  const d=await withTransaction(async()=>{await query('SET TRANSACTION READ ONLY');return getSpecialStockCase(119,{audience:'scm',dispatchPlans:[]});});
  assert.equal(d.requestRef,'SPREQ-000038');assert.equal(d.salesOrderRef,'SOA09865');assert.equal(d.salesOrderSource,'manual_link');
  const materials=d.lines.filter(line=>line.salesDecision==='accepted').map(line=>({caseLineId:line.id,description:specialItemDescription(line),quantity:line.quantity,uom:line.uom}));
  assert.ok(materials.length);assert.ok(materials.every(line=>line.description&&line.quantity>0&&line.uom));
  const scm=await readFile('public/scm-special-stock-requests.js','utf8'),service=await readFile('src/special-stock-request-service.js','utf8');
  assert.ok(scm.includes("const independentPurchase = detail.salesOrderSource === 'manual_link';"));
  assert.ok(service.includes('findLinkedOrder: independentPurchase ? null :'));
  assert.ok(service.includes('claimed.salesOrderId && !independentPurchase ?'));
  const page=await fetch('http://127.0.0.1:3000/scm-stock-requests.html');assert.equal(page.status,200);assert.ok((await page.text()).includes('manualLinks=20261006-request-po-v2'));
  console.log(JSON.stringify({request:d.requestRef,revision:d.revision,salesOrder:d.salesOrderRef,salesOrderSource:d.salesOrderSource,
    purchaseOrder:d.purchaseOrderRef||null,salesDraftLines:d.salesOrderLines.length,purchaseDraftLines:d.purchaseOrderLines.length,materials,
    verification:'read-only request, deployed service and served page verified; no order created'}));
}finally{await closeDb();}
