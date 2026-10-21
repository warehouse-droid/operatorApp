// Production smoke checks use read-only SQL and pure calculations.
import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from '../src/db.js';
import {normalizeStockingType,purchaseReviewQuantity,allocatePurchaseQuantity} from '../src/regular-stock-purchase-domain.js';
try{
  const result=await withTransaction(async()=>{
    await query('SET TRANSACTION READ ONLY');
    assert.equal((await query("SELECT count(*)::int AS n FROM schema_migrations WHERE filename='245_regular_stock_purchase.sql'")).rows[0].n,1);
    const tables=(await query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('regular_stock_purchase_demands','regular_stock_purchase_allocations','regular_stock_purchase_runs') ORDER BY tablename")).rows;
    assert.equal(tables.length,3);
    const columns=(await query("SELECT column_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='sales_stock_request_lines' AND column_name IN ('stocking_type','source_location_id','source_name')")).rows;
    assert.equal(columns.length,3);assert(columns.filter(row=>row.column_name!=='stocking_type').every(row=>row.is_nullable==='YES'));
    assert.match(columns.find(row=>row.column_name==='stocking_type').column_default,/transfer/);
    assert.equal(normalizeStockingType('stocking'),'transfer');assert.equal(normalizeStockingType('stocking','purchase'),'purchase');
    assert.throws(()=>normalizeStockingType('pickup','purchase'));
    assert.deepEqual(purchaseReviewQuantity(175,100,125),{requestedQuantity:175,reviewedQuantity:125,approvedPallets:2,approvedQuantity:200,toPlt:100});
    assert.deepEqual(allocatePurchaseQuantity([{id:1,remaining:200},{id:2,remaining:100}],300,150),[{demandId:1,quantity:200,received:150},{demandId:2,quantity:100,received:0}]);
    const invalid=(await query(`SELECT count(*)::int AS n FROM sales_stock_request_lines WHERE
      (stocking_type='transfer' AND (source_location_id IS NULL OR source_name IS NULL OR source_location_id=destination_location_id))
      OR (stocking_type='purchase' AND (source_location_id IS NOT NULL OR source_name IS NOT NULL))`)).rows[0].n;
    assert.equal(invalid,0);
    return {readOnly:true,migrationApplied:true,purchaseTables:tables.length,transferDefaultPreserved:true,
      manualReviewQuantityRoundingVerified:true,fifoReceiptAllocationVerified:true,invalidRoutes:invalid,netSuiteCalls:0,orderWrites:0};
  });
  console.log(JSON.stringify(result));
}finally{await closeDb();}
