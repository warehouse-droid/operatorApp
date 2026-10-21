import {query,closeDb} from '../../src/db.js';
import {listOperatorNetSuitePostingAttentionCommands} from '../../src/operator-netsuite-posting-repository.js';
import {listSalesOrderAutoFulfillmentCandidates} from '../../src/sales-order-auto-fulfillment-repository.js';
import {suiteqlAll,fetchItemFulfillmentFromNetSuite} from '../../src/netsuite.js';
try {
 const native=await listOperatorNetSuitePostingAttentionCommands({limit:500});
 const sales=await listSalesOrderAutoFulfillmentCandidates({statuses:['waiting_evidence','attention','uncertain','failed','historical','gate_disabled'],limit:500});
 const audit=(await query(`SELECT action,count(*)::int AS count FROM dispatch_sales_order_if_audit_events
  WHERE actor_id='maintenance:netsuite-attention-20261003' GROUP BY action`)).rows;
 const nativeAudit=(await query(`SELECT count(*)::int AS count FROM delivery_audit_log WHERE action='operator_netsuite_posting.verified_existing_reconciled'`)).rows[0];
 const transfer=(await query(`SELECT netsuite_id,tranid,status,status_text,to_jsonb(t)->>'fulfillment_status' AS fulfillment_status,
  to_jsonb(t)->>'local_yard_order_status' AS local_yard_order_status FROM transfer_orders t WHERE tranid='TOB01189'`)).rows;
 const transferRemote=await suiteqlAll(`SELECT id,tranid,status,BUILTIN.DF(status) AS status_text FROM transaction WHERE id=1036611 AND type='TrnfrOrd'`);
 const transferLinks=await suiteqlAll(`SELECT t.id,t.tranid,t.type FROM NextTransactionLineLink l JOIN transaction t ON t.id=l.nextdoc
  WHERE l.previousdoc=1036611 AND t.type IN ('ItemShip','ItemRcpt')`);
 const transferIf=await fetchItemFulfillmentFromNetSuite(1037916);
 const nativeQuantities=(await query(`SELECT o.tranid,o.operator_status,o.local_yard_order_status,o.status_text,
  jsonb_agg(jsonb_build_object('line',l.netsuite_order_line,'item',l.item_id,'unit',l.unit,'ordered',l.quantity,'loaded',l.loaded_qty)) AS lines
  FROM sales_orders o JOIN sales_order_lines l ON l.sales_order_id=o.netsuite_id
  WHERE o.tranid=ANY($1::text[]) GROUP BY o.tranid,o.operator_status,o.local_yard_order_status,o.status_text`,
  [['SOM06778','SOM06796','SOM06819','SOM06822','SOM06823','SOB121969','SOB121883']])).rows;
 console.log(JSON.stringify({at:new Date().toISOString(),native,sales,audit,nativeAudit,transfer,transferRemote,transferLinks,
  transferIf:{id:transferIf.id,reference:transferIf.tranId,source:transferIf.createdFrom,lines:transferIf.item.items.map(l=>({line:l.orderLine,item:l.item.id,quantity:l.quantity}))},nativeQuantities},null,2));
}finally{await closeDb();}
