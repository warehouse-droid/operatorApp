// Read-only checks against the deployed application; no NetSuite or printer calls.
import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from '../src/db.js';
import {assertDeliveryStockRequestDestinationAccess,can150SalesAccessDeliveryRequest} from '../src/regular-stock-delivery-access.js';
import {assertStockRequestDestinationAccess} from '../src/stock-request-domain.js';
import {listSalesStockRequests,getSalesStockRequest,listStockRequestFilterOptions} from '../src/stock-request-repository.js';
try {
  const result=await withTransaction(async()=>{
    await query('SET TRANSACTION READ ONLY');
    for (const [source,destination] of [[1,28],[28,1]]) {
      assert.equal(assertDeliveryStockRequestDestinationAccess(source,destination,[26]),destination);
      assert.equal(assertDeliveryStockRequestDestinationAccess('',destination,[26],{preview:true}),destination);
      assert.throws(()=>assertStockRequestDestinationAccess(destination,[26]),{status:403});
      assert.throws(()=>assertDeliveryStockRequestDestinationAccess(15,destination,[26]),{status:403});
      assert.throws(()=>assertDeliveryStockRequestDestinationAccess(source,destination,[15]),{status:403});
    }
    const accounts=(await query("SELECT count(*)::int AS n FROM operators WHERE active AND 26=ANY(yard_location_ids) AND (role='sales' OR 'sales'=ANY(roles))")).rows[0].n;
    const context={authorizedDestinationLocationIds:[26]},requests=await listSalesStockRequests({...context,limit:200});
    const crossYard=requests.filter(request=>request.destinationLocationId!==26);
    for (const request of crossYard) {
      assert.equal(can150SalesAccessDeliveryRequest(request,[26]),true);
    }
    if (crossYard.length) {
      assert.equal((await getSalesStockRequest(crossYard[0].id,context)).id,crossYard[0].id);
      await assert.rejects(()=>getSalesStockRequest(crossYard[0].id,{authorizedDestinationLocationIds:[15]}),{status:403});
    }
    assert.deepEqual((await listStockRequestFilterOptions(context)).destinationYards.map(yard=>yard.locationId),[26]);
    return {readOnly:true,active150SalesAccounts:accounts,enabledRoutes:['3445 → 2967','2967 → 3445'],
      otherWorkflowsRestricted:true,otherRoutesRestricted:true,listedRequests:requests.length,crossYardDeliveries:crossYard.length,
      netSuiteCalls:0,orderWrites:0,printJobsCreated:0};
  });
  console.log(JSON.stringify(result));
} finally {await closeDb();}
