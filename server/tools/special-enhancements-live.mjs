// Read-only post-release verification; no case edits or NetSuite order writes.
import assert from 'node:assert/strict';
const root=process.cwd();
const {query,closeDb}=await import(root+'/src/db.js');
const {getSpecialStockCase,listSpecialStockCases,listSpecialCaseVendors}=await import(root+'/src/special-stock-request-repository.js');
const {getSpecialSalesAlertCounts}=await import(root+'/src/special-stock-alerts.js');
const {specialSalesReps}=await import(root+'/src/special-stock-sales-reps.js');
try{
 const migration=(await query("SELECT count(*)::int AS n FROM schema_migrations WHERE filename='238_special_request_details_expiry.sql'")).rows[0].n;assert.equal(migration,1);
 const expired=(await query("SELECT count(*)::int AS n FROM sales_special_stock_cases WHERE expires_on IS NULL")).rows[0].n;assert.equal(expired,0);
 const detail=await getSpecialStockCase(67,{audience:'scm'});assert.equal(detail.requestRef,'SPREQ-000011');assert.equal(detail.salesOrderRef,'SOM06738');assert.equal(detail.purchaseOrderRef,'POB03960');assert.equal(detail.fulfillmentMethod,'vendor_pickup');assert.equal(detail.closeStatus,'active');
 const vendors=await listSpecialCaseVendors();assert.ok(vendors.includes(detail.vendorName));
 const filtered=await listSpecialStockCases({vendorNames:JSON.stringify([detail.vendorName]),audience:'scm'});assert.ok(filtered.some(d=>d.id===67));assert.ok(filtered.every(d=>d.vendorName===detail.vendorName));
 const counts=await getSpecialSalesAlertCounts({operatorId:detail.requestedBy,authorizedStoreLocationIds:[detail.storeLocationId]});assert.equal(counts.total,counts.awaitCustomerConfirmation+counts.dispatchArrangement+counts.waitForProduction);
 const reps=await specialSalesReps.list();assert.ok(reps.length>0);
 console.log(JSON.stringify({readOnly:true,migrationApplied:true,expiryBackfilled:true,vendorFilterVerified:true,ownAlertCountsVerified:true,activeSalesReps:reps.length,existingCase:{requestRef:detail.requestRef,fulfillmentMethod:detail.fulfillmentMethod,salesOrder:detail.salesOrderRef,purchaseOrder:detail.purchaseOrderRef,closeStatus:detail.closeStatus},netSuiteOrderWrites:0}));
}finally{await closeDb();}
