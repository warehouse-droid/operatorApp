// @ts-check
import {isFulfillableNetSuiteLine} from './netsuite-fulfillable-items.js';
function unresolved() {
  return Object.assign(new Error('The registered first split has an ambiguous source line or quantity.'),{
    code:'SALES_ORDER_IF_SPLIT_UNRESOLVED',status:409});
}
/** @param {any[]} lines @param {any} items */
export function firstSplitFulfillmentLines(lines,items) {
  if(items===null || items===undefined) {return lines;}
  if(!Array.isArray(items)) {throw unresolved();}
  const seen=new Set();
  return items.filter(isFulfillableNetSuiteLine).map(item=>{
    const matches=lines.filter(line=>Number(line.local_order_line)===Number(item.lineId)
      && Number(line.item_id)===Number(item.itemId)
      && ((item.lineRowId??null)===null || Number(line.local_line_id)===Number(item.lineRowId)));
    const quantity=Number(item.splitQty??item.quantity),line=matches[0];
    if(matches.length!==1 || !Number.isFinite(quantity) || quantity<=0
      || quantity>Number(line.target_quantity)+0.000001 || seen.has(line.local_line_id)) {throw unresolved();}
    seen.add(line.local_line_id);
    return {...line,target_quantity:quantity};
  });
}
