import {query,closeDb} from '../../src/db.js';
import {suiteqlAll} from '../../src/netsuite.js';
import {listOperatorNetSuitePostingAttentionCommands} from '../../src/operator-netsuite-posting-repository.js';
import {listSalesOrderAutoFulfillmentCandidates} from '../../src/sales-order-auto-fulfillment-repository.js';
// Investigation only: SELECT statements and NetSuite SuiteQL reads, no mutations.
try {
 const native=await listOperatorNetSuitePostingAttentionCommands({limit:500});
 const sales=await listSalesOrderAutoFulfillmentCandidates({statuses:['waiting_evidence','attention','uncertain','failed','historical','gate_disabled'],limit:500});
 const refs=[...new Set([...sales.map(c=>c.dispatchOrderRef),...native.flatMap(c=>c.steps.map(s=>s.sourceOrderRef))])];
 const local=(await query(`SELECT o.netsuite_id,o.tranid,o.outbound_location_id,o.status,o.status_text,
  (SELECT jsonb_agg(to_jsonb(s)) FROM dispatch_scm_so_splits s WHERE s.split_so_id=o.netsuite_id OR s.split_so_ref=o.tranid) AS splits
  FROM sales_orders o WHERE lower(o.tranid)=ANY($1::text[])`,[refs.map(r=>r.toLowerCase())])).rows;
 const localSplits=(await query(`SELECT * FROM dispatch_scm_so_splits WHERE lower(split_so_ref)=ANY($1::text[])`,[refs.map(r=>r.toLowerCase())])).rows;
 const roots=[...new Set(refs.map(r=>r.replace(/-S\d+$/i,'')))];
 if(roots.some(r=>!/^[A-Z0-9-]+$/i.test(r))) throw new Error('Unsafe source reference');
 const headers=await suiteqlAll(`SELECT id,tranid,type,status,BUILTIN.DF(status) AS status_text,lastmodifieddate
  FROM transaction WHERE type='SalesOrd' AND tranid IN (${roots.map(r=>`'${r}'`).join(',')})`);
 const ids=[...new Set([...headers.map(h=>Number(h.id)),...local.map(o=>Number(o.netsuite_id)),...localSplits.map(s=>Number(s.source_so_id))])].filter(id=>Number.isSafeInteger(id)&&id>0);
 const lines=await suiteqlAll(`SELECT tl.transaction AS source_id,tl.id AS order_line,tl.uniquekey AS source_line_key,
  tl.item AS item_id,i.itemtype AS item_type,i.isfulfillable AS is_fulfillable,BUILTIN.DF(tl.item) AS item_name,
  tl.quantity,tl.quantityshiprecv AS fulfilled_quantity,tl.isclosed AS is_closed,
  tl.units AS unit_id,BUILTIN.DF(tl.units) AS unit,uom.conversionrate AS conversion_rate,
  tl.location AS location_id,BUILTIN.DF(tl.location) AS location
  FROM transactionline tl LEFT JOIN item i ON i.id=tl.item LEFT JOIN UnitsTypeUom uom ON uom.internalid=tl.units
  WHERE tl.transaction IN (${ids.join(',')}) AND tl.item IS NOT NULL AND tl.mainline='F' AND tl.taxline='F'
  ORDER BY tl.transaction,tl.id`);
 const linked=await suiteqlAll(`SELECT link.previousdoc AS source_id,link.previousline AS source_line,
  t.id,t.tranid,t.type,t.status,BUILTIN.DF(t.status) AS status_text,t.lastmodifieddate,
  tl.id AS transaction_line,tl.item AS item_id,tl.quantity,tl.units AS unit_id,BUILTIN.DF(tl.units) AS unit,uom.conversionrate AS conversion_rate,
  tl.location AS location_id
  FROM NextTransactionLineLink link JOIN transaction t ON t.id=link.nextdoc
  JOIN transactionline tl ON tl.transaction=link.nextdoc AND tl.id=link.nextline
  LEFT JOIN UnitsTypeUom uom ON uom.internalid=tl.units
  WHERE link.previousdoc IN (${ids.join(',')}) AND t.type IN ('ItemShip','ItemRcpt')
  AND tl.item IS NOT NULL AND (tl.taxline='F' OR tl.taxline IS NULL)
  ORDER BY link.previousdoc,t.id,tl.id`);
 console.log(JSON.stringify({at:new Date().toISOString(),local,localSplits,headers,lines,linked},null,2));
}finally{await closeDb();}
