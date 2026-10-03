/** @param {{brand?:string,productName?:string,color?:string,size?:string,detailSpec?:string}} line */
export function specialItemDescription(line) {
  return [line.productName,line.color,line.size,line.detailSpec].map(value => String(value ?? '').trim()).filter(Boolean).join(' ');
}
export const SPECIAL_PACK_FIELDS = Object.freeze({palletQty:'custcol_plt',layerQty:'custcol_lyr',sectionQty:'custcol_sec',pieceQty:'custcol_pcs'});
/** @param {Record<string,unknown>} line */
export function specialPackPayload(line) {
  /** @type {Record<string,number>} */
  const payload = {};
  for (const [field,native] of Object.entries(SPECIAL_PACK_FIELDS)) {
    if (line[field] == null || line[field] === '') continue;
    const value = Number(line[field]);
    if (!Number.isFinite(value) || value < 0 || value > 1_000_000_000) throw Object.assign(new Error('PLT, LYR, SEC and PCS must be non-negative numbers.'), {status:400,code:'SPECIAL_PACK_QUANTITY_INVALID'});
    payload[native] = value;
  }
  return payload;
}
