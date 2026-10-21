import crypto from 'node:crypto';
import {query,closeDb} from '../../src/db.js';
import {transferPostingOrderLine} from '../../src/netsuite-transfer-posting-line.js';
import {fetchLiveSourceFromNetSuite} from '../../src/operator-netsuite-posting-targets.js';

try {
  const rows=(await query(`SELECT o.tranid,l.* FROM transfer_order_lines l JOIN transfer_orders o ON o.netsuite_id=l.transfer_order_id
    WHERE COALESCE(l.netsuite_active,true) AND l.line_stage IN ('outbound','receiving') AND l.item_type IN ('InvtPart','NonInvtPart')
    ORDER BY l.transfer_order_id,l.line_stage,l.id`)).rows;
  const totals={lines:rows.length,exact:0,liveFallback:0,splitLines:0,unresolved:[]};
  const live=new Map();
  for(const row of rows) {
    if(Number(row.transfer_order_id)<0){totals.splitLines++;continue;}
    try {
      let evidence=row;
      if(!Array.isArray(row.raw?.physicalRows)) {
        const id=Number(row.transfer_order_id);
        if(!live.has(id))live.set(id,await fetchLiveSourceFromNetSuite({sourceOrderKind:'TO',sourceNetSuiteId:id}));
        const matches=live.get(id).lines.filter(line=>line.stage===row.line_stage&&Number(line.itemId)===Number(row.item_id)
          && [line.sourceLineKey,...(line.sourceLineAliases||[])].map(String).includes(String(row.line_id)));
        if(matches.length!==1)throw new Error('No exact live stable-key mapping');
        evidence={...row,raw:matches[0].raw};totals.liveFallback++;
      }
      transferPostingOrderLine(evidence,{sourceNetSuiteId:Number(row.transfer_order_id),stage:row.line_stage});totals.exact++;
    }catch(error){totals.unresolved.push({order:row.tranid,lineId:row.id,stage:row.line_stage,error:error.message});}
  }
  const operational=rows.map(({raw:_raw,...row})=>row);
  const fixture=rows.filter(row=>row.tranid==='TOB01189').map(row=>({stage:row.line_stage,sourceKey:row.line_id,itemId:row.item_id,
    sourceOrderLine:row.netsuite_order_line,postingOrderLine:transferPostingOrderLine(row,{sourceNetSuiteId:1036611,stage:row.line_stage}),
    quantity:row.quantity,loadedQty:row.loaded_qty,pallets:row.pallet_qty,pieces:row.piece_qty}));
  console.log(JSON.stringify({recordedAt:new Date().toISOString(),...totals,
    operationalHash:crypto.createHash('sha256').update(JSON.stringify(operational)).digest('hex'),tob01189:fixture},null,2));
}finally{await closeDb();}
