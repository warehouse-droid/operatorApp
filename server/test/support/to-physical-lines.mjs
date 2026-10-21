// Synthetic SuiteQL evidence. Callers independently assert expected posting IDs.
export function transferPhysicalEvidence({id,itemId,key,sourceLine,postingLine,stage='outbound',quantity=5}) {
  const row={id:String(id),item_id:String(itemId),source_line_key:String(key),
    order_line_number:String(postingLine),signed_quantity:String(stage==='outbound'?-quantity:quantity),do_not_print_line:'T'};
  return {identityStatus:'exact',physicalRows:stage==='outbound'
    ? [{...row,order_line_number:String(sourceLine),do_not_print_line:'F'}, {...row,source_line_key:String(Number(key)+10000000)}]
    : [row]};
}
