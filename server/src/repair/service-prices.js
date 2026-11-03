/** @param {unknown} value */
function exactPrice(value){
 const match=/^(\d{1,9})(?:\.(\d{1,6}))?$/u.exec(String(value).trim());
 if(!match||/[1-9]/u.test((match[2]||'').slice(2)))return null;
 return `${Number(match[1])}.${(match[2]||'').slice(0,2).padEnd(2,'0')}`;
}
/** Keep the quoted selling suggestion separate from purchasing and actual costs.
 * @param {Array<Record<string, unknown>>} rows
 * @param {string} currencyId
 */
export function servicePrices(rows,currencyId){
 const items=new Map();
 for(const row of rows){
  const id=String(row.id);if(!items.has(id))items.set(id,{id,itemid:row.itemid,displayname:row.displayname,tier:-1,prices:new Set()});const item=items.get(id);
  if((row.base_price===null||row.base_price===undefined)||row.price_level!=='Base Price'||String(row.currency_id)!==currencyId||!['CAN','CAD','CANADIAN DOLLAR'].includes(String(row.currency_name||'').trim().toUpperCase())||String(row.price_unit_id||'')!==String(row.unit_id||''))continue;
  const rate=exactPrice(row.base_price),quantity=String(row.minimum_quantity??'0');
  if(rate===null||!/^\d{1,9}(?:\.\d{1,6})?$/u.test(quantity)||Number(quantity)>1)continue;
  const tier=Number(quantity);if(tier>item.tier){item.tier=tier;item.prices.clear();}if(tier===item.tier)item.prices.add(rate);
 }
 return [...items.values()].map(({id,itemid,displayname,prices})=>({id,itemid,displayname,basePrice:prices.size===1?[...prices][0]:null}));
}
