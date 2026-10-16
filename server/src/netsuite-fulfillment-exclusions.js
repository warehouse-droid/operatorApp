// @ts-check

/** Sales credits and delivery fees can be auto-selected by NetSuite transforms.
 * Keep their exact source identities available for explicit deselection.
 * @param {Record<string,any>[]} rows
 * @param {Record<string,any>[]} sourceItems
 */
export function salesOrderBillingExclusions(rows,sourceItems) {
  return rows.filter(row=>row.item_type==='NonInvtPart'
    && /^(?:SALES CREDIT|DELIVERY CHARGE)/iu.test(String(row.item_name || '').trim())).map(row=>{
    const orderLine=Number(row.rest_order_line),itemId=Number(row.item_id);
    const matches=sourceItems.filter(item=>Number(item.orderLine ?? item.orderline ?? item.line)===orderLine
      && Number(item.item?.id ?? item.itemId ?? item.item)===itemId);
    if(!Number.isSafeInteger(orderLine) || orderLine<=0 || !Number.isSafeInteger(itemId) || itemId<=0 || matches.length!==1) {
      throw Object.assign(new Error('The Sales Order billing line has no unique NetSuite REST identity. Refresh before posting.'),{
        code:'SALES_ORDER_IF_LINE_MAPPING_UNRESOLVED',status:409});
    }
    return {orderLine,itemId,location:(row.location_id??null)===null?null:Number(row.location_id)};
  });
}
