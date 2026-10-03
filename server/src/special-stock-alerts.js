import { query } from './db.js';

export async function getSpecialStockAlertCounts() {
  const { rows: [row] } = await query(`
    SELECT count(*) FILTER (WHERE stage = 'new_enquiry')::integer AS new_requests,
           count(*) FILTER (WHERE stage = 'confirmed')::integer AS confirmed_orders
      FROM special_stock_workflow_stages
     WHERE stage IN ('new_enquiry', 'confirmed')`);
  const newRequests = Number(row.new_requests);
  const confirmedOrders = Number(row.confirmed_orders);
  return { newRequests, confirmedOrders, total: newRequests + confirmedOrders };
}

export async function getSpecialSalesAlertCounts({operatorId,authorizedStoreLocationIds=[]} = {}) {
  const empty={awaitCustomerConfirmation:0,dispatchArrangement:0,waitForProduction:0,pendingUpdate:0,total:0};
  if (!operatorId || !authorizedStoreLocationIds.length) return empty;
  const {rows:[row]}=await query(`SELECT
    count(*) FILTER(WHERE workflow.stage='await_customer_confirmation')::int AS confirmation,
    count(*) FILTER(WHERE workflow.stage='dispatch_arrangement')::int AS dispatch,
    count(*) FILTER(WHERE workflow.stage='wait_for_production')::int AS production,
    count(*) FILTER(WHERE workflow.stage='pending_update')::int AS pending_update
    FROM special_stock_workflow_stages workflow JOIN sales_stock_requests request ON request.id=workflow.request_id
    WHERE request.requested_by=$1 AND request.destination_location_id=ANY($2::bigint[])
      AND workflow.stage IN ('await_customer_confirmation','dispatch_arrangement','wait_for_production','pending_update')`,[operatorId,authorizedStoreLocationIds]);
  return {awaitCustomerConfirmation:row.confirmation,dispatchArrangement:row.dispatch,waitForProduction:row.production,
    pendingUpdate:row.pending_update,total:row.confirmation+row.dispatch+row.production+row.pending_update};
}
