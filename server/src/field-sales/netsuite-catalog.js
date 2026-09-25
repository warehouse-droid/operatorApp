import { suiteqlAll } from '../netsuite.js';
import { fail,text } from '../../public/field-sales/domain.js';
import { priceLevel,decimalValue,sameDecimal,suggestedRate } from '../../public/field-sales/pricing.js';
function numericId(value,label) {
  if(!/^[1-9]\d{0,14}$/.test(String(value||''))){throw fail(`Configure a valid ${label}.`,409);}
  return String(value);
}
function addTier(item,row,cfg,level) {
  if(row.unit_rate==null){return;}
  if(row.price_level!==level){throw fail('NetSuite returned an unexpected price level.',409);}
  if(String(row.currency_id)!==String(cfg.currencyId)||!['CAN','CAD','CANADIAN DOLLAR'].includes(String(row.currency_name).toUpperCase())){throw fail('NetSuite returned an unexpected currency; CAD is required.',409);}
  if(String(row.price_unit_id||'')!==String(row.unit_id||'')){throw fail('NetSuite price does not match the sales unit.',409);}
  const unitRate=String(row.unit_rate),minimumQuantity=String(row.minimum_quantity??'0');
  decimalValue(unitRate);decimalValue(minimumQuantity);
  const existing=item.pricing.tiers.find(t=>sameDecimal(t.minimumQuantity,minimumQuantity));
  if(existing&&!sameDecimal(existing.unitRate,unitRate)){throw fail('NetSuite returned ambiguous quantity pricing.',409);}
  if(!existing){item.pricing.tiers.push({minimumQuantity,unitRate});}
  item.pricing.priceLevelId=String(row.price_level_id);
}
export function createNetSuiteCatalogReader({queryAll=suiteqlAll}={}) {
  async function items(company,cfg={},itemId) {
    const level=priceLevel(company),subsidiary=numericId(cfg.subsidiaryId,`${company} subsidiary ID`),currency=numericId(cfg.currencyId,`${company} CAD currency ID`);
    const filter=itemId===undefined?'':` AND i.id=${numericId(itemId,'item ID')}`;
    // pricing.quantity is an internal tier ID. DF returns the actual threshold.
    const rows=await queryAll(`SELECT i.id,i.itemid AS sku,COALESCE(i.displayname,i.itemid) AS description,
      i.saleunit AS unit_id,BUILTIN.DF(i.saleunit) AS unit,p.saleunit AS price_unit_id,
      p.currency AS currency_id,BUILTIN.DF(p.currency) AS currency_name,
      p.pricelevel AS price_level_id,BUILTIN.DF(p.pricelevel) AS price_level,
      BUILTIN.DF(p.quantity) AS minimum_quantity,p.unitprice AS unit_rate
      FROM item i LEFT JOIN pricing p ON p.item=i.id AND p.currency=${currency} AND BUILTIN.DF(p.pricelevel)='${level}'
      WHERE i.isinactive='F' AND i.itemtype IN ('InvtPart','NonInvtPart','Service','Kit','Assembly','OthCharge')
      AND (i.subtype IS NULL OR i.subtype<>'Purchase')
      AND BUILTIN.MNFILTER(i.subsidiary,'MN_INCLUDE','','TRUE','${subsidiary}')='T'${filter}
      ORDER BY i.id,p.quantity`);
    const result=new Map(),refreshedAt=new Date().toISOString();
    for(const row of rows){
      const id=numericId(row.id,'item ID');
      if(!result.has(id)){result.set(id,{company,item_id:id,sku:text(row.sku,500),description:text(row.description,2000),unit:row.unit||'',unit_rate:null,pricing:{source:`NetSuite ${level} (CAD)`,priceLevel:level,currencyId:currency,subsidiaryId:subsidiary,unitId:row.unit_id?String(row.unit_id):null,tiers:[],refreshedAt}});}
      addTier(result.get(id),row,cfg,level);
    }
    for(const item of result.values()){item.unit_rate=suggestedRate(item);}
    return [...result.values()];
  }
  return {items};
}
