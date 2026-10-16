import crypto from 'node:crypto';

export const isUnilock=name=>/^unilock(?:\s+(?:ltd\.?|limited|inc\.?|ontario))?$/iu.test(String(name??'').trim());
const normalized=value=>String(value??'').replace(/[™®]/gu,'').replace(/\bTM\b/gu,'').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/gu,'');
export function lineFingerprint(line) {
  return crypto.createHash('sha256').update(JSON.stringify([line.vendorName,line.productName,line.color,line.size,
    line.detailSpec,line.itemCode,line.vendorReference,line.quantity,line.uom])).digest('hex');
}
export function matchLineProducts(line,products) {
  if(/\b(?:rdm|random)\b/iu.test([line.productName,line.size].join(' '))) {
    products=products.filter(product=>/\b(?:rdm|random)\b/iu.test([product.name,product.size,product.shape].join(' ')));
  }
  const description=[line.productName,line.itemCode,line.detailSpec,line.vendorReference].join(' ');
  /** @type {string[]} */
  const identifiers=description.toUpperCase().match(/[A-Z0-9]+(?:-[A-Z0-9]+)+/gu)??[];
  const exact=products.filter(product=>identifiers.includes(product.sku.toUpperCase()));
  const complete=products.filter(product=>normalized(line.productName)===normalized(product.name) &&
    normalized(line.color)===normalized(product.colour) && normalized(line.size)===normalized(product.size));
  const matches=exact.length?exact:complete;
  /** @type {string[]} */
  const words=description.toLowerCase().replace(/[™®]/gu,'').match(/[a-z0-9]{2,}/gu)??[];
  const score=product=>{
    const haystack=[product.name,product.series,product.colour,product.size,product.sku].join(' ').toLowerCase();
    return words.reduce((sum,word)=>sum+(haystack.includes(word)?1:0),0)+(normalized(line.color) && normalized(line.color)===normalized(product.colour)?5:0);
  };
  const candidates=[...products].sort((a,b)=>score(b)-score(a)||a.sku.localeCompare(b.sku)).slice(0,20);
  return {product:matches.length===1?matches[0]:null,candidates:matches.length?matches:candidates};
}
