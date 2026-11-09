import { query } from './db.js';

const SALES_ALERT_STAGES=['await_customer_confirmation','dispatch_arrangement','waiting_customer_pickup','wait_for_production','pending_update'];

export async function getSpecialStockAlertCounts({includeRequests=false} = {}) {
  const { rows: [row] } = await query(`
    SELECT count(*) FILTER (WHERE stage = 'new_enquiry')::integer AS new_requests,
           count(*) FILTER (WHERE stage = 'confirmed')::integer AS confirmed_orders
      FROM special_stock_workflow_stages
     WHERE stage IN ('new_enquiry', 'confirmed') AND request_id IN (SELECT request_id FROM sales_special_stock_cases WHERE workflow_kind='special')`);
  const newRequests = Number(row.new_requests);
  const confirmedOrders = Number(row.confirmed_orders);
  return { newRequests, confirmedOrders, total: newRequests + confirmedOrders,
    ...(includeRequests ? {requests:await specialAlertRequests({audience:'scm'})} : {}) };
}

export async function getSpecialSalesAlertCounts({operatorId,authorizedStoreLocationIds=[],includeRequests=false} = {}) {
  const empty={awaitCustomerConfirmation:0,dispatchArrangement:0,waitingCustomerPickup:0,waitForProduction:0,pendingUpdate:0,total:0};
  if (!operatorId || !authorizedStoreLocationIds.length) return {...empty,...(includeRequests ? {requests:[]} : {})};
  const {rows:[row]}=await query(`SELECT
    count(*) FILTER(WHERE workflow.stage='await_customer_confirmation')::int AS confirmation,
    count(*) FILTER(WHERE workflow.stage='dispatch_arrangement')::int AS dispatch,
    count(*) FILTER(WHERE workflow.stage='waiting_customer_pickup')::int AS customer_pickup,
    count(*) FILTER(WHERE workflow.stage='wait_for_production')::int AS production,
    count(*) FILTER(WHERE workflow.stage='pending_update')::int AS pending_update
    FROM special_stock_workflow_stages workflow JOIN sales_stock_requests request ON request.id=workflow.request_id
    WHERE request.request_type='special' AND request.requested_by=$1 AND request.destination_location_id=ANY($2::bigint[])
      AND workflow.stage=ANY($3::text[])`,[operatorId,authorizedStoreLocationIds,SALES_ALERT_STAGES]);
  return {awaitCustomerConfirmation:row.confirmation,dispatchArrangement:row.dispatch,waitingCustomerPickup:row.customer_pickup,waitForProduction:row.production,
    pendingUpdate:row.pending_update,total:row.confirmation+row.dispatch+row.customer_pickup+row.production+row.pending_update,
    ...(includeRequests ? {requests:await specialAlertRequests({audience:'sales',operatorId,authorizedStoreLocationIds})} : {})};
}

async function specialAlertRequests({audience,operatorId=undefined,authorizedStoreLocationIds=[]}) {
  const sales=audience==='sales';
  const {rows}=await query(`SELECT request.id,request.request_ref,special.customer_name,workflow.stage
    FROM special_stock_workflow_stages workflow JOIN sales_stock_requests request ON request.id=workflow.request_id
    JOIN sales_special_stock_cases special ON special.request_id=request.id
    WHERE request.request_type='special' AND special.workflow_kind='special'
      AND workflow.stage=ANY($1::text[])
      ${sales ? 'AND request.requested_by=$2 AND request.destination_location_id=ANY($3::bigint[])' : ''}
    ORDER BY request.updated_at DESC,request.id DESC`,
  [sales ? SALES_ALERT_STAGES : ['new_enquiry','confirmed'],
    ...(sales ? [operatorId,authorizedStoreLocationIds] : [])]);
  return rows.map(row=>({id:Number(row.id),requestRef:row.request_ref,customerName:row.customer_name,stage:row.stage}));
}
