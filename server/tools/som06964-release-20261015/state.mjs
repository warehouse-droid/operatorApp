import {query,withTransaction,closeDb} from './src/db.js';
import {listDispatchOrders} from './src/dispatch-repository.js';
import {listFulfilledSalesDeliveryStates,overlayFulfilledSalesDeliveryPlanning} from './src/dispatch-fulfilled-so-repository.js';
import {config} from './src/config.js';
config.netsuite.directAccessEnabled=false;
try{const r=await withTransaction(async()=>{
 await query('SET TRANSACTION READ ONLY');
 const rows=async(sql,args=[]) => (await query(sql,args)).rows;
 const reconciliation=await rows("SELECT * FROM scm_reconciliation_order_state WHERE order_kind='SO' AND source_order_netsuite_id=1049213");
 const catalog=await rows("SELECT * FROM dispatch_order_catalog_entries WHERE order_ref='SOM06964'");
 const completion=await rows("SELECT * FROM dispatch_effective_order_completion_events WHERE order_ref='SOM06964'");
 const reopens=await rows("SELECT * FROM operator_order_reopens WHERE order_keys @> ARRAY['sales_order:1049213']");
 const fulfillment=await rows("SELECT * FROM delivery_fulfillment_records WHERE order_id=1049213");
 const raw=await listDispatchOrders({type:'SO',search:'SOM06964'});
 const fresh=await overlayFulfilledSalesDeliveryPlanning(raw);
 const states=Object.fromEntries(await listFulfilledSalesDeliveryStates(['SOM06964']));
 return {at:new Date().toISOString(),reconciliation,catalog,completion,reopens,fulfillment,raw,fresh,states};
});console.log(JSON.stringify(r,null,2));}finally{await closeDb();}
