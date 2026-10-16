import {query} from './db.js';

const supply = {in_stock:'In stock',low_inventory:'Low inventory',vendor_transfer:'Vendor transfer',
  production:'Production',allocation:'Allocation',no_stock:'No stock',already_ordered:'Already Ordered · Completed'};

/** @param {{operatorId?:string,authorizedDestinationLocationIds?:number[]}} context */
export async function salesStockCheckNotices({operatorId,authorizedDestinationLocationIds=[]}) {
  if(!operatorId||!authorizedDestinationLocationIds.length)return [];
  const rows=(await query(`SELECT request.id,request.request_ref,request.request_type,event.id AS event_id,
      event.created_at,line.product_name,line.regular_item_code,line.supply_status,line.available_date,
      line.backorder_po_number,line.sales_visible_note
    FROM sales_stock_requests request
    JOIN LATERAL (SELECT id,case_line_id,created_at FROM sales_special_stock_events
      WHERE request_id=request.id AND event_type IN ('special_supply_response_saved','special_stock_readiness_checked','backorder_already_ordered')
      ORDER BY id DESC LIMIT 1) event ON true
    JOIN sales_special_stock_lines line ON line.id=event.case_line_id AND line.request_id=request.id
    WHERE request.requested_by=$1 AND request.destination_location_id=ANY($2::bigint[])
    ORDER BY event.id DESC LIMIT 200`,[operatorId,authorizedDestinationLocationIds])).rows;
  return rows.map(row=>({id:Number(row.id),requestRef:row.request_ref,eventId:Number(row.event_id),action:'stock_check',
    special:row.request_type==='special',createdAt:row.created_at,
    message:[row.regular_item_code||row.product_name,supply[row.supply_status]||row.supply_status,
      row.available_date?`ETA: ${row.available_date instanceof Date ? row.available_date.toISOString().slice(0,10) : String(row.available_date).slice(0,10)}`:'',
      row.backorder_po_number?`PO: ${row.backorder_po_number}`:'',row.sales_visible_note].filter(Boolean).join(' · ')}));
}
