// Exercise deployed read paths and admission guards without saving a plan.
import path from "node:path";
import {pathToFileURL} from "node:url";
const source=(name)=>pathToFileURL(path.resolve("src",name)).href;
const {pool,query,withTransaction,closeDb}=await import(source("db.js"));
pool.options.options="-c jit=off -c default_transaction_read_only=on -c statement_timeout=45000";
const {loadDispatchOrdersForResponse}=await import(source("server.js"));
const {assertNoDriverPwaCompletedDispatchRefs}=await import(source("dispatch-history-mode.js"));
const {assertNoClosedNetSuiteOrders}=await import(source("netsuite-closed-order-repository.js"));
const {getDeliveryOrder}=await import(source("delivery-repository.js"));
const refs=["SOR00030","SOA03472","SOB119972","SOV02345","SOA07771",
  "SOA07539-S1","SOA08404-S2","SOM05681","SOR00107","SOA08695","SOA08614"];
try {
  const result=await withTransaction(async()=>{
    await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const results=[];
    for(const ref of refs) {
      const {rows:[header]}=await query("SELECT netsuite_id FROM sales_orders WHERE tranid=$1",[ref]);
      const orders=await loadDispatchOrdersForResponse({type:"SO",search:ref,
        exactOrderRefs:[ref],includeCompletedScmSearch:true});
      const order=orders.find((o)=>o.id===ref);
      const delivery=header?await getDeliveryOrder(header.netsuite_id):null;
      const guards={};
      for(const [name,check] of [["driverCompletion",assertNoDriverPwaCompletedDispatchRefs],
        ["netsuiteClosed",assertNoClosedNetSuiteOrders]]) {
        try {await check([ref],"be added to a Dispatch plan"); guards[name]={allowed:true};}
        catch(error) {guards[name]={allowed:false,code:error.code,message:error.message};}
      }
      results.push({ref,searchReturned:Boolean(order),searchRows:orders.map((o)=>o.id),
        dispatch:order?{operatorStatus:order.operatorStatus,localYardOrderStatus:order.localYardOrderStatus,
          fulfillmentStatus:order.fulfillmentStatus,dispatchCompletionStatus:order.dispatchCompletionStatus,
          dispatchPlanningRestricted:order.dispatchPlanningRestricted===true,
          completionEvidenceType:order.completionEvidenceType}:null,
        operator:delivery?{operator_status:delivery.operator_status,
          local_yard_order_status:delivery.local_yard_order_status,
          warning_count:delivery.warning_count,underpack_count:delivery.underpack_count,
          reload_cycle_id:delivery.reload_cycle_id,lines:(delivery.lines||[]).map((l)=>({id:l.id,
            line_id:l.line_id,item_id:l.item_id,sku:l.sku,item_type:l.item_type,quantity:l.quantity,
            loaded_qty:l.loaded_qty,loaded_uom:l.loaded_uom,unit:l.unit,
            packed_pallet_qty:l.packed_pallet_qty,packed_layer_qty:l.packed_layer_qty,
            packed_section_qty:l.packed_section_qty,packed_piece_qty:l.packed_piece_qty,
            packed_sales_qty:l.packed_sales_qty,netsuite_active:l.netsuite_active,
            no_yard_load_required:l.no_yard_load_required,linked_quantity_blocked:l.linked_quantity_blocked}))}:null,
        guards});
      process.stderr.write(`Read-only Dispatch/Operator verification: ${ref}.\n`);
    }
    return {mode:"deployed-read-only-verification",capturedAt:new Date().toISOString(),results};
  },{rollback:true});
  process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
} finally {await closeDb();}
