import {query,withTransaction} from './db.js';
import {canConvertStockingToBackorder,stockingBackorderMaterials} from '../public/stocking-backorder-conversion.js';
import {createBackorderCaseForStocking} from './special-stock-request-repository.js';
import {getBackorderRequest} from './backorder-request-service.js';
import {minimumSpecialCaseRequiredDate} from './special-stock-request-domain.js';
import {torontoDate} from '../public/special-stock-workflow.js';
import {STOCK_REQUEST_YARDS} from './stock-request-domain.js';

/** @param {string} message */
const locked=message=>Object.assign(new Error(message),{status:409,code:'STOCKING_BACKORDER_LOCKED'});
/** @param {unknown} value */
function id(value) {
  if (!['number','string'].includes(typeof value) || !/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw Object.assign(new Error('A valid request ID and revision are required.'),{status:400,code:'STOCKING_BACKORDER_INVALID'});
  }
  return Number(value);
}
/** @param {{operatorId?:string,audience?:string}} context */
function assertScm(context) {
  if (context.audience!=='scm' || !context.operatorId) throw Object.assign(new Error('Only SCM can convert Stocking requests.'),{status:403,code:'STOCKING_BACKORDER_FORBIDDEN'});
}
/** @param {number} requestId @param {number|undefined} [revision] */
async function loadConvertible(requestId,revision) {
  const request=(await query('SELECT * FROM sales_stock_requests WHERE id=$1 FOR UPDATE',[requestId])).rows[0];
  if (!request) throw Object.assign(new Error('Stocking request was not found.'),{status:404,code:'STOCK_REQUEST_NOT_FOUND'});
  if (revision!==undefined && Number(request.revision)!==revision) throw Object.assign(new Error('This request changed. Refresh before converting.'),{status:409,code:'STOCK_REQUEST_REVISION_CONFLICT'});
  const lines=/** @type {Array<Record<string,any>>} */ ((await query('SELECT * FROM sales_stock_request_lines WHERE request_id=$1 ORDER BY id FOR UPDATE',[requestId])).rows);
  if (!canConvertStockingToBackorder({requestType:request.request_type,workflowVersion:Number(request.workflow_version),status:request.status,regular:request.regular_details,lines})) {
    throw locked('Only an entirely open, uncommitted Stocking request can convert to Backorder.');
  }
  const commitment=await query(`SELECT 1 WHERE
    EXISTS(SELECT 1 FROM sales_special_stock_cases WHERE request_id=$1)
    OR EXISTS(SELECT 1 FROM sales_stock_transfers WHERE request_id=$1)
    OR EXISTS(SELECT 1 FROM sales_stock_transfer_lines t JOIN sales_stock_request_lines l ON l.id=t.request_line_id WHERE l.request_id=$1)
    OR EXISTS(SELECT 1 FROM regular_stock_purchase_demands d JOIN sales_stock_request_lines l ON l.id=d.request_line_id WHERE l.request_id=$1)
    OR EXISTS(SELECT 1 FROM regular_stock_replenishment_requests d JOIN sales_stock_request_lines l ON l.id=d.request_line_id WHERE l.request_id=$1)
    OR EXISTS(SELECT 1 FROM regular_stock_handoffs WHERE request_id=$1)
    OR EXISTS(SELECT 1 FROM regular_stock_so_line_owners WHERE request_id=$1)`,[requestId]);
  if (commitment.rowCount) throw locked('This request is already committed to PO/TO processing.');
  const items=/** @type {Array<Record<string,any>>} */ ((await query('SELECT * FROM inventory_items WHERE item_id=ANY($1::bigint[]) FOR SHARE',[lines.map(line=>Number(line.item_id))])).rows);
  return {request,lines,items:new Map(items.map(item=>[Number(item.item_id),item]))};
}
/** @param {number|string} requestId @param {{operatorId:string,audience:string}} context */
export async function previewStockingBackorderConversion(requestId,context) {
  assertScm(context);
  return withTransaction(async()=>{
    const {request,lines,items}=await loadConvertible(id(requestId));
    return {id:Number(request.id),requestRef:request.request_ref,revision:Number(request.revision),customerName:request.regular_details.customerName || '',remarks:request.remarks,
      fulfillmentMethod:'yard_pickup',requiredDate:minimumSpecialCaseRequiredDate(),
      lines:lines.map(line=>({stockingLineId:Number(line.id),itemName:line.item_name,description:line.item_description || '',quantity:Number(line.sales_qty),uom:line.sales_uom,
        vendorName:items.get(Number(line.item_id))?.vendor || '',destinationLocationId:Number(line.destination_location_id),destinationName:line.destination_name}))};
  });
}
/** @param {number|string} requestId @param {Record<string,any>} input @param {{operatorId:string,audience:string}} context */
export async function convertStockingToBackorder(requestId,input,context) {
  assertScm(context);const selected=id(requestId),revision=id(input.expectedRevision);
  if (!['yard_pickup','mbt_delivery'].includes(input.fulfillmentMethod)) throw Object.assign(new Error('Select Pickup or Delivery.'),{status:400,code:'STOCKING_BACKORDER_INVALID'});
  await withTransaction(async()=>{
    const {request,lines,items}=await loadConvertible(selected,revision);
    const storeId=Number(request.regular_details.requestingLocationId ?? request.destination_location_id);
    const yard=STOCK_REQUEST_YARDS.find(entry=>entry.locationId===storeId);
    if (!yard) throw locked('The original requesting Sales yard is unavailable.');
    const materials=stockingBackorderMaterials(lines,items,{requiredDate:input.requiredDate || minimumSpecialCaseRequiredDate(),vendors:input.vendors});
    const originalDecisionReads=(await query('SELECT * FROM regular_stock_decision_reads WHERE request_id=$1 FOR UPDATE',[selected])).rows;
    // Only fulfillment and vendor confirmation are editable during conversion.
    const fulfillment=Object.fromEntries(['fulfillmentMethod','deliveryAddress','deliveryContactName','deliveryContactPhone','deliveryDate','windowStart','windowEnd','deliveryInstructions'].map(key=>[key,input[key]]));
    // Retire Stocking rows before switching the profile: Backorder's database
    // guard correctly rejects subsequent Stocking-line updates.
    await query("UPDATE sales_stock_request_lines SET status='cancelled',updated_at=now() WHERE request_id=$1",[selected]);
    await createBackorderCaseForStocking(selected,{...fulfillment,storeLocationId:storeId,inquiryDate:torontoDate(),customerName:request.regular_details.customerName || '',
      customerPhone:request.regular_details.customerPhone || '',remarks:request.remarks,salesInternalRemark:request.regular_details.salesInternalRemark || '',
      vendorName:materials[0].brand,vendorId:materials[0].regularVendorId,lines:materials},
    {operatorId:context.operatorId,authorizedStoreLocationIds:[storeId]});
    const convertedAt=new Date().toISOString();
    await query(`UPDATE sales_stock_requests SET regular_details=$2::jsonb,destination_location_id=$3,destination_name=$4,
      status='submitted',revision=revision+1,manual_decision_event_id=0,updated_at=now() WHERE id=$1`,
    [selected,JSON.stringify({deliveryMethod:'backorder',customerName:request.regular_details.customerName || '',stockingConversion:{stockingType:request.regular_details.stockingType || 'transfer',
      convertedAt,convertedBy:context.operatorId,originalDestinationLocationId:Number(request.destination_location_id),originalRegular:request.regular_details,
      originalLineStatuses:Object.fromEntries(lines.map(line=>[line.id,line.status])),originalDecisionReads}}),storeId,yard.yardCode]);
    // Stocking reads use event IDs; Backorder reads use request revisions.
    // Keep the original acknowledgements in the audit snapshot and restart
    // their read state for the newly initialized workflow.
    await query('DELETE FROM regular_stock_decision_reads WHERE request_id=$1',[selected]);
  });
  return getBackorderRequest(selected,{audience:'scm'});
}
