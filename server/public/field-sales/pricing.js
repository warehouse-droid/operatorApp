import { fail } from './domain.js';
/** @param {string} company */
export function priceLevel(company) {
  if(company==='MBBS'){return 'TRADE-A';}
  if(company==='MBR'||company==='MBT'){return 'TRADE';}
  throw fail('Unknown company.');
}
/** @param {unknown} value */
export function decimalValue(value) {
  if(typeof value!=='string'||!/^\d{1,12}(\.\d{1,6})?$/.test(value)){throw fail('NetSuite returned an unsupported price or quantity.',409);}
  const [whole,fraction='']=value.split('.');return BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,'0'));
}
/** @param {unknown} a @param {unknown} b */
export function sameDecimal(a,b) {
  try{return decimalValue(a)===decimalValue(b);}catch{return false;}
}
/** @typedef {{minimumQuantity:string,unitRate:string}} PriceTier */
/** @param {{company:string,unit_rate:string|null,pricing?:{source?:string,priceLevel?:string,tiers?:PriceTier[]}}} item @param {string} [quantity] */
export function suggestedRate(item,quantity='1') {
  const q=decimalValue(quantity);if(q<=0n){throw fail('Quantity must be positive.');}
  const policy=item.pricing;
  // Legacy catalog sources are not Trade suggestions, including offline caches.
  // Empty metadata is retained for manually supplied catalog rows.
  if(!policy?.priceLevel){return policy?.source?null:item.unit_rate;}
  if(policy.priceLevel!==priceLevel(item.company)){return null;}
  let rate=null,threshold=-1n;
  for(const tier of policy.tiers||[]){
    const minimum=decimalValue(tier.minimumQuantity);decimalValue(tier.unitRate);
    if(minimum<=q&&minimum>threshold){threshold=minimum;rate=tier.unitRate;}
  }
  return rate;
}
