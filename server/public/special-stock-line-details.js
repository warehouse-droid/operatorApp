import { ORDER_PACK_FIELDS, normalizePackQuantity } from './order-pack-quantities.js';

/** @param {{brand?:string,productName?:string,color?:string,size?:string,detailSpec?:string}} line */
export function specialItemDescription(line) {
  return [line.productName,line.color,line.size,line.detailSpec].map(value => String(value ?? '').trim()).filter(Boolean).join(' ');
}
export const SPECIAL_PACK_FIELDS = ORDER_PACK_FIELDS;
/** @param {Record<string,unknown>} line */
export function specialPackPayload(line) {
  /** @type {Record<string,number|null>} */
  const payload = {};
  for (const [field,native] of Object.entries(SPECIAL_PACK_FIELDS)) {
    payload[native] = normalizePackQuantity(line[field]);
  }
  return payload;
}
