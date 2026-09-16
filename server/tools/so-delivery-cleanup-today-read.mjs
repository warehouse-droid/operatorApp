// This script only reads operational data. Run with PG's read-only guard live.
import { writeFileSync } from "node:fs";
import { pool, query, withTransaction, closeDb } from "../src/db.js";
import { getDriverDayJobs } from "../src/driver-repository.js";
import { getDeliveryOrder, listDeliveryOrders, listDeliveryLoadOrders } from "../src/delivery-repository.js";
import { listFulfilledSalesDeliveryStates } from "../src/dispatch-fulfilled-so-repository.js";
import { loadDispatchOrdersForResponse } from "../src/server.js";

pool.options.options="-c jit=off -c default_transaction_read_only=on -c statement_timeout=60000";
const date=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Toronto",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
const filename=process.argv[2];
async function attempt(name,fn) {
  await query("SAVEPOINT operational_read");
  try {const result=await fn();await query("RELEASE SAVEPOINT operational_read");return result;}
  catch(error) {await query("ROLLBACK TO SAVEPOINT operational_read");return {error:error.message,code:error.code,read:name};}
}
function loadSummary(plan,truck,load) {
  const orders=[...new Set([...(load.orders||[]).map(value=>typeof value==="object"?value.id:value),
    ...(load.stops||[]).flatMap(stop=>[stop.orderId,...(stop.orderRefs||[])])].filter(Boolean))];
  return {planId:plan.id,status:plan.status,truck:truck.plate||truck.id,loadId:load.id,
    driver:load.driverLogin||truck.driverLogin||load.driver||truck.driver,orders,stops:(load.stops||[]).length};
}
function planSummary(plans) {
  const loads=plans.flatMap(plan=>(plan.trucks||[]).flatMap(truck=>(truck.loads||[]).map(load=>loadSummary(plan,truck,load))));
  const refs=new Set(loads.flatMap(load=>load.orders));
  for(const order of plans.flatMap(plan=>plan.orders||[])) {
    if(refs.has(order.id)) for(const child of order.childOrders||[]) refs.add(child);
  }
  const drivers=new Set(loads.filter(load=>load.driver&&load.status==="confirmed").map(load=>String(load.driver).toLowerCase()));
  return {loads,refs,drivers};
}
async function readRoutes(drivers) {
  const routes=[];
  for(const driver of drivers) {
    const route=await attempt(`Driver ${driver}`,()=>getDriverDayJobs(driver,{date}));
    routes.push({driver,...(route.error?route:{jobs:route.jobs.map(job=>({jobId:job.jobId,stopType:job.stopType,status:job.status,
      orderRefs:job.orderRefs,requiredPhotos:job.requiredPhotos,loadId:job.loadId}))})});
  }
  return routes;
}
function operatorSummary(row,detail) {
  return {ref:row.tranid,id:row.netsuite_id,...(detail?.error?detail:{found:Boolean(detail),
    status:detail?.operator_status,yardStatus:detail?.local_yard_order_status,
    warningCount:detail?.warning_count,underpackCount:detail?.underpack_count,
    lines:(detail?.lines||[]).map(line=>({id:line.id,required:line.quantity,loaded:line.loaded_qty,packed:line.packed_sales_qty,
      unit:line.unit,linkedBlocked:line.linked_quantity_blocked,syncException:line.sync_exception,netsuiteActive:line.netsuite_active}))})};
}
async function readFeeds() {
  const feeds={};
  for(const [name,fn] of [["deliveryActive",()=>listDeliveryOrders({status:"active",orderType:"sales_order",planDate:date})],
    ["deliveryPacked",()=>listDeliveryOrders({status:"packed",orderType:"sales_order",planDate:date})],
    ["loadActive",()=>listDeliveryLoadOrders({status:"active",planDate:date})]]) {
    const result=await attempt(name,fn);
    feeds[name]=Array.isArray(result)?result.map(order=>({id:order.netsuite_id,ref:order.tranid,status:order.operator_status,
      yardStatus:order.local_yard_order_status,underpack:order.underpack_count,warnings:order.warning_count})):result;
  }
  return feeds;
}
async function readSearch(detailRows) {
  const search=[];
  for(const ref of ["SOR00030","SOB119972","SOV02345",...detailRows.slice(0,8).map(row=>row.tranid)]) {
    const result=await attempt(`Dispatch ${ref}`,()=>loadDispatchOrdersForResponse({type:"SO",search:ref,exactOrderRefs:[ref],includeCompletedScmSearch:true}));
    const order=Array.isArray(result)?result.find(row=>row.id===ref):null;
    search.push({ref,...(result.error?result:{found:Boolean(order),completed:order?.dispatchCompletionStatus,
      eligible:order?.dispatchFulfilledSalesPlanningEligible,restricted:order?.dispatchPlanningRestricted})});
  }
  return search;
}
try {
  const report=await withTransaction(async()=>{
    await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const plans=(await query(`SELECT p.id,p.status,p.plan_date,s.orders,s.trucks FROM dispatch_plans p
      JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.plan_date=$1::date ORDER BY p.id`,[date])).rows;
    const {loads,refs,drivers}=planSummary(plans);
    const routes=await readRoutes(drivers);
    const detailRows=(await query(`SELECT netsuite_id,tranid FROM sales_orders WHERE lower(tranid)=ANY($1::text[])
      AND sales_order_type='Delivery' ORDER BY tranid`,[[...refs].map(ref=>ref.toLowerCase())])).rows;
    const operator=[];
    for(const row of detailRows) {
      const detail=await attempt(`Operator ${row.tranid}`,()=>getDeliveryOrder(row.netsuite_id,{includeNetSuiteClosed:true}));
      operator.push(operatorSummary(row,detail));
    }
    const feeds=await readFeeds();
    const states=await listFulfilledSalesDeliveryStates([...refs]);
    const search=await readSearch(detailRows);
    return {capturedAt:new Date().toISOString(),date,timeZone:"America/Toronto",plans:plans.map(plan=>({id:plan.id,status:plan.status})),
      loads,routes,operator,feeds,planningStates:Object.fromEntries([...refs].map(ref=>[ref,states.get(ref.toLowerCase())]).filter(([,state])=>state)),search};
  },{rollback:true});
  if(filename) writeFileSync(filename,JSON.stringify(report,null,2)+"\n");
  else process.stdout.write(JSON.stringify(report,null,2)+"\n");
  process.stderr.write(`Read today's ${report.loads.length} loads, ${report.routes.length} Driver routes, and ${report.operator.length} SO details.\n`);
} finally {await closeDb();}
