// @ts-check
// Shared by browser previews and server validation. Money uses scaled integers.
/** @typedef {{id?: string, role?: string, roles?: string[], publicSales?: boolean}} Actor */
/** @typedef {{id?: string, company: string, itemId: string, sku?: string, description: string, quantity: string|number, unitRate: string|number, unit?: string, priceSource?: string, overrideReason?: string}} QuoteLineInput */
/** @typedef {{currency?: string, lines?: QuoteLineInput[]}} QuoteInput */
/** @typedef {{subtotalMinor:number,taxBps:number,taxMinor:number,totalMinor:number}} CompanyTotal */
/** @typedef {{latitude:number|null,longitude:number|null,id?:string,status?:string}} Point */
export const COMPANIES = ['MBBS', 'MBR', 'MBT'];
export const OUTCOMES = ['Contact met', 'Quote requested', 'Contact unavailable', 'Access unavailable', 'Not ready', 'Not interested', 'Wrong address', 'Other'];
export const STAGES = ['Unknown', 'Not started', 'Active construction', 'Completed'];
/** @param {string} message */
export function fail(message, status = 400, code = 'FIELD_SALES_INVALID') {
  return Object.assign(new Error(message), { status, code });
}
/** @param {unknown} value */
export function text(value, max = 2000) { return String(value ?? '').trim().slice(0, max); }
/** @param {unknown} value @param {string} label */
export function required(value, label, max = 2000) {
  const v = text(value, max); if (!v) {throw fail(`${label} is required.`);} return v;
}
/** @param {unknown} value */
export function uuid(value) {
  const v = String(value || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)) {throw fail('A valid record ID is required.');}
  return v;
}
/** @param {Actor|null|undefined} actor */
export function isAdmin(actor) { return [actor?.role, ...(actor?.roles || [])].includes('admin'); }
/** @param {Actor|null|undefined} actor */
export function requireFieldSales(actor) {
  if (!actor?.id || actor.publicSales || ![actor.role, ...(actor.roles || [])].some(r => ['admin','field_sales'].includes(String(r)))) {throw fail('Field Sales access is required.', 403, 'FIELD_SALES_FORBIDDEN');}
  return actor;
}
/** @param {Actor} actor @param {{owner_id:unknown}} route */
export function assertRouteOwner(actor, route) {
  requireFieldSales(actor);
  if (!isAdmin(actor) && String(route.owner_id) !== String(actor.id)) {throw fail('Only the assigned rep or an admin can change this route.',403);}
}
const SCALE = 1000000n;
/** @param {unknown} value */
function decimal(value, positive = false) {
  const s = String(value ?? '');
  if (!/^\d{1,12}(?:\.\d{1,6})?$/.test(s)) {throw fail('Use a nonnegative decimal with at most six decimal places.');}
  const [whole, fraction = ''] = s.split('.');
  const n = BigInt(whole) * SCALE + BigInt(fraction.padEnd(6,'0'));
  if (positive && n === 0n) {throw fail('Quantity must be greater than zero.');}
  return n;
}
/** @param {bigint} n */
function safeMinor(n) {
  if (n > 999999999999n || n < 0n) {throw fail('Quote amount exceeds the supported limit.');}
  return Number(n);
}
/** @param {QuoteInput} input @param {Record<string,{taxBps:number}>} policies */
export function calculateQuote(input = {}, policies = {}) {
  if ((input.currency || 'CAD') !== 'CAD') {throw fail('Field Sales quotes use CAD.');}
  if (!Array.isArray(input.lines) || input.lines.length > 200) {throw fail('A quote supports up to 200 item lines.');}
  /** @type {Record<string,CompanyTotal>} */
  const companies = {};
  const ids = new Set();
  const lines = input.lines.map((raw, index) => {
    const company = text(raw.company), policy = policies[company];
    if (!COMPANIES.includes(company) || !policy || !Number.isInteger(policy.taxBps) || policy.taxBps < 0 || policy.taxBps > 10000) {throw fail('Configure a valid tax policy for each company.');}
    const id = required(raw.id || String(index), 'Line ID', 80);
    if (ids.has(id)) {throw fail('Quote line IDs must be unique.');} ids.add(id);
    const itemId = required(raw.itemId, 'Item ID', 80);
    const amountMinor = safeMinor((decimal(raw.quantity, true) * decimal(raw.unitRate) * 100n + SCALE * SCALE / 2n) / (SCALE * SCALE));
    companies[company] ||= { subtotalMinor:0, taxBps:policy.taxBps, taxMinor:0, totalMinor:0 };
    companies[company].subtotalMinor = safeMinor(BigInt(companies[company].subtotalMinor) + BigInt(amountMinor));
    return { id, company, itemId, sku:text(raw.sku,120), description:required(raw.description,'Item description',1000), quantity:String(raw.quantity), unitRate:String(raw.unitRate), unit:text(raw.unit,40), amountMinor, priceSource:text(raw.priceSource,200), overrideReason:text(raw.overrideReason,500) };
  });
  let subtotalMinor = 0n, taxMinor = 0n;
  for (const c of Object.values(companies)) {
    c.taxMinor = safeMinor((BigInt(c.subtotalMinor) * BigInt(c.taxBps) + 5000n) / 10000n);
    c.totalMinor = safeMinor(BigInt(c.subtotalMinor) + BigInt(c.taxMinor));
    subtotalMinor += BigInt(c.subtotalMinor); taxMinor += BigInt(c.taxMinor);
  }
  return { currency:'CAD', lines, companies, subtotalMinor:safeMinor(subtotalMinor), taxMinor:safeMinor(taxMinor), totalMinor:safeMinor(subtotalMinor + taxMinor) };
}
export function torontoDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
}
/** @param {string} date @param {string} time */
function localInstant(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {throw fail('Use a valid date and time.');}
  const target = Date.parse(`${date}T${time}:00Z`);
  if (!Number.isFinite(target) || new Date(target).toISOString().slice(0,10) !== date) {throw fail('Invalid calendar date.');}
  let epoch = target;
  for (let i=0;i<3;i++) {
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(epoch)).map(p=>[p.type,p.value]));
    const shown=Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00Z`);
    if (shown === target) {return new Date(epoch).toISOString();}
    epoch += target-shown;
  }
  throw fail('This local time does not exist due to daylight saving.');
}
/** @param {string} date */
export function torontoWindow(date, period='afternoon', startTime='13:00', endTime='17:00') {
  const times = /** @type {Record<string,string[]>} */ ({morning:['09:00','12:00'], afternoon:['13:00','17:00'], day:['09:00','17:00']})[period] || [startTime,endTime];
  const start=localInstant(date,times[0]),end=localInstant(date,times[1]);
  if (end<=start) {throw fail('The end time must follow the start time.');}
  return {start,end,startTime:times[0],endTime:times[1],timeZone:'America/Toronto'};
}
/** @param {unknown} value */
export function normalizeAddress(value) {
  /** @type {Record<string,string>} */
  const words={ROAD:'RD',STREET:'ST',AVENUE:'AVE',BOULEVARD:'BLVD',DRIVE:'DR',TRAIL:'TRL',COURT:'CRT',CRESCENT:'CRES',PLACE:'PL',NORTH:'N',SOUTH:'S',EAST:'E',WEST:'W'};
  return text(value,500).toUpperCase().replace(/[.,]/g,'').replace(/\s+/g,' ').split(' ').map(w=>words[w]||w).join(' ');
}
/** @param {string} milestone */
export function recommendedRank(milestone, status='') {
  if (/refus|withdraw|cancel|revok/i.test(status)) {return 0;}
  return /** @type {Record<string,number>} */ ({'Statement of Approval Issued':30,'Notice of Approval Conditions Issued':20,'City Council Decision Made':/approv/i.test(status)?10:0})[milestone] || 0;
}
/** @param {Record<string,any>} a City API attributes; validated at this boundary. */
export function normalizePlanning(a) {
  if (a.APPLICATION_TYPE !== 'Community planning' || a.STATUS_GROUP !== 'Open') {return null;}
  if (!a.FOLDERRSN || !a.PROPERTYRSN) {throw fail('Planning record lacks a stable source identity.');}
  const district=/** @type {Record<string,string>} */ ({West:'Etobicoke-York',North:'North York',East:'Scarborough',South:'Toronto and East York'})[a.DISTRICT_NAME] || text(a.DISTRICT_NAME);
  return {source:'planning',sourceKey:`${a.FOLDERRSN}:${a.PROPERTYRSN}`,groupKey:`planning:${a.FOLDERRSN}`,address:required(a.FULL_ADDRESS,'Source address',500),latitude:a.LATITUDE==null||a.LATITUDE===''?null:Number(a.LATITUDE),longitude:a.LONGITUDE==null||a.LONGITUDE===''?null:Number(a.LONGITUDE),district,ward:text(a.WARD_NUMBER).padStart(2,'0'),wardName:text(a.WARD_NAME),postalPrefix:'',name:text(a.FOLDERNAME || a.FULL_ADDRESS,250),description:text(a.FOLDERDESCRIPTION,12000),applicationNumber:text(a.APPLICATION_NUMBER),category:text(a.FOLDERTYPE_DESC),milestone:text(a.LATEST_MILESTONE),status:text(a.STATUS_DESC),rank:recommendedRank(a.LATEST_MILESTONE,a.STATUS_DESC),sourceUrl:text(a.AIC_URL,2000),date:a.LATEST_MILESTONE_DATE ? new Date(a.LATEST_MILESTONE_DATE).toISOString():null,raw:a};
}
/** @param {Record<string,any>} p City API attributes; validated at this boundary. */
export function normalizePermit(p) {
  const suppliedAddress=[p.STREET_NUM,p.STREET_NAME,p.STREET_TYPE,p.STREET_DIRECTION].map(v=>text(v)).filter(Boolean).join(' ');
  const address=suppliedAddress||`Address unavailable · ${required(p.PERMIT_NUM,'Permit number')}`;
  const category=text(p.PERMIT_TYPE),status=text(p.STATUS);
  return {source:'permit',sourceKey:[required(p.PERMIT_NUM,'Permit number'),text(p.REVISION_NUM),text(p.GEO_ID),normalizeAddress(suppliedAddress)].join(':'),groupKey:`address:${normalizeAddress(address)}`,address,name:address,description:text(p.DESCRIPTION,12000),postalPrefix:text(p.POSTAL).slice(0,3).toUpperCase(),category,status,rank:/** @type {Record<string,number>} */ ({Inspection:40,'Permit Issued':35,'Revision Issued':35,'Ready for Issuance':25,'Issuance Pending':20})[status]||0,minor:/Mechanical|Plumbing|Fire\/Security|\bSigns?\b|Alternative Solution/i.test(category),date:p.ISSUED_DATE||p.APPLICATION_DATE||null,sourceUrl:'https://www.toronto.ca/services-payments/building-construction/building-permit/after-you-apply-for-a-building-permit/search-the-status-of-a-building-permit-application/',raw:p};
}
/** @param {Point} a @param {Point} b */
function distance(a,b) { return Math.hypot((Number(a.latitude)-Number(b.latitude))*111,(Number(a.longitude)-Number(b.longitude))*81); }
/** @template {Point} T @param {T[]} stops @param {Point} origin @returns {T[]} */
export function proposeOrder(stops, origin) {
  const fixed=stops.filter(s=>['completed','skipped','arrived'].includes(String(s.status)));
  const rest=stops.filter(s=>!fixed.includes(s));
  if (!origin || [origin,...stops].some(s=>s.latitude == null || s.longitude == null || !Number.isFinite(Number(s.latitude)) || !Number.isFinite(Number(s.longitude)))) {throw fail('Coordinates are needed to suggest an order.');}
  const result=[...fixed];let current=fixed.at(-1)||origin;
  while(rest.length) {rest.sort((a,b)=>distance(current,a)-distance(current,b)||String(a.id).localeCompare(String(b.id)));const next=rest.shift();if(next){current=next;result.push(next);}}
  for(let pass=0;pass<3;pass++) {for(let i=fixed.length;i<result.length-2;i++) {for(let j=i+1;j<result.length-1;j++) {
    const a=result[i-1]||origin,b=result[i],c=result[j],d=result[j+1];
    if(distance(a,c)+distance(b,d)+0.001<distance(a,b)+distance(c,d)) {result.splice(i,j-i+1,...result.slice(i,j+1).reverse());}
  }}}
  return result;
}
