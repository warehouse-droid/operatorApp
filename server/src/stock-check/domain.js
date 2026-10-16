export class StockCheckError extends Error {
  constructor(message, status = 400, code = 'STOCK_CHECK_INVALID') {
    super(message); this.status = status; this.code = code;
  }
}

export const UNILOCK_ORIGIN='https://ontario.order.unilock.com';
export const PICKUP_LOCATIONS=Object.freeze([
  {code:'01',name:'Georgetown'},{code:'02',name:'Barrie'},{code:'03',name:'Pickering'},
  {code:'05',name:'Gormley'},{code:'07',name:'Ayr'},{code:'12',name:'Quebec'},{code:'C1',name:'Ottawa'}
]);
export const EDITABLE_PRODUCT_FIELDS=Object.freeze(['name','series','finish','colour','shape','size','dimensions','pickupLocation','url','imageUrl']);

export function cleanText(value,maximum=240,label='Text') {
  if(value===null || value===undefined) {return '';}
  if(typeof value!=='string' || value.length>maximum) {
    throw new StockCheckError(label+' is invalid.',400,'STOCK_CHECK_TEXT_INVALID');
  }
  return value.normalize('NFC').replace(/\s+/gu,' ').trim();
}

export function pickupForLabel(label) {
  const text=String(label??'').replace(/^Plant\s*Produced\s*:\s*/iu,'')
    .replace(/^Loc\s+\w+\s*-\s*Unilock\s+/iu,'').trim().toLowerCase();
  const found=PICKUP_LOCATIONS.find(row=>row.name.toLowerCase()===text);
  if(!found) {throw new StockCheckError('The selected product pickup point is missing or unfamiliar. SCM review is required.',422,'STOCK_CHECK_PICKUP_UNKNOWN');}
  return {...found};
}

export function validateQuantity(value) {
  const isNumeric=typeof value==='number' && Number.isInteger(value);
  const isWholeText=typeof value==='string' && /^[1-9]\d{0,4}$/u.test(value);
  const number=Number(value);
  if((!isNumeric && !isWholeText) || number<1 || number>99999) {
    throw new StockCheckError('Enter a whole pallet quantity between 1 and 99,999.',400,'STOCK_CHECK_QUANTITY_INVALID');
  }
  return number;
}

/** @param {string} value @param {{baseUrl?:string,allowTestOrigin?:boolean}} [options] */
export function allowedPortalUrl(value,{baseUrl=UNILOCK_ORIGIN,allowTestOrigin=false}={}) {
  try {
    const base=new URL(baseUrl),url=new URL(value,base);
    const isFixture=allowTestOrigin && ['localhost','127.0.0.1','[::1]'].includes(base.hostname) && ['http:','https:'].includes(base.protocol);
    const validBase=base.origin===UNILOCK_ORIGIN || isFixture;
    const forbidden=/checkout|place.?order|submit.?order|finali[sz]e|payment/iu.test(decodeURIComponent(url.pathname));
    if(!validBase || url.origin!==base.origin || url.username || url.password || forbidden) {throw new Error('Invalid origin');}
    url.hash=''; return url;
  } catch {
    throw new StockCheckError('This portal URL is outside the configured stock-check method.',400,'STOCK_CHECK_ORIGIN_INVALID');
  }
}

/** @param {any} input @param {{baseUrl?:string,allowTestOrigin?:boolean,allowUnmappedPickup?:boolean}} [options] */
export function normalizeProduct(input,options={}) {
  const sku=cleanText(input.sku,120,'Vendor SKU').toUpperCase();
  const name=cleanText(input.name,240,'Product name');
  if(!/^[A-Z0-9][A-Z0-9_. -]*$/u.test(sku) || !name) {
    throw new StockCheckError('A selected product name and exact vendor SKU are required.',422,'STOCK_CHECK_PRODUCT_INVALID');
  }
  const observedPickup=cleanText(input.pickupLocation,120,'Displayed pickup point');
  let pickup=null;
  try {pickup=pickupForLabel(observedPickup);}
  catch(error) {if(!options.allowUnmappedPickup) {throw error;}}
  const url=allowedPortalUrl(cleanText(input.url,2000,'Product URL'),options);
  if(!/^\/products\/products\/[a-z0-9-]+$/iu.test(url.pathname)) {
    throw new StockCheckError('Select a vendor product page URL.',400,'STOCK_CHECK_PRODUCT_URL_INVALID');
  }
  let imageUrl=cleanText(input.imageUrl,2000,'Product image URL');
  if(imageUrl && !/^https:\/\//iu.test(imageUrl)) {imageUrl='';}
  return {sku,name,series:cleanText(input.series,160,'Series'),colour:cleanText(input.colour,120,'Colour'),
    finish:cleanText(input.finish,120,'Finish'),shape:cleanText(input.shape,160,'Shape'),size:cleanText(input.size,240,'Size'),
    dimensions:cleanText(input.dimensions,240,'Dimensions'),pickupLocation:pickup?.name??observedPickup,pickupCode:pickup?.code??null,pickupNeedsReview:!pickup,
    url:url.href,imageUrl,sourceLabel:cleanText(input.sourceLabel,1000,'Selected product label')};
}

/** @param {any} row @param {{baseUrl?:string,allowTestOrigin?:boolean,allowUnmappedPickup?:boolean}} [options] */
export function effectiveProduct(row,options={}) {
  const changes={};
  for(const key of EDITABLE_PRODUCT_FIELDS) {
    if(Object.hasOwn(row.overrides??{},key)) {changes[key]=row.overrides[key];}
  }
  return {...row,...normalizeProduct({...row,...changes},options),hasOverrides:Object.keys(changes).length>0};
}

export function normalizeSearch(text) {
  return String(text??'').replace(/[™®©]/gu,'').normalize('NFKD').replace(/\p{M}/gu,'')
    .toLowerCase().replace(/(\d)\s*[x×]\s*(\d)/gu,'$1 $2').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
}

/** @param {any[]} products @param {string} query */
export function matchingProducts(products,query) {
  const value=cleanText(query,200,'Item search');
  if(!value) {return [];}
  const skuMatches=products.filter(row=>String(row.sku).toUpperCase()===value.toUpperCase());
  if(skuMatches.length) {return skuMatches;}
  const tokens=normalizeSearch(value).split(' ').filter(Boolean);
  if(!tokens.length) {return [];}
  return products.filter(row=>{
    const text=normalizeSearch([row.sku,row.name,row.series,row.colour,row.finish,row.shape,row.size,row.dimensions].join(' '));
    return tokens.every(token=>text.includes(token));
  });
}

function failed(reason,extra={}) {return {status:'scrape_failure',reason,verifiedQuantity:null,...extra};}
function cartSignature(rows,sku) {
  return JSON.stringify(rows.filter(row=>row.sku!==sku).map(row=>[row.sku,Number(row.quantity),row.uom]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
}

/** @param {any} input */
export function stockVerdict(input) {
  if(input.otherError) {return failed(sanitizeFailure(input.otherError));}
  const baseline=Number(input.baselineQuantity??0),requested=validateQuantity(input.requestedQuantity);
  if(input.explicitStockShortage) {
    if(baseline>0) {return failed('The portal rejected a cumulative quantity including an existing cart line. SCM must review availability for the requested quantity.');}
    return {status:'insufficient_stock',reason:'The vendor explicitly rejected the requested pallet quantity because stock is insufficient.',verifiedQuantity:0};
  }
  if(input.actionAccepted!==true) {return failed('The native Add to Cart action was not accepted.');}
  if(input.pickupMatches!==true || input.dateMatches!==true) {return failed('The cart pickup location or request date does not match this stock check.');}
  const rows=input.cartRows??[],matches=rows.filter(row=>row.sku===input.expectedSku);
  if(matches.length!==1) {return failed('The exact selected vendor SKU could not be verified as a single cart line.');}
  const expected=baseline+requested,actual=Number(matches[0].quantity);
  if(!Number.isInteger(baseline) || baseline<0 || actual!==expected || matches[0].uom!=='BNDL') {
    return failed('The cart did not accept the full requested bundle quantity in the expected unit.');
  }
  if(cartSignature(input.baselineRows??[],input.expectedSku)!==cartSignature(rows,input.expectedSku)) {
    return failed('A pre-existing cart line changed during the check. SCM review is required.');
  }
  return cartAvailabilityVerdict(matches[0],{requested,actual,baseline});
}

function cartAvailabilityVerdict(row,{requested,actual,baseline}) {
  const availability=parseAvailability(row.availabilityText);
  const evidence={availabilityEvidenceVersion:1,availabilitySource:'cart',availabilityText:availability.text,
    availabilityStatus:availability.status,eta:availability.eta,acceptedQuantity:requested,cartAcceptanceVerified:true,cartTotalQuantity:actual};
  if(row.availabilityAmbiguous || ['unknown','low_stock'].includes(availability.status)) {
    return failed('The cart Availability column is missing, ambiguous or unfamiliar. SCM review is required.',{...evidence,requiresScmReview:true});
  }
  if(availability.status==='in_stock') {
    return {...evidence,status:'stock_confirmed',reason:'The vendor accepted the requested bundles and the exact cart row reports '+availability.text+'.',verifiedQuantity:requested};
  }
  if(availability.status==='in_production') {
    const existing=baseline>0?' The production status applies to '+actual+' total bundles including '+baseline+' already in the cart; SCM must review the requested increment.':'';
    return {...evidence,status:'in_production',reason:'The vendor reports '+availability.text+'. Immediate stock is not confirmed.'+existing,
      verifiedQuantity:null,requiresScmReview:baseline>0};
  }
  if(baseline>0) {return failed('The cart reports unavailable for a cumulative quantity including an existing line. SCM must review the requested quantity.',{...evidence,requiresScmReview:true});}
  return {...evidence,status:'insufficient_stock',reason:'The cart Availability column explicitly reports '+availability.text+'.',verifiedQuantity:0};
}

/** @param {any} row */
export function publicAccount(row) {
  return {id:row.id,vendorId:row.vendor_id??row.vendorId,label:row.label,username:row.username,
    configured:Boolean(row.encrypted_secret),active:row.active!==false,selected:Boolean(row.selected),
    lastVerifiedAt:row.last_verified_at??null,lastError:row.last_error??null,revision:row.revision??1};
}

/** @param {any} error @param {string[]} [secrets] */
export function sanitizeFailure(error,secrets=[]) {
  let text=typeof error==='string'?error:String(error?.message??'The vendor portal could not be checked.');
  for(const secret of secrets.filter(Boolean)) {text=text.split(secret).join('[redacted]');}
  return text.replace(/Authorization:\s*Bearer\s*[^\s;]+/giu,'Authorization: [redacted]')
    .replace(/Cookie:\s*[^\r\n]*/giu,'Cookie: [redacted]').slice(0,1000);
}

/** @param {any} actor */
export function canUseStockCheck(actor) {
  const roles=[...(Array.isArray(actor?.roles)?actor.roles:[]),actor?.role]
    .map(value=>String(value??'').trim().toLowerCase().replace(/[ -]+/gu,'_'));
  return roles.some(role=>['admin','scm','scm_staff'].includes(role));
}

/** @param {any} value */
export function parseAvailability(value) {
  const text=cleanText(value,500,'Vendor availability');
  let status='unknown',eta=null;
  if(/^(?:available|in stock)$/iu.test(text)) {status='in_stock';}
  else if(/^available\s*-\s*low in stock$/iu.test(text)) {status='low_stock';}
  else if(/^(?:production scheduled(?:\s+for)?|in production)\b/iu.test(text)) {
    status='in_production';eta=/\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})\b/u.exec(text)?.[0]??null;
  } else if(/^(?:not available|unavailable|out of stock|not in stock)$/iu.test(text)) {status='out_of_stock';}
  return {status,text,eta};
}

/** Vendor-reported availability before Add to Cart; requested quantities are never tested. */
export function productAvailabilityVerdict({availabilityText,availabilitySource,requestedQuantity}) {
  validateQuantity(requestedQuantity);
  const availability=parseAvailability(availabilityText);
  const evidence={availabilityEvidenceVersion:2,availabilitySource,availabilityText:availability.text,
    availabilityStatus:availability.status,eta:availability.eta,verifiedQuantity:null,
    acceptedQuantity:null,cartAcceptanceVerified:false,quantityVerified:false};
  if(!['product_bundle','product_label'].includes(availabilitySource) || availability.status==='unknown') {
    return failed('The selected product availability is missing or unfamiliar. SCM review is required.',{...evidence,requiresScmReview:true});
  }
  const status={in_stock:'stock_available',low_stock:'low_stock',in_production:'in_production',out_of_stock:'insufficient_stock'}[availability.status];
  return {...evidence,status,reason:'The vendor reports '+availability.text+' for the selected variant. No items were added to the cart; the requested bundle quantity was not tested.'};
}

/** @param {any} result */
export function stockCheckResultView(result) {
  if(result?.status!=='stock_confirmed') {return result;}
  if(result.availabilityEvidenceVersion===1 && result.availabilitySource==='cart' && parseAvailability(result.availabilityText).status==='in_stock') {return result;}
  return {...result,status:'availability_unverified',previousStatus:result.status,verifiedQuantity:null,
    acceptedQuantity:result.acceptedQuantity??result.verifiedQuantity??null,requiresScmReview:true,
    reason:'This earlier check verified cart acceptance but did not verify the Availability column. Run a new check to confirm immediate stock.'};
}
