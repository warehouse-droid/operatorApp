export const WAITLIST_MANUAL_RELEASE_MS = 30 * 60 * 1000;
export const WAITLIST_AUTO_RELEASE_MS = 3 * 60 * 60 * 1000;
export const WAITLIST_POLL_MS = 15 * 1000;
const MAX_QUANTITY = 1_000_000_000;
export const isWaitlist = request => (request?.regular?.deliveryMethod ?? request?.regular_details?.deliveryMethod) === 'waitlist';
export const waitlistError = (message, code = 'WAITLIST_INVALID', status = 400) => Object.assign(new Error(message), {code, status});
export const roundWaitlistQuantity = value => Number(Number(value).toFixed(6));

export function waitlistQuantity(value, {allowZero = false} = {}) {
  if(!['number','string'].includes(typeof value))throw waitlistError('Enter a numeric item quantity.');
  if(value === null || value === undefined || String(value).trim() === '')throw waitlistError('Enter a positive item quantity.');
  const quantity = Number(value);
  const rounded = roundWaitlistQuantity(quantity);
  if(!Number.isFinite(quantity) || quantity < 0 || quantity > MAX_QUANTITY || (!allowZero && rounded <= 0)) {
    throw waitlistError('Quantity must be positive, finite and no greater than 1,000,000,000.');
  }
  return rounded;
}

export function waitlistPoolBalance(capacity, allocations = []) {
  const capacityQty = waitlistQuantity(capacity, {allowZero:true});
  let heldQty = 0, convertedQty = 0;
  for(const allocation of allocations) {
    if(!['reserved','converting','committed'].includes(allocation.status))continue;
    const quantity = waitlistQuantity(allocation.quantity, {allowZero:true});
    if(allocation.status === 'committed')convertedQty += quantity;
    else heldQty += quantity;
  }
  heldQty = roundWaitlistQuantity(heldQty); convertedQty = roundWaitlistQuantity(convertedQty);
  return {capacityQty,heldQty,convertedQty,availableQty:roundWaitlistQuantity(Math.max(0,capacityQty-heldQty-convertedQty)),
    deficitQty:roundWaitlistQuantity(Math.max(0,heldQty+convertedQty-capacityQty))};
}

export function waitlistTotals({requested,held = 0,committed = 0,closed = false}) {
  const requestedQty = waitlistQuantity(requested), heldQty = waitlistQuantity(held,{allowZero:true}), convertedQty = waitlistQuantity(committed,{allowZero:true});
  const unconverted = roundWaitlistQuantity(Math.max(0,requestedQty-convertedQty));
  const remainingQty = closed ? 0 : unconverted;
  return {requestedQty,heldQty,convertedQty,remainingQty,waitingQty:roundWaitlistQuantity(Math.max(0,remainingQty-heldQty)),closedQty:closed?unconverted:0};
}

export function preferredWaitlistYard(itemCode, brand = '') {
  const prefix = String(itemCode || '').trim().toUpperCase().split(/[-_\s]/u)[0];
  const code = ['UNI','BWS','PER','TH'].includes(prefix) ? prefix : ({UNILOCK:'UNI',BWS:'BWS',PER:'PER',TH:'TH'})[String(brand).trim().toUpperCase()];
  return ['UNI','BWS'].includes(code) ? 1 : ['PER','TH'].includes(code) ? 28 : null;
}

export function rankWaitlistRequests(requests, itemCode, brand = '') {
  const preferred = preferredWaitlistYard(itemCode, brand);
  const group = row => preferred && Number(row.destinationLocationId) !== preferred ? 1 : 0;
  return [...requests].sort((a,b) => group(a)-group(b) || Date.parse(a.createdAt)-Date.parse(b.createdAt) || Number(a.id)-Number(b.id));
}

export function assertWaitlistSelectionPriority(ranked, selections, reason = '') {
  const quantities = new Map(selections.map(row=>[Number(row.requestId),Number(row.quantity)]));
  const last = ranked.reduce((index,row,i)=>quantities.get(Number(row.id))>0?i:index,-1);
  const overridden = ranked.slice(0,last).some(row => (quantities.get(Number(row.id)) || 0) + 0.000001 < Number(row.waitlist.waitingQty));
  if(overridden && !String(reason).trim())throw waitlistError('Provide a reason for passing a higher-priority waiting request.','WAITLIST_PRIORITY_OVERRIDE_REQUIRED',409);
  return overridden;
}

export function waitlistReleaseEligibility(allocation, {now = new Date(),hasCompetingDemand = false} = {}) {
  const allocatedAt = new Date(allocation.allocatedAt).getTime();
  const age = new Date(now).getTime()-allocatedAt;
  const reserved = allocation.status === 'reserved';
  return {manualAllowed:reserved && age>=WAITLIST_MANUAL_RELEASE_MS,
    automaticAllowed:reserved && age>=WAITLIST_AUTO_RELEASE_MS && hasCompetingDemand,
    manualReleaseAt:new Date(allocatedAt+WAITLIST_MANUAL_RELEASE_MS).toISOString(),
    autoReleaseAt:new Date(allocatedAt+WAITLIST_AUTO_RELEASE_MS).toISOString()};
}

export function waitlistId(value, label = 'record') {
  if(!['number','string'].includes(typeof value))throw waitlistError(`Select a valid ${label}.`);
  const id = Number(value);
  if(!Number.isSafeInteger(id) || id<=0)throw waitlistError(`Select a valid ${label}.`);
  return id;
}

export function waitlistText(value, {required = false,max = 2000,label = 'Value'} = {}) {
  const text = String(value ?? '').trim();
  if((required && !text) || text.length>max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text))throw waitlistError(`${label} is required and must be at most ${max} characters.`);
  return text;
}

export function waitlistKey(value) {
  const key = String(value || '').trim().toLowerCase();
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(key))throw waitlistError('A valid operation key is required.','WAITLIST_OPERATION_KEY_REQUIRED');
  return key;
}

export function normalizeWaitlistFulfillment(input = {}) {
  const fulfillmentMethod = String(input.fulfillmentMethod || '').toLowerCase();
  if(!['pickup','delivery'].includes(fulfillmentMethod))throw waitlistError('Select Pickup or Delivery.');
  const delivery = fulfillmentMethod === 'delivery';
  const details = {fulfillmentMethod,deliveryDate:null};
  if(!delivery)return details;
  const date = waitlistText(input.deliveryDate,{required:true,max:10,label:'Delivery date'});
  const timestamp = Date.parse(date+'T00:00:00Z');
  if(!/^\d{4}-\d{2}-\d{2}$/u.test(date) || !Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0,10)!==date)throw waitlistError('Enter a valid delivery date.');
  details.deliveryDate = date;
  return details;
}
