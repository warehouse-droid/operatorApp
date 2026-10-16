import {query} from './db.js';
import {DeliveryRequestError,DELIVERY_YARDS} from './delivery-request-domain.js';
import {netSuiteClosedOrderFamilySql} from './netsuite-closed-order-policy.js';

const failure=(code,message,status)=>new DeliveryRequestError(code,message,status);

export async function getDeliveryRequestTransferOrder(reference,yard) {
  if(typeof reference!=='string' || !/^TO[A-Z0-9][A-Z0-9._/-]{0,77}$/.test(reference)) {
    throw failure('DELIVERY_REQUEST_INVALID','Enter a valid Transfer Order number starting with TO.',400);
  }
  const result=await query(`SELECT t.netsuite_id,t.tranid,t.trandate,t.from_location_id,t.from_location,
      t.to_location_id,t.to_location,t.memo,t.dispatch_address
    FROM transfer_orders t WHERE upper(btrim(t.tranid))=$1 AND t.netsuite_active=true
      AND NOT ${netSuiteClosedOrderFamilySql('t','TO')}
    ORDER BY t.netsuite_id LIMIT 2 FOR SHARE OF t`,[reference]);
  if(!result.rowCount) {throw failure('DELIVERY_ORDER_NOT_FOUND','An active Transfer Order was not found.',404);}
  if(result.rowCount>1) {throw failure('DELIVERY_ORDER_AMBIGUOUS','More than one Transfer Order uses this number.',409);}
  const row=result.rows[0];
  if(![Number(row.from_location_id),Number(row.to_location_id)].includes(Number(yard))) {
    throw failure('DELIVERY_ACCESS_DENIED','This Transfer Order does not involve the requesting yard.',403);
  }
  return row;
}

export async function previewDeliveryRequestTransferOrder(reference,yard) {
  const row=await getDeliveryRequestTransferOrder(reference,yard);
  const lines=await query(`SELECT COALESCE(NULLIF(item_description,''),item_name,'') AS description,
      quantity,unit,pallet_qty AS pallets,layer_qty AS layers,section_qty AS sections,piece_qty AS pieces
    FROM transfer_order_lines WHERE transfer_order_id=$1 AND line_stage='outbound' AND netsuite_active=true
    ORDER BY line_id,id`,[row.netsuite_id]);
  return {reference:row.tranid,date:row.trandate?new Date(row.trandate).toISOString().slice(0,10):'',
    fromYard:row.from_location || DELIVERY_YARDS[row.from_location_id] || '',
    toYard:row.to_location || DELIVERY_YARDS[row.to_location_id] || '',
    address:row.dispatch_address || '',memo:row.memo || '',lines:lines.rows};
}
