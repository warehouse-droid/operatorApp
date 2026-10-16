export function stockCheckMaterial(row) {
  if(row.workflow_kind!=='backorder') {return {productName:row.product_name,detailSpec:row.detail_spec,itemCode:row.regular_item_code};}
  const code=String(row.regular_item_code??'').trim();
  const description=value=>{
    const text=String(value??'').trim();
    return text.toLowerCase()===code.toLowerCase()?'':text;
  };
  const detailSpec=description(row.detail_spec);
  const productName=detailSpec||description(row.inventory_description)||description(row.product_name);
  return {productName,detailSpec,itemCode:null,referenceItemCode:code,descriptionMissing:!productName};
}
