import {query,withTransaction} from './db.js';
import {withBackorderWorkflow} from './stock-case-workflow.js';
import {assertBackorderNoAncillary,isBackorder,assertBackorderLineOpen} from '../public/backorder-workflow.js';
import {normalizeStockRequestQuantity,assertStockRequestDestinationAccess} from './stock-request-domain.js';
import {minimumSpecialCaseRequiredDate,normalizeSpecialFulfillment,normalizeSpecialCustomerName,normalizeSpecialAdditionalLines} from './special-stock-request-domain.js';
import {torontoDate} from '../public/special-stock-workflow.js';
import {normalizeSpecialRate,normalizeSpecialDiscount,specialDiscountLineSubtotal} from '../public/special-stock-pricing.js';
import {normalizeSpecialSalesInternalRemark} from '../public/special-stock-internal-remark.js';
import * as cases from './special-stock-request-repository.js';
import {backorderArrivalAlerts} from './backorder-arrival.js';
import {canAttachBackorderSalesOrder} from '../public/backorder-review-policy.js';
import {canAddBackorderItems} from '../public/backorder-add-items.js';

/** @typedef {import('../public/backorder-workflow.js').BackorderRequest} BackorderRequest */
/** @typedef {{operatorId:string,audience:string,authorizedStoreLocationIds?:number[]}} ActionContext */
/** @typedef {{operatorId:string,authorizedDestinationLocationIds:number[]}} SalesContext */
/** @param {string} message */
const invalid=(message,code='BACKORDER_INVALID',status=400)=>Object.assign(new Error(message),{code,status});
/** @param {Record<string,any>} request */
export function assertRegularNotBackorder(request) {
  if (isBackorder(request)) throw invalid('Use the Backorder case actions for this request.','BACKORDER_WORKFLOW_ONLY',409);
}
/** @param {number|string} id @param {{audience?:string,authorizedStoreLocationIds?:number[],dispatchPlans?:any[]}} [options] @returns {Promise<BackorderRequest>} */
export const getBackorderRequest=(id,options={})=>withBackorderWorkflow(async()=>/** @type {BackorderRequest} */ (await cases.getSpecialStockCase(id,options)));
/** @param {Record<string,any>} options */
export const listBackorderRequests=options=>withBackorderWorkflow(()=>cases.listSpecialStockCases(options));
/** @param {{scm?:boolean,operatorId?:string,authorizedDestinationLocationIds?:number[],includeRequests?:boolean}} [options] */
export async function backorderAlerts({scm=false,operatorId,authorizedDestinationLocationIds=[],includeRequests=false}={}) {
  if (scm) {
    const rows=(await query(`SELECT ${includeRequests ? 'request.id,request.request_ref' : 'count(*)::int AS n'} FROM special_stock_workflow_stages stage
      JOIN sales_special_stock_cases special ON special.request_id=stage.request_id
      ${includeRequests ? 'JOIN sales_stock_requests request ON request.id=stage.request_id' : ''}
      WHERE special.workflow_kind='backorder' AND stage.stage NOT IN ('closed','completed') AND (
        EXISTS(SELECT 1 FROM sales_special_stock_lines review WHERE review.request_id=special.request_id
          AND review.supply_status IS DISTINCT FROM 'already_ordered' AND review.sales_decision NOT IN ('declined','closed') AND (review.supply_status IS NULL OR review.sales_decision='request_update')) OR
        (stage.stage IN ('confirmed','dispatch_arrangement','wait_for_production') AND EXISTS(SELECT 1 FROM sales_special_stock_lines line
          WHERE line.request_id=special.request_id AND line.sales_decision='accepted' AND line.reminder_due_date<=(now() AT TIME ZONE 'America/Toronto')::date)))`)).rows;
    return {manualReview:includeRequests ? rows.length : Number(rows[0].n),requests:includeRequests
      ? rows.map(row=>({id:Number(row.id),requestRef:row.request_ref,message:'Backorder — SCM review required'})) : []};
  }
  if (!operatorId || !authorizedDestinationLocationIds.length) return {manualReview:0,requests:[]};
  const rows=(await query(`SELECT request.id,request.request_ref,notice.revision,stage.stage,
      special.purchase_order_ref,review.needs_reply
    FROM sales_stock_requests request JOIN sales_special_stock_cases special ON special.request_id=request.id
    JOIN special_stock_workflow_stages stage ON stage.request_id=request.id
    LEFT JOIN regular_stock_decision_reads seen ON seen.request_id=request.id AND seen.operator_id=$1
    CROSS JOIN LATERAL (SELECT EXISTS(SELECT 1 FROM sales_special_stock_lines line WHERE line.request_id=request.id
      AND line.supply_status IS NOT NULL AND line.supply_status <> 'already_ordered' AND line.sales_decision NOT IN ('accepted','declined','closed')) AS needs_reply) review
    LEFT JOIN LATERAL (SELECT (event.details->>'requestRevision')::bigint AS revision,event.created_at
      FROM sales_special_stock_events event WHERE event.request_id=request.id AND event.event_type='special_purchase_order_linked'
      ORDER BY event.id DESC LIMIT 1) po_link ON true
    CROSS JOIN LATERAL (SELECT CASE WHEN stage.stage IN ('confirmed','dispatch_arrangement') AND special.purchase_order_netsuite_id IS NOT NULL AND NOT review.needs_reply
      THEN COALESCE(po_link.revision,CASE WHEN po_link.created_at<=seen.read_at THEN seen.event_id ELSE request.revision END)
      ELSE request.revision END AS revision) notice
    WHERE special.workflow_kind='backorder' AND request.requested_by=$1 AND request.destination_location_id=ANY($2::bigint[])
      AND stage.stage NOT IN ('closed','completed') AND (special.purchase_order_netsuite_id IS NOT NULL OR stage.stage IN ('await_customer_confirmation','pending_update','wait_for_production','dispatch_arrangement')
        OR review.needs_reply)
      AND notice.revision>COALESCE(seen.event_id,0) ORDER BY request.updated_at DESC LIMIT 200`,[operatorId,authorizedDestinationLocationIds])).rows;
  const arrivals=await backorderArrivalAlerts(operatorId,authorizedDestinationLocationIds);
  return {manualReview:0,requests:[...arrivals,...rows.map(/** @param {Record<string,any>} row */ row=>({id:Number(row.id),requestRef:row.request_ref,eventId:Number(row.revision),action:'backorder',purchaseOrderRef:row.purchase_order_ref || null,
    message:['confirmed','dispatch_arrangement'].includes(row.stage) && row.purchase_order_ref && !row.needs_reply ? 'Backorder · PO linked: '+row.purchase_order_ref : 'Backorder · '+row.stage.replaceAll('_',' ')}))]};
}
/** @param {number|string} id @param {unknown} eventId @param {SalesContext} context @param {unknown} [arrivalKey] @param {unknown} [poNoticeKeys] */
export async function acknowledgeBackorderAlert(id,eventId,context,arrivalKey,poNoticeKeys) {
  return withTransaction(async()=>{
    await query('SELECT id FROM sales_stock_requests WHERE id=$1 FOR UPDATE',[id]);
    const d=await getBackorderRequest(id,{audience:'sales',authorizedStoreLocationIds:context.authorizedDestinationLocationIds});
    if (d.requestedBy!==context.operatorId) throw invalid('Only the requester can acknowledge this update.','BACKORDER_ALERT_FORBIDDEN',403);
    if (!Number.isSafeInteger(Number(eventId)) || Number(eventId)<=0 || Number(eventId)>d.revision) throw invalid('That revision was not displayed for this request.');
    if (arrivalKey!==undefined) {
      if (typeof arrivalKey!=='string' || !/^[a-f0-9]{64}$/.test(arrivalKey)) throw invalid('That receipt was not displayed for this request.');
      if (arrivalKey!==d.alreadyOrderedArrival?.key) throw invalid('Receipt progress changed. Refresh the request.','BACKORDER_ARRIVAL_CHANGED',409);
    }
    if (poNoticeKeys!==undefined) {
      if (!Array.isArray(poNoticeKeys) || poNoticeKeys.length>2*d.lines.length
        || poNoticeKeys.some(key=>typeof key!=='string' || !/^[a-f0-9]{64}$/.test(key))) throw invalid('Those PO updates were not displayed for this request.');
      const current=new Set((d.poProgressNotices || []).map(notice=>notice.noticeKey));
      if (poNoticeKeys.some(key=>!current.has(key))) throw invalid('PO progress changed. Refresh the request.','BACKORDER_PO_PROGRESS_CHANGED',409);
      await query(`INSERT INTO backorder_po_alert_receipts(request_id,operator_id,notice_key)
        SELECT $1,$2,unnest($3::text[]) ON CONFLICT DO NOTHING`,[id,context.operatorId,[...new Set(poNoticeKeys)]]);
    }
    await query(`INSERT INTO regular_stock_decision_reads(request_id,operator_id,event_id,backorder_arrival_key) VALUES($1,$2,$3,COALESCE($4,''))
      ON CONFLICT(request_id,operator_id) DO UPDATE SET event_id=GREATEST(regular_stock_decision_reads.event_id,EXCLUDED.event_id),read_at=now(),
      backorder_arrival_key=CASE WHEN $4::text IS NULL THEN regular_stock_decision_reads.backorder_arrival_key ELSE EXCLUDED.backorder_arrival_key END`,[id,context.operatorId,eventId,arrivalKey ?? null]);
    return {acknowledged:true,eventId:Number(eventId)};
  });
}

/** @param {Record<string,any>} input @param {{vendorName:string,vendorId?:unknown,destinationLocationId:unknown}} defaults @param {number[]} yards */
function lineRouting(input,defaults,yards) {
  const vendorName=String(input.vendorName ?? defaults.vendorName).trim();
  if (!vendorName || vendorName.length>200) throw invalid('Enter a vendor for each material (up to 200 characters).');
  const sameVendor=vendorName.toLowerCase()===defaults.vendorName.trim().toLowerCase();
  const rawId=input.vendorId===undefined?(sameVendor?defaults.vendorId:null):input.vendorId;
  const vendorId=rawId==null || rawId===''?null:Number(rawId);
  if (vendorId!==null && (!Number.isSafeInteger(vendorId)||vendorId<=0)) throw invalid('Material vendor ID must be a positive integer.');
  const destinationLocationId=assertStockRequestDestinationAccess(input.destinationLocationId ?? defaults.destinationLocationId,yards);
  return {brand:vendorName,regularVendorId:vendorId,destinationLocationId};
}
/** @param {Array<Record<string,any>>} lines @param {Record<string,any>} input @param {SalesContext} context */
async function regularMaterials(lines,input,context) {
  if (!Array.isArray(lines) || !lines.length || lines.length>100) throw invalid('Select 1 to 100 regular materials.');
  const ids=lines.map(line=>Number(line?.itemId));
  if (ids.some(id=>!Number.isSafeInteger(id)||id<=0||[1784,1987,2055].includes(id))) throw invalid('Select a regular stock material.');
  const rows=(await query('SELECT * FROM inventory_items WHERE item_id=ANY($1::bigint[]) FOR SHARE',[ids])).rows;
  const byId=new Map(rows.map(/** @param {Record<string,any>} row */ row=>[Number(row.item_id),row]));
  return lines.map(line=>{
    const item=byId.get(Number(line.itemId));
    if (!item) throw invalid('Regular inventory item was not found.','BACKORDER_ITEM_NOT_FOUND',404);
    const quantity=normalizeStockRequestQuantity(line,item);
    return {...line,regularItemId:Number(item.item_id),regularItemCode:item.item_name,
      productName:item.display_name || item.item_name,detailSpec:line.detailSpec ?? item.item_description ?? '',
      ...lineRouting(line,{vendorName:item.vendor || input.vendorName || '',vendorId:item.vendor_id ?? (item.vendor===input.vendorName?input.vendorId:null),destinationLocationId:input.destinationLocationId},context.authorizedDestinationLocationIds),quantity:quantity.salesQty,uom:quantity.salesUom,
      palletQty:quantity.pallets,layerQty:quantity.layers,sectionQty:quantity.sections,pieceQty:quantity.pieces,
      requiredDate:line.requiredDate || minimumSpecialCaseRequiredDate()};
  });
}

/** @param {Record<string,any>} input @param {SalesContext} context */
export async function submitBackorderRequest(input,context) {
  assertBackorderNoAncillary(input);
  const storeLocationId=assertStockRequestDestinationAccess(input.destinationLocationId,context.authorizedDestinationLocationIds);
  return withTransaction(async()=>{
    const lines=await regularMaterials(input.lines,input,context);
    return withBackorderWorkflow(()=>cases.createSpecialStockCase({...input,storeLocationId,lines,
      inquiryDate:input.inquiryDate || torontoDate(),vendorName:input.vendorName || lines[0].brand,vendorId:input.vendorId || lines[0].regularVendorId || null},
      {operatorId:context.operatorId,authorizedStoreLocationIds:context.authorizedDestinationLocationIds}));
  });
}

/** @param {number|string} id @param {Record<string,any>} input @param {ActionContext} context */
async function lockLocalCase(id,input,context,{allowTerminal=false}={}) {
  const row=(await query(`SELECT request.revision,request.status,special.* FROM sales_stock_requests request
    JOIN sales_special_stock_cases special ON special.request_id=request.id
    WHERE request.id=$1 AND request.request_type='regular' AND special.workflow_kind='backorder' FOR UPDATE OF request,special`,[id])).rows[0];
  if (!row) throw invalid('Backorder request was not found.','BACKORDER_NOT_FOUND',404);
  if (!Number.isSafeInteger(Number(input.expectedRevision)) || Number(input.expectedRevision)!==Number(row.revision)) throw invalid('This request changed. Refresh it before saving.','BACKORDER_REVISION_CONFLICT',409);
  if (!allowTerminal && (row.status==='cancelled' || row.close_status!=='active' || row.operationally_complete)) throw invalid('This Backorder is closed or completed.','BACKORDER_CLOSED',409);
  const detail=await getBackorderRequest(id,{audience:context.audience,authorizedStoreLocationIds:context.authorizedStoreLocationIds});
  if (!allowTerminal && ['closed','completed'].includes(detail.stage)) throw invalid('This Backorder is closed or completed.','BACKORDER_CLOSED',409);
  return row;
}
/** @param {number|string} id @param {string} type @param {Record<string,any>} input @param {ActionContext} context @param {number|null} [lineId] */
async function localEvent(id,type,input,context,lineId=null) {
  await query('UPDATE sales_stock_requests SET revision=revision+1,updated_at=now() WHERE id=$1',[id]);
  await query(`INSERT INTO sales_special_stock_events(request_id,case_line_id,event_type,actor_id,details,audience)
    VALUES($1,$2,$3,$4,$5::jsonb,$6)`,[id,lineId,type,context.operatorId,JSON.stringify(input),type==='backorder_private_remark'?'sales':'all']);
}
/** @param {number|string} id @param {Record<string,any>} input @param {ActionContext} context */
async function addBackorderItems(id,input,context) {
  if (!context.operatorId) throw invalid('An authenticated Sales operator is required.','BACKORDER_ACTOR_REQUIRED',401);
  assertBackorderNoAncillary(input);
  await withTransaction(async()=>{
    const saved=await lockLocalCase(id,input,context);
    const detail=await getBackorderRequest(id,{audience:'sales',authorizedStoreLocationIds:context.authorizedStoreLocationIds || []});
    if (!canAddBackorderItems(detail)) throw invalid('Items can only be added to an active Backorder before order processing, up to 100 materials.','BACKORDER_ITEMS_LOCKED',409);
    if (!Array.isArray(input.lines) || input.lines.some(line=>!line || typeof line!=='object' || Array.isArray(line) || (line.id!==undefined && line.id!==null))) {
      throw invalid('Submit new material lines only.');
    }
    const existing=(await query('SELECT line_number FROM sales_special_stock_lines WHERE request_id=$1 ORDER BY line_number FOR UPDATE',[id])).rows;
    const materials=await regularMaterials(input.lines,{destinationLocationId:detail.destinationLocationId,vendorName:detail.vendorName,vendorId:detail.vendorId},
      {operatorId:context.operatorId,authorizedDestinationLocationIds:context.authorizedStoreLocationIds || []});
    const lines=normalizeSpecialAdditionalLines(materials,{existingLineCount:existing.length,workflowKind:'backorder'});
    const lastNumber=Math.max(...existing.map(line=>Number(line.line_number)));
    for (const [index,line] of lines.entries()) {
      await query(`INSERT INTO sales_special_stock_lines (
        request_id,line_number,brand,product_name,color,size,requested_quantity,requested_uom,required_date,
        estimate_line_reference,customer_note,original_unit_rate,original_rate_uom,pricing_source,
        quoted_discount_percent,discount_percent,scm_reviewed_quantity,detail_spec,
        pack_pallet_qty,pack_layer_qty,pack_section_qty,pack_piece_qty,regular_item_id,regular_item_code,
        backorder_vendor_id,backorder_destination_location_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$8,'enquiry',$13,$13,$7,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [id,lastNumber+index+1,line.brand,line.productName,line.color,line.size,line.quantity,line.uom,line.requiredDate,
        line.estimateLineReference,line.customerNote,line.rate,line.discountPercent,line.detailSpec,
        line.palletQty,line.layerQty,line.sectionQty,line.pieceQty,line.regularItemId,line.regularItemCode,line.regularVendorId,line.destinationLocationId]);
    }
    await query("DELETE FROM sales_special_stock_order_lines WHERE request_id=$1 AND order_kind='sales_order'",[id]);
    await query("UPDATE sales_special_stock_cases SET information_request='{}',line_edit_state='{}',updated_at=now() WHERE request_id=$1",[id]);
    await query("UPDATE sales_stock_requests SET status='submitted' WHERE id=$1",[id]);
    await localEvent(id,'backorder_items_added',{lineCount:lines.length,previousLineCount:existing.length,
      previousInformationRequest:saved.information_request,previousLineEditState:saved.line_edit_state},context);
  });
}
/** @param {number|string} id @param {Record<string,any>} input @param {ActionContext} context */
async function linkQuotation(id,input,context) {
  const number=typeof input.quotationNumber==='string'?input.quotationNumber.trim():'';
  if (!number || number.length>100) throw invalid('Enter the NetSuite quotation number (up to 100 characters).');
  await withTransaction(async()=>{
    await lockLocalCase(id,input,context,{allowTerminal:true});
    await query(`UPDATE sales_special_stock_cases SET
      estimate_netsuite_id=CASE WHEN estimate_ref IS NOT DISTINCT FROM $2 THEN estimate_netsuite_id ELSE NULL END,
      estimate_ref=$2,updated_at=now() WHERE request_id=$1`,[id,number]);
    await localEvent(id,'backorder_quotation_linked',{quotationNumber:number},context);
  });
}
/** @param {number|string} id @param {Record<string,any>} input @param {ActionContext} context */
async function attachAlreadyOrderedSalesOrder(id,input,context) {
  const salesOrderRef=orderedReference(input.salesOrderRef,'sales order number',120,true);
  await withTransaction(async()=>{
    const row=await lockLocalCase(id,input,context,{allowTerminal:true});
    if (row.close_status!=='active' || row.status==='cancelled') throw invalid('This Backorder is closed.','BACKORDER_CLOSED',409);
    const materials=(await query(`SELECT line.supply_status AS "supplyStatus",line.stock_checked_at AS "stockCheckedAt",
      line.responded_at AS "respondedAt",line.response_revision AS "responseRevision",stage.stage
      FROM sales_special_stock_lines line JOIN special_stock_workflow_stages stage ON stage.request_id=line.request_id
      WHERE line.request_id=$1 AND line.removed_at IS NULL`,[id])).rows;
    if (!canAttachBackorderSalesOrder({lines:materials,stage:materials[0]?.stage,status:row.status,
      closeStatus:row.close_status,operationallyComplete:row.operationally_complete})) {
      throw invalid('SCM must reply to every material before attaching an optional SO number.','BACKORDER_SCM_REVIEW_REQUIRED',409);
    }
    if (row.sales_order_netsuite_id && String(row.sales_order_ref || '').trim().toUpperCase()!==salesOrderRef.toUpperCase()) throw invalid('This request already has a different linked sales order.','BACKORDER_SO_CONFLICT',409);
    await query(`UPDATE sales_stock_requests SET regular_details=jsonb_set(regular_details,'{alreadyOrderedSalesOrderRef}',to_jsonb($2::text)) WHERE id=$1`,[id,salesOrderRef]);
    await acceptBackorderLinesForSalesOrder(id,salesOrderRef,context);
    await localEvent(id,materials.some(line=>line.supplyStatus==='already_ordered')
      ? 'backorder_already_ordered_so_attached' : 'backorder_sales_order_attached',{salesOrderRef},context);
  });
}

/** Caller holds the case lock; SO linking is Sales' customer acceptance of the current SCM response.
 * @param {number|string} id @param {string} salesOrderRef @param {ActionContext} context */
async function acceptBackorderLinesForSalesOrder(id,salesOrderRef,context) {
  const accepted=await query(`UPDATE sales_special_stock_lines SET sales_decision='accepted',
    sales_decision_reason=$2,decision_revision=decision_revision+1,decided_by=$3,decided_at=now(),updated_at=now()
    WHERE request_id=$1 AND removed_at IS NULL AND sales_decision IN ('pending','request_update')
      AND supply_status IS NOT NULL AND (stock_checked_at IS NOT NULL OR responded_at IS NOT NULL OR response_revision>0)
    RETURNING id,response_revision`,[id,`Customer acceptance confirmed by Sales linking ${salesOrderRef}.`,context.operatorId]);
  if(accepted.rowCount)await query(`INSERT INTO sales_special_stock_events(request_id,event_type,actor_id,details,audience)
    VALUES($1,'backorder_so_customer_accepted',$2,$3::jsonb,'all')`,
    [id,context.operatorId,JSON.stringify({salesOrderRef,lines:accepted.rows.map(row=>({lineId:Number(row.id),responseRevision:Number(row.response_revision)}))})]);
}
/** @param {number|string} id @param {Record<string,any>} input @param {ActionContext} context */
async function closeLocally(id,input,context) {
  const reason=String(input.reason || '').trim();
  if (!reason || reason.length>2000) throw invalid('Enter a closure reason of at most 2000 characters.');
  await withTransaction(async()=>{
    await lockLocalCase(id,input,context);
    await query(`UPDATE sales_special_stock_cases SET close_status='closed',closure_reason=$2,closed_at=now(),
      closure_requested_by=$3,closure_requested_at=now(),updated_at=now() WHERE request_id=$1`,[id,reason,context.operatorId]);
    await query("UPDATE sales_stock_requests SET status='cancelled' WHERE id=$1",[id]);
    await localEvent(id,'backorder_closed',{reason},context);
  });
}
/** @param {number|string} id @param {Record<string,any>} input @param {ActionContext} context */
async function updateLocalHeader(id,input,context) {
  assertBackorderNoAncillary(input);
  await withTransaction(async()=>{
    await lockLocalCase(id,input,context);
    const before=await getBackorderRequest(id,{audience:'sales',authorizedStoreLocationIds:context.authorizedStoreLocationIds});
    const fulfillment=/** @type {Record<string,any>} */ (normalizeSpecialFulfillment({...before,...input}));
    const note=String(input.remarks ?? before.remarks).trim(), customerName=normalizeSpecialCustomerName(input.customerName === undefined ? before.customerName : input.customerName);
    if (note.length>8000) throw invalid('The request note is too long.');
    const privateNote=normalizeSpecialSalesInternalRemark(input.salesInternalRemark ?? before.salesInternalRemark);
    await query(`UPDATE sales_special_stock_cases SET customer_name=$2,customer_phone=$3,fulfillment_method=$4,
      delivery_address=$5,delivery_contact_name=$6,delivery_contact_phone=$7,delivery_date=$8,
      delivery_window_start=$9,delivery_window_end=$10,delivery_instructions=$11,sales_internal_remark=$12,updated_at=now()
      WHERE request_id=$1`,[id,customerName,String(input.customerPhone ?? before.customerPhone).slice(0,100),fulfillment.fulfillmentMethod,
      fulfillment.deliveryAddress,fulfillment.deliveryContactName,fulfillment.deliveryContactPhone,fulfillment.deliveryDate,
      fulfillment.windowStart,fulfillment.windowEnd,fulfillment.deliveryInstructions,privateNote]);
    await query("UPDATE sales_stock_requests SET remarks=$2,regular_details=regular_details||jsonb_build_object('customerName',$3::text) WHERE id=$1",[id,note,customerName]);
    await localEvent(id,'backorder_header_updated',{fulfillmentMethod:fulfillment.fulfillmentMethod,remarks:note,customerName},context);
  });
}
/** @param {number|string} id @param {number} lineId @param {Record<string,any>} input @param {ActionContext} context */
async function editLocalLine(id,lineId,input,context) {
  assertBackorderNoAncillary(input);
  await withTransaction(async()=>{
    await lockLocalCase(id,input,context);
    const line=(await query('SELECT * FROM sales_special_stock_lines WHERE request_id=$1 AND id=$2 FOR UPDATE',[id,lineId])).rows[0];
    if (!line) throw invalid('This material does not belong to the Backorder.','BACKORDER_LINE_NOT_FOUND',404);
    assertBackorderLineOpen(line.supply_status);
    const quantity=input.quantity===undefined?Number(line.requested_quantity):Number(input.quantity);
    const productName=String(input.productName ?? line.product_name).trim(), detailSpec=String(input.detailSpec ?? line.detail_spec).trim(), note=String(input.customerNote ?? line.customer_note).trim();
    if (!Number.isFinite(quantity)||quantity<=0||quantity>1e9||!productName||productName.length>500||detailSpec.length>2000||note.length>4000) throw invalid('Enter a positive material quantity and valid description.');
    const rawRate=input.rate===undefined?line.original_unit_rate:input.rate;
    const rate=rawRate==null || rawRate===''?null:normalizeSpecialRate(rawRate);
    const discount=normalizeSpecialDiscount(input.discountPercent===undefined?line.quoted_discount_percent:input.discountPercent);
    if(rate!==null)specialDiscountLineSubtotal(quantity,rate,discount);
    const currentDestination=Number(line.backorder_destination_location_id);
    const keepingDestination=input.destinationLocationId===undefined || ['string','number'].includes(typeof input.destinationLocationId) && String(input.destinationLocationId).trim()===String(currentDestination);
    const routingYards=keepingDestination?[...(context.authorizedStoreLocationIds || []),currentDestination]:context.authorizedStoreLocationIds || [];
    const routing=lineRouting(input,{vendorName:line.response_vendor_name || line.brand,vendorId:line.response_vendor_id ?? line.backorder_vendor_id,destinationLocationId:currentDestination},routingYards);
    const previousVendor=line.response_vendor_id ?? line.backorder_vendor_id;
    const previousVendorId=previousVendor==null?null:Number(previousVendor);
    const vendorChanged=routing.brand!==line.brand || routing.regularVendorId!==previousVendorId;
    await query("SELECT set_config('mbbs.backorder_case_edit_request',$1,true)",[String(id)]);
    await query(`UPDATE sales_special_stock_lines SET requested_quantity=$3,product_name=$4,detail_spec=$5,customer_note=$6,original_unit_rate=$7,quoted_discount_percent=$8,discount_percent=$8,
      supply_status=NULL,sales_decision='pending',available_date=NULL,availability_mode=NULL,reminder_due_date=NULL,
      brand=$9,backorder_vendor_id=$10,backorder_destination_location_id=$12,
      response_vendor_id=CASE WHEN $11 THEN NULL ELSE response_vendor_id END,
      response_vendor_name=CASE WHEN $11 THEN '' ELSE response_vendor_name END,
      unit_purchase_cost=CASE WHEN $11 THEN NULL ELSE unit_purchase_cost END,
      response_revision=response_revision+1,decision_revision=decision_revision+1,stock_checked_at=NULL,updated_at=now()
      WHERE request_id=$1 AND id=$2`,[id,lineId,quantity,productName,detailSpec,note,rate,discount,routing.brand,routing.regularVendorId,vendorChanged,routing.destinationLocationId]);
    await localEvent(id,'backorder_material_updated',{from:{quantity:Number(line.requested_quantity),productName:line.product_name,vendorName:line.brand,destinationLocationId:Number(line.backorder_destination_location_id)},to:{quantity,productName,detailSpec,customerNote:note,rate,discountPercent:discount,vendorName:routing.brand,vendorId:routing.regularVendorId,destinationLocationId:routing.destinationLocationId}},context,lineId);
  });
}

/** @param {unknown} value @param {string} label @param {number} limit @param {boolean} required */
function orderedReference(value,label,limit,required) {
  const text=value==null && !required?'':value;
  if (typeof text!=='string' || (required && !text.trim()) || text.trim().length>limit || /[\u0000-\u001f\u007f]/.test(text)) {
    throw invalid(`Enter ${label}${required?' (required)':''}, up to ${limit} characters without control characters.`,'BACKORDER_PO_REFERENCE_INVALID');
  }
  return text.trim();
}

/** @param {number|string} id @param {number} lineId @param {Record<string,any>} input @param {ActionContext} context */
async function markAlreadyOrdered(id,lineId,input,context) {
  const poNumber=orderedReference(input.poNumber,'PO number',120,true);
  const poRefNumber=orderedReference(input.poRefNumber,'PO ref number',200,false);
  await withTransaction(async()=>{
    await lockLocalCase(id,input,context);
    const line=(await query('SELECT * FROM sales_special_stock_lines WHERE request_id=$1 AND id=$2 FOR UPDATE',[id,lineId])).rows[0];
    if (!line) throw invalid('This material does not belong to the Backorder.','BACKORDER_LINE_NOT_FOUND',404);
    assertBackorderLineOpen(line.supply_status);
    await query(`UPDATE sales_special_stock_lines SET supply_status='already_ordered',
      backorder_po_number=$3,backorder_po_ref_number=$4,availability_mode=NULL,available_date=NULL,reminder_due_date=NULL,
      stock_checked_at=now(),stock_checked_by=$5,responded_at=now(),responded_by=$5,response_revision=response_revision+1,
      po_ready=false,po_ready_by=NULL,po_ready_at=NULL,po_ready_response_revision=NULL,updated_at=now()
      WHERE request_id=$1 AND id=$2`,[id,lineId,poNumber,poRefNumber,context.operatorId]);
    await query('UPDATE sales_stock_requests SET first_scm_decision_at=COALESCE(first_scm_decision_at,now()) WHERE id=$1',[id]);
    await query('UPDATE sales_special_stock_cases SET updated_at=now() WHERE request_id=$1',[id]);
    await localEvent(id,'backorder_already_ordered',{poNumber,poRefNumber,previousSupplyStatus:line.supply_status},context,lineId);
  });
}

/** @param {number|string} id @param {number} lineId @param {Record<string,any>} input @param {ActionContext} context */
async function completeBackorderFromYard(id,lineId,input,context) {
  await withTransaction(async()=>{
    const row=await lockLocalCase(id,input,context);
    if(row.purchase_order_netsuite_id || row.purchase_order_ref
      || (await query('SELECT 1 FROM sales_special_stock_handoffs WHERE request_id=$1',[id])).rowCount)
      throw invalid('Purchasing or dispatch has already started for this request.','BACKORDER_YARD_STOCK_LOCKED',409);
    const line=(await query('SELECT * FROM sales_special_stock_lines WHERE request_id=$1 AND id=$2 AND removed_at IS NULL FOR UPDATE',[id,lineId])).rows[0];
    if(!line)throw invalid('Material not found.','BACKORDER_LINE_NOT_FOUND',404);
    if(line.supply_status==='already_ordered'||['closed','declined'].includes(line.sales_decision))
      throw invalid('This material is already completed or closed.','BACKORDER_LINE_COMPLETED',409);
    const yardStock={destinationLocationId:Number(line.backorder_destination_location_id),completedBy:context.operatorId,completedAt:new Date().toISOString()};
    await query(`UPDATE sales_stock_requests SET regular_details=jsonb_set(regular_details,'{yardStockLines}',
      COALESCE(regular_details->'yardStockLines','{}'::jsonb)||jsonb_build_object($2::text,$3::jsonb)),
      first_scm_decision_at=COALESCE(first_scm_decision_at,now()) WHERE id=$1`,[id,String(lineId),JSON.stringify(yardStock)]);
    await query(`UPDATE sales_special_stock_lines SET sales_decision='closed',sales_decision_reason='Stock available at destination yard. No purchase required.',
      decided_by=$3,decided_at=now(),decision_revision=decision_revision+1,po_ready=false,po_ready_by=NULL,po_ready_at=NULL,po_ready_response_revision=NULL,updated_at=now()
      WHERE request_id=$1 AND id=$2`,[id,lineId,context.operatorId]);
    await localEvent(id,'backorder_yard_stock_completed',yardStock,context,lineId);
  });
}

/** @param {number|string} id @param {string} action @param {Record<string,any>} input @param {ActionContext} context */
export async function runBackorderAction(id,action,input,context) {
  return withBackorderWorkflow(async()=>{
    // Resolve persisted identity and scope before selecting a capability.
    const detail = await cases.getSpecialStockCase(id,{audience:context.audience,authorizedStoreLocationIds:context.authorizedStoreLocationIds});
    if (action==='items') {
      if (context.audience!=='sales') throw invalid('Sales must add the new materials.','BACKORDER_ROLE_FORBIDDEN',403);
      await addBackorderItems(id,input,context);
      return cases.getSpecialStockCase(id,{audience:'sales',authorizedStoreLocationIds:context.authorizedStoreLocationIds});
    }
    if (action==='already-ordered/sales-order') {
      if (context.audience!=='sales') throw invalid('Sales must attach the sales order number.','BACKORDER_ROLE_FORBIDDEN',403);
      await attachAlreadyOrderedSalesOrder(id,input,context);
      return cases.getSpecialStockCase(id,{audience:context.audience,authorizedStoreLocationIds:context.authorizedStoreLocationIds});
    }
    if (context.audience==='sales' && action==='quotation/link') {
      await linkQuotation(id,input,context);
      return cases.getSpecialStockCase(id,{audience:context.audience,authorizedStoreLocationIds:context.authorizedStoreLocationIds});
    }
    if (['closed','completed'].includes(detail.stage)) throw invalid('This Backorder is closed or completed.','BACKORDER_CLOSED',409);
    const line=action.match(/^lines\/(\d+)\/(response|decision|readiness|edit|yard-stock)$/);
    const role=context.audience;
    if (line) {
      const [,lineId,kind]=line;
      if ((role==='sales') !== ['decision','edit'].includes(kind)) throw invalid('This action requires the other request role.','BACKORDER_ROLE_FORBIDDEN',403);
      if(detail.lines.some(row=>row.id===Number(lineId)&&row.yardStock))throw invalid('This material is completed with stock at the destination yard.','BACKORDER_LINE_COMPLETED',409);
      if (kind==='yard-stock') await completeBackorderFromYard(id,Number(lineId),input,context);
      else if (kind==='edit') await editLocalLine(id,Number(lineId),input,context);
      else if (kind==='response' && input.supplyStatus==='already_ordered') await markAlreadyOrdered(id,Number(lineId),input,context);
      else if (kind==='response') await cases.respondSpecialStockLine(id,lineId,input,context);
      else if (kind==='decision') await cases.decideSpecialStockLine(id,lineId,{...input,itemResolution:null},context);
      else await cases.checkSpecialStockReadiness(id,lineId,input,context);
    } else if (role==='sales' && action==='sales-order/link') {
      await withTransaction(async()=>{
        await lockLocalCase(id,input,context);
        await acceptBackorderLinesForSalesOrder(id,input.salesOrderRef,context);
        await cases.linkSpecialSalesOrder(id,{expectedRevision:input.expectedRevision,salesOrderRef:input.salesOrderRef,salesOrderId:input.salesOrderId,source:'manual_link'},context);
      });
    } else if (role==='scm' && action==='purchase-order/link') {
      await cases.linkSpecialPurchaseOrder(id,{expectedRevision:input.expectedRevision,purchaseOrderRef:input.purchaseOrderRef,purchaseOrderId:input.purchaseOrderId,
        purchaseOrderSplitId:input.purchaseOrderSplitId,customLinkage:true},context);
    } else if (action==='close') await closeLocally(id,input,context);
    else if (role==='sales' && action==='header') await updateLocalHeader(id,input,context);
    else if (role==='sales' && action==='vendor-pickup/complete') await cases.completeSpecialVendorPickup(id,input,context);
    else if (role==='scm' && action==='information/request') await cases.requestSpecialStockInformation(id,input,context);
    else if (role==='sales' && action==='information/submit') await cases.submitSpecialStockInformation(id,input,context);
    else if (role==='scm' && action==='changes/acknowledge') await cases.acknowledgeSpecialPostPoChange(id,input,context);
    else throw invalid('This Backorder action is unavailable.','BACKORDER_ACTION_FORBIDDEN',409);
    return cases.getSpecialStockCase(id,{audience:role,authorizedStoreLocationIds:context.authorizedStoreLocationIds});
  });
}
