import { calculateLocalRate } from './mbt/local-rate-calculator.js';

/**
 * @typedef {{pos:number,bin:number}} DeliveryCapacities
 * @typedef {DeliveryCapacities & {approvalHours:number,reminderHours:number}} DeliverySettings
 * @typedef {{originYardCode:string,totalUnits:number,loadType?:string,fullPosQty?:number,loosePosQty?:number}} DeliveryOutbound
 * @typedef {DeliveryOutbound & {sourceYardCodes:string[]}} BillingOutbound
 * @typedef {{requestingYardLocationId:number,loadType:'pos'|'bin',deliveryAddress:string,outbounds:DeliveryOutbound[],
 *   pricingOriginYardCode?:string,totalUnits?:number,binTypeCode?:string|null,quantityUnit?:string,aggregate?:string,binCapacityYards?:number,
 *   tripType?:string,tripLegs?:DeliveryTripLeg[]}} DeliveryPricingInput
 * @typedef {DeliveryPricingInput & {pricingOriginYardCode:string,totalUnits:number,binTypeCode:string|null}} DeliveryPricing
 * @typedef {{date:string,start:string,end:string,timeZone?:string}} DeliveryWindow
 * @typedef {{pickupAddress?:string,dropoffAddress?:string,pickupYardCode?:string,dropoffYardCode?:string,totalUnits:number}} DeliveryTripLeg
 * @typedef {{id?:string,role?:string,roles?:string[],publicSales?:boolean,yardLocationIds?:(number|string)[]}} DeliveryActor
 * @typedef {{itemCode:string,originYardCodes:string[],binTypeCode?:string|null,[key:string]:unknown}} DeliveryBand
 * @typedef {{rateCardCode:string,currency:string,rateCardVersionId:string,versionNumber:number,displayName:string,bands:DeliveryBand[]}} DeliveryRateGraph
 * @typedef {{providerMetres:number,destinationSnapshot?:{addressText?:string,[key:string]:unknown},[key:string]:unknown}} DeliveryRouteEvidence
 * @typedef {{requestingYardLocationId:number,status:string,revision:number,requestedWindow:DeliveryWindow,
 *   proposedWindow:DeliveryWindow|null,confirmedWindow:DeliveryWindow|null,pendingWindow?:DeliveryWindow|null,pendingWindowProposedBy?:string|null,approvalExpiresAt:string|null,
 *   reminderAt:string|null,reminderSentAt:string|null,securedAt?:string|null,salesOrderRefs:string[],[key:string]:unknown}} DeliveryRequest
 * @typedef {{expectedRevision:number,window?:DeliveryWindow,salesOrderRefs?:unknown[],message?:unknown}} DeliveryTransitionInput
 * @typedef {{now?:string|Date,settings?:DeliverySettings}} DeliveryTransitionOptions
 * @typedef {{now:string,settings?:DeliverySettings}} ResolvedTransitionOptions
 */
export class DeliveryRequestError extends Error {
  /** @param {string} code @param {string} message @param {number} [status] */
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
/** @type {Readonly<Record<number,string>>} */
export const DELIVERY_YARDS = Object.freeze({ 1: '3445', 28: '2967', 15: '12441', 26: '150' });
export const DELIVERY_DEFAULT_SETTINGS = Object.freeze({ pos: 26, bin: 1, approvalHours: 3, reminderHours: 1 });
export const DELIVERY_AGGREGATES = Object.freeze(['Gravel','HPE','Screening','Crusher Run']);
/** @param {DeliveryPricingInput & {tripType?:string,tripLegs?:DeliveryTripLeg[]}} input */
function normalizeTrip(input) {
  if(input.tripType===undefined && input.tripLegs===undefined) {return {};}
  if(!['single','round_trip','multi_stop'].includes(input.tripType || '')) {invalid('Choose Single trip, Round trip or Multi-stop trip.');}
  const tripType=String(input.tripType);
  if(input.tripType!=='multi_stop') {
    if(input.tripLegs?.length) {invalid('Only multi-stop trips can contain manually entered legs.');}
    return {tripType};
  }
  if(!Array.isArray(input.tripLegs) || input.tripLegs.length<2 || input.tripLegs.length>20) {invalid('Enter two to twenty trip legs.');}
  const last=input.tripLegs.length-1;
  return {tripType,tripLegs:input.tripLegs.map((leg,index)=>({
    ...tripEndpoint(leg,'pickup',index===0),...tripEndpoint(leg,'dropoff',index===last),
    totalUnits:input.quantityUnit==='yard'?yardQuantity(leg?.totalUnits,'Leg quantity'):positiveInteger(leg?.totalUnits,'Leg quantity')
  }))};
}
/** @param {DeliveryTripLeg} leg @param {'pickup'|'dropoff'} side @param {boolean} yardRequired */
function tripEndpoint(leg,side,yardRequired) {
  if(!leg) {invalid('Each trip leg requires pickup, drop-off and quantity.');}
  const code=side==='pickup'?leg.pickupYardCode:leg.dropoffYardCode;
  if(yardRequired || code) {
    if(!Object.values(DELIVERY_YARDS).includes(code || '')) {invalid(`${side==='pickup'?'First pickup':'Last drop-off'} must be an MBBS yard.`);}
    const yard=String(code);
    return side==='pickup'?{pickupYardCode:yard}:{dropoffYardCode:yard};
  }
  const address=tripAddress(side==='pickup'?leg.pickupAddress:leg.dropoffAddress,side==='pickup'?'Pickup':'Drop-off');
  return side==='pickup'?{pickupAddress:address}:{dropoffAddress:address};
}
/** @param {unknown} value @param {string} label */
function tripAddress(value,label) {
  if(typeof value!=='string' || !value.trim() || value.trim().length>2000) {invalid(`${label} requires an address of at most 2000 characters.`);}
  return value.trim();
}
/** @param {DeliveryPricingInput} input */
export function deliveryJourneyRoutes(input) {
  const pricing=normalizeDeliveryPricing(input);
  if(pricing.tripType==='multi_stop') {
    return (pricing.tripLegs || []).map((leg,index)=>({key:`trip:${index}`,originAddressText:leg.pickupAddress,originYardCode:leg.pickupYardCode,
      destinationAddressText:leg.dropoffAddress,destinationYardCode:leg.dropoffYardCode}));
  }
  const forward=deliveryConsolidationRoutes(pricing);
  return pricing.tripType==='round_trip'?[...forward,...deliveryBillingOutbounds(pricing).map(yard=>({
    key:`${yard.originYardCode}<customer`,originAddressText:pricing.deliveryAddress,destinationYardCode:yard.originYardCode
  }))]:forward;
}
/** @param {Record<string,DeliveryRouteEvidence>} routes @param {string} key */
function journeyRoute(routes,key) {
  const route=routes[key];
  if(!route || !Number.isSafeInteger(route.providerMetres) || route.providerMetres<0) {throw new DeliveryRequestError('DELIVERY_QUOTE_UNAVAILABLE','Every trip leg needs valid driving route evidence.');}
  return route;
}
/** @param {DeliveryPricing} pricing @param {DeliveryRateGraph} graph @param {Record<string,DeliveryRouteEvidence>} routes
 * @param {string} origin @param {number} capacity */
function roundReturn(pricing,graph,routes,origin,capacity) {
  const route=journeyRoute(routes,`${origin}<customer`);
  return {...quoteOutbound(pricing,{originYardCode:origin,totalUnits:capacity},graph,route.providerMetres,capacity),...route,totalUnits:0,
    pickupAddress:pricing.deliveryAddress,dropoffAddress:String(route.destinationSnapshot?.addressText || origin),legType:'return'};
}
/** @param {DeliveryPricingInput} input @param {DeliveryRateGraph} graph
 * @param {Record<string,DeliveryRouteEvidence>} routes @param {DeliveryCapacities} capacities */
export function calculateDeliveryJourneyQuote(input,graph,routes,capacities) {
  const pricing=normalizeDeliveryPricing(input),capacity=deliveryCapacity(pricing,capacities);
  if(pricing.tripType==='multi_stop') {
    const outbounds=(pricing.tripLegs || []).map((leg,index)=>{
      const route=journeyRoute(routes,`trip:${index}`);
      return {...quoteOutbound(pricing,{originYardCode:pricing.pricingOriginYardCode,totalUnits:leg.totalUnits},graph,route.providerMetres,capacity),
        ...route,...leg,legType:'delivery'};
    });
    return {currency:'CAD',capacityPerTrip:capacity,outbounds,trips:outbounds.reduce((sum,leg)=>sum+leg.trips,0),
      totalAmountMinor:safeMoney(outbounds.reduce((sum,leg)=>sum+leg.totalAmountMinor,0))};
  }
  const groups=deliveryBillingOutbounds(pricing);
  if(groups.length>1) {return calculateConsolidatedDeliveryQuote(pricing,graph,routes,capacities);}
  const first=groups[0];if(!first) {invalid('Choose a pickup yard.');}
  const origin=first.originYardCode,route=journeyRoute(routes,`${origin}>customer`);
  const quote=calculateDeliveryQuote(pricing,graph,route.providerMetres,capacities);
  const outbounds=quote.outbounds.map(leg=>({...leg,...route}));
  if(pricing.tripType!=='round_trip') {return {...quote,outbounds};}
  const returnLeg=roundReturn(pricing,graph,routes,origin,capacity);
  return {...quote,outbounds:[...outbounds,returnLeg],deliveryTrips:quote.trips,returnTrips:returnLeg.trips,returnAmountMinor:returnLeg.totalAmountMinor,
    trips:quote.trips+returnLeg.trips,totalAmountMinor:safeMoney(quote.totalAmountMinor+returnLeg.totalAmountMinor)};
}
/** @param {string} message @returns {never} */
function invalid(message) { throw new DeliveryRequestError('DELIVERY_REQUEST_INVALID', message); }
/** @param {string} message @returns {never} */
function conflict(message) { throw new DeliveryRequestError('DELIVERY_STATE_CONFLICT', message, 409); }
/** @param {number} value @param {string} label @param {number} [maximum] */
function positiveInteger(value, label, maximum = 1000000000) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {invalid(`${label} must be a positive whole number.`);}
  return value;
}
/** @param {DeliveryCapacities} input */
export function normalizeDeliveryCapacities(input) {
  return { pos: positiveInteger(input?.pos, 'POS capacity', 10000), bin: positiveInteger(input?.bin, 'BIN capacity', 10000) };
}
/** @param {DeliverySettings} input */
export function normalizeDeliverySettings(input) {
  const capacities = normalizeDeliveryCapacities(input);
  const approvalHours = input?.approvalHours, reminderHours = input?.reminderHours;
  if (typeof approvalHours !== 'number' || !Number.isFinite(approvalHours) || approvalHours <= 0 || approvalHours > 720
    || typeof reminderHours !== 'number' || !Number.isFinite(reminderHours) || reminderHours < 0 || reminderHours >= approvalHours) {
    invalid('Approval hours must be positive; reminder hours must be between zero and the approval duration.');
  }
  return { ...capacities, approvalHours, reminderHours };
}
/** @param {number|undefined} value @param {string} label */
function palletCount(value,label) {
  if(value===undefined || !Number.isSafeInteger(value) || value<0 || value>1000000000) {invalid(`${label} must be a nonnegative whole number.`);}
  return value;
}
/** @param {number} value @param {string} label */
function yardQuantity(value,label) {
  if(typeof value!=='number' || !Number.isFinite(value) || value<=0 || value>1000000000 || value!==Math.round(value*100)/100) {
    invalid(`${label} must be positive with at most two decimal places.`);
  }
  return value;
}
/** @param {DeliveryPricingInput} input @param {DeliveryOutbound} yard */
function outboundQuantity(input,yard) {
  if(input.loadType==='pos' && (yard.fullPosQty!==undefined || yard.loosePosQty!==undefined)) {
    const fullPosQty=palletCount(yard.fullPosQty,'Full POS qty'),loosePosQty=palletCount(yard.loosePosQty,'Loose POS qty');
    const totalUnits=positiveInteger(fullPosQty+loosePosQty,'Outbound quantity');
    if(yard.totalUnits!==undefined && yard.totalUnits!==totalUnits) {invalid('Outbound quantity must equal full plus loose POS.');}
    return {totalUnits,fullPosQty,loosePosQty};
  }
  return {totalUnits:input.quantityUnit==='yard'?yardQuantity(yard.totalUnits,'Yard quantity'):positiveInteger(yard.totalUnits,'Outbound quantity')};
}
/** @param {DeliveryPricingInput} input @returns {DeliveryOutbound[]} */
function normalizeOutbounds(input) {
  if (!Array.isArray(input.outbounds) || !input.outbounds.length || input.outbounds.length > 4) {invalid('Choose one to four outbound yards.');}
  const seen = new Set();
  const outbounds = input.outbounds.map(yard => {
    const originYardCode = String(yard?.originYardCode || '').trim();
    if (!Object.values(DELIVERY_YARDS).includes(originYardCode) || seen.has(originYardCode)
      || (yard.loadType && yard.loadType !== input.loadType)) {invalid('Each outbound yard must be unique and use the request load type.');}
    seen.add(originYardCode);
    return { originYardCode, ...outboundQuantity(input,yard) };
  });
  return outbounds;
}
/** @param {DeliveryPricingInput} input @param {DeliveryOutbound[]} outbounds */
function normalizePricingOrigin(input,outbounds) {
  const pricingOriginYardCode = String(input.pricingOriginYardCode || outbounds[0]?.originYardCode);
  const billingPair = ['3445','2967'];
  if (!outbounds.some(yard => yard.originYardCode === pricingOriginYardCode
    || (billingPair.includes(yard.originYardCode) && billingPair.includes(pricingOriginYardCode)))) {invalid('Choose a pricing origin for the outbound yards.');}
  return pricingOriginYardCode;
}
/** @param {DeliveryPricingInput} input @returns {DeliveryPricing} */
export function normalizeDeliveryPricing(input) {
  if (!Object.hasOwn(DELIVERY_YARDS, input?.requestingYardLocationId)) {invalid('Choose a requesting yard.');}
  if (!['pos', 'bin'].includes(input?.loadType)) {invalid('Choose POS or BIN.');}
  const trip=normalizeTrip(input);
  input=tripPricingBasis(input,trip.tripLegs);
  const deliveryAddress = String(input.deliveryAddress || '').trim();
  if (!deliveryAddress || deliveryAddress.length > 2000) {invalid('A delivery address of at most 2000 characters is required.');}
  const outbounds=normalizeOutbounds(input),pricingOriginYardCode=normalizePricingOrigin(input,outbounds);
  const totalUnits=input.quantityUnit==='yard'
    ? yardQuantity(outbounds.reduce((sum,yard)=>sum+Math.round(yard.totalUnits*100),0)/100,'Total quantity')
    : positiveInteger(outbounds.reduce((sum,yard)=>sum+yard.totalUnits,0),'Total quantity');
  if (input.totalUnits !== undefined && input.totalUnits !== totalUnits) {invalid('Total quantity must equal the outbound quantities.');}
  const binTypeCode=normalizeBinType(input);
  const binQuantity=normalizeBinQuantity(input);
  return {requestingYardLocationId:Number(input.requestingYardLocationId),loadType:input.loadType,totalUnits,pricingOriginYardCode,outbounds,deliveryAddress,binTypeCode,...binQuantity,...trip};
}
/** @param {DeliveryPricingInput} input @param {DeliveryTripLeg[]|undefined} legs @returns {DeliveryPricingInput} */
function tripPricingBasis(input,legs) {
  if(!legs) {return input;}
  const units=legs.reduce((sum,leg)=>sum+Math.round(leg.totalUnits*100),0)/100;
  const origin=String(legs[0]?.pickupYardCode),last=legs.at(-1);
  return {...input,totalUnits:units,pricingOriginYardCode:origin,deliveryAddress:last?.dropoffYardCode?`MBBS yard ${last.dropoffYardCode}`:last?.dropoffAddress || '',outbounds:[{originYardCode:origin,totalUnits:units}]};
}
/** @param {DeliveryPricingInput} input */
function normalizeBinQuantity(input) {
  if(input.quantityUnit===undefined) {return {};}
  if(input.loadType!=='bin' || input.quantityUnit!=='yard') {invalid('BIN quantities must use Yard.');}
  const aggregate=input.aggregate || '';
  if(!DELIVERY_AGGREGATES.includes(aggregate)) {invalid('Choose Gravel, HPE, Screening or Crusher Run.');}
  return {quantityUnit:'yard',aggregate,binCapacityYards:yardQuantity(input.binCapacityYards ?? 0,'BIN capacity in yards')};
}
/** @param {DeliveryPricing} pricing @param {DeliveryCapacities} capacities */
function deliveryCapacity(pricing,capacities) {
  const capacity=normalizeDeliveryCapacities(capacities)[pricing.loadType];
  return pricing.quantityUnit==='yard'?Math.round(capacity*(pricing.binCapacityYards ?? 0)*100)/100:capacity;
}
/** @param {DeliveryPricingInput} input */
function normalizeBinType(input) {
  if(input.loadType!=='bin') { return null; }
  const code=String(input.binTypeCode || '').trim().toUpperCase();
  if(!code || code.length>30) { invalid('Choose a BIN size.'); }
  return code;
}
/** @param {DeliveryPricing} pricing @returns {BillingOutbound[]} */
export function deliveryBillingOutbounds(pricing) {
  /** @type {Map<string,BillingOutbound>} */
  const groups = new Map();
  for (const yard of pricing.outbounds) {
    const paired = ['3445','2967'].includes(yard.originYardCode), key = paired ? '3445/2967' : yard.originYardCode;
    let group=groups.get(key);
    if (!group) {
      group={originYardCode:paired && ['3445','2967'].includes(pricing.pricingOriginYardCode)
        ? pricing.pricingOriginYardCode : yard.originYardCode,totalUnits:0,sourceYardCodes:[]};
      groups.set(key,group);
    }
    group.totalUnits = pricing.quantityUnit==='yard'?Math.round((group.totalUnits+yard.totalUnits)*100)/100:group.totalUnits+yard.totalUnits;
    group.sourceYardCodes.push(yard.originYardCode);
  }
  return [...groups.values()];
}
/** @param {DeliveryPricingInput} input */
export function deliveryConsolidationRoutes(input) {
  const pricing = normalizeDeliveryPricing(input), groups = deliveryBillingOutbounds(pricing);
  return groups.flatMap(target => [
    { key:`${target.originYardCode}>customer`,originYardCode:target.originYardCode,deliveryAddress:pricing.deliveryAddress },
    ...groups.filter(source => source !== target).map(source => ({ key:`${source.originYardCode}>${target.originYardCode}`,
      originYardCode:source.originYardCode,destinationYardCode:target.originYardCode }))
  ]);
}
/** @param {DeliveryPricing} pricing @param {BillingOutbound[]} groups @param {BillingOutbound} target
 * @param {DeliveryRateGraph} graph @param {Record<string,DeliveryRouteEvidence>} routes @param {number} capacity */
function pricedConsolidation(pricing, groups, target, graph, routes, capacity) {
  /** @param {string} origin @param {number} units @param {string|null} [destinationYardCode] */
  const charge = (origin, units, destinationYardCode = null) => {
    const key = `${origin}>${destinationYardCode || 'customer'}`, route = routes[key];
    if (!route || !Number.isSafeInteger(route.providerMetres)) {throw new DeliveryRequestError('DELIVERY_QUOTE_UNAVAILABLE','Every consolidation option needs a valid driving route.');}
    return { ...quoteOutbound(pricing,{originYardCode:origin,totalUnits:units},graph,route.providerMetres,capacity),
      ...route,destinationYardCode,legType:destinationYardCode ? 'transfer' : 'delivery',routeKey:key };
  };
  const transferLegs = groups.filter(group => group !== target).map(group => charge(group.originYardCode,group.totalUnits,target.originYardCode));
  const deliveryLeg = charge(target.originYardCode,pricing.totalUnits);
  const returnLeg=pricing.tripType==='round_trip'?roundReturn(pricing,graph,routes,target.originYardCode,capacity):null;
  const transferAmountMinor = safeMoney(transferLegs.reduce((sum,leg) => sum+leg.totalAmountMinor,0));
  return { consolidationYardCode:target.originYardCode,transferLegs,deliveryLeg,
    transferAmountMinor,deliveryAmountMinor:deliveryLeg.totalAmountMinor,
    totalAmountMinor:safeMoney(transferAmountMinor+deliveryLeg.totalAmountMinor+(returnLeg?.totalAmountMinor || 0)),
    ...(returnLeg?{returnLeg,returnTrips:returnLeg.trips,returnAmountMinor:returnLeg.totalAmountMinor}:{}),
    transferTrips:transferLegs.reduce((sum,leg) => sum+leg.trips,0),deliveryTrips:deliveryLeg.trips };
}
/** @param {DeliveryPricingInput} input @param {DeliveryRateGraph} graph
 * @param {Record<string,DeliveryRouteEvidence>} routes @param {DeliveryCapacities} capacities */
export function calculateConsolidatedDeliveryQuote(input, graph, routes, capacities) {
  const pricing = normalizeDeliveryPricing(input), capacity = deliveryCapacity(pricing,capacities);
  const groups = deliveryBillingOutbounds(pricing);
  const alternatives = groups.map(target => pricedConsolidation(pricing,groups,target,graph,routes,capacity));
  alternatives.sort((left,right) => left.totalAmountMinor-right.totalAmountMinor);
  // Pricing normalization guarantees at least one billing yard and candidate.
  const cheapest = /** @type {ReturnType<typeof pricedConsolidation>} */ (alternatives[0]);
  return { ...cheapest,currency:'CAD',capacityPerTrip:capacity,trips:cheapest.transferTrips+cheapest.deliveryTrips+(cheapest.returnTrips || 0),
    outbounds:[...cheapest.transferLegs,cheapest.deliveryLeg,...(cheapest.returnLeg?[cheapest.returnLeg]:[])],
    alternatives:alternatives.map(option => ({consolidationYardCode:option.consolidationYardCode,
      transferAmountMinor:option.transferAmountMinor,deliveryAmountMinor:option.deliveryAmountMinor,totalAmountMinor:option.totalAmountMinor,
      ...(option.returnLeg?{returnAmountMinor:option.returnAmountMinor}:{})})) };
}
/** @param {DeliveryWindow|null|undefined} input */
export function normalizeDeliveryWindow(input) {
  const date = windowField(input,'date'), start = windowField(input,'start'), end = windowField(input,'end');
  if (!validCalendarDate(date) || !validTime(start) || !validTime(end)
    || start >= end || (input?.timeZone && input.timeZone !== 'America/Toronto')) {invalid('Choose a valid date and start/end time in Toronto time.');}
  /** @param {string} value */
  const minutes = value => Number(value.slice(0,2))*60 + Number(value.slice(3));
  if (minutes(end)-minutes(start) < 120) {invalid('End time must be at least 2 hours after start time.');}
  return { date, start, end, timeZone: 'America/Toronto' };
}
/** @param {DeliveryWindow|null|undefined} input @param {'date'|'start'|'end'} key */
const windowField=(input,key)=>String(input?.[key] || '');
/** @param {string} date */
function validCalendarDate(date) {
  const parsed=new Date(`${date}T12:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,10)===date;
}
/** @param {string} value */
const validTime=value=>/^([01]\d|2[0-3]):[0-5]\d$/.test(value);
/** @param {DeliveryActor} actor @param {string} audience @param {Set<string>} roles */
function allowedAudience(actor,audience,roles) {
  if(!actor?.id || actor.publicSales) {return false;}
  if(roles.has('admin')) {return ['sales','dispatch'].includes(audience);}
  return audience==='dispatch'?roles.has('dispatcher'):audience==='sales' && roles.has('sales');
}
/** @param {DeliveryActor} actor @param {number} yard @param {string} audience */
export function assertDeliveryYard(actor, yard, audience) {
  const roles = new Set([actor?.role, ...(actor?.roles || [])].map(role => String(role || '').toLowerCase().replaceAll('-', '_')));
  const validYard=audience!=='sales' || roles.has('admin') || (actor?.yardLocationIds || []).map(Number).includes(Number(yard));
  if (!allowedAudience(actor,audience,roles) || !validYard) {
    throw new DeliveryRequestError('DELIVERY_ACCESS_DENIED', 'You do not have access to this delivery request.', 403);
  }
  if (!Object.hasOwn(DELIVERY_YARDS, yard)) {invalid('Unknown requesting yard.');}
  return Number(yard);
}
/** @param {number} value */
function safeMoney(value) {
  if (!Number.isSafeInteger(value) || value < 0) {throw new DeliveryRequestError('DELIVERY_QUOTE_OVERFLOW', 'The quote exceeds safe integer cents.');}
  return value;
}
/** @param {DeliveryPricing} pricing @param {DeliveryOutbound} yard @param {DeliveryRateGraph|undefined} graph
 * @param {number|undefined} metres @param {number} capacityPerTrip */
function quoteOutbound(pricing, yard, graph, metres, capacityPerTrip) {
  const pos = pricing.loadType === 'pos';
  const expectedCard = pos ? 'DELIVERY_CHARGE_MBBS' : 'DELIVERY_CHARGE_MBT_2026_RATE';
  if (graph?.rateCardCode !== expectedCard || graph.currency !== 'CAD') {
    throw new DeliveryRequestError('DELIVERY_QUOTE_UNAVAILABLE', 'The active transport rate card is unavailable.');
  }
  const rateOriginYardCode = ['3445','2967'].includes(yard.originYardCode) ? yard.originYardCode : '3445';
  const bands = (graph.bands || []).filter(band => band.itemCode === (pos ? 'DELIVERY_CHARGE_MBBS' : 'DELIVERY_CHARGE_MBT')
    && band.originYardCodes?.includes(rateOriginYardCode) && (pos ? !band.binTypeCode : band.binTypeCode === pricing.binTypeCode));
  if (!bands.length) {throw new DeliveryRequestError('DELIVERY_QUOTE_UNAVAILABLE', `No transport rate covers yard ${yard.originYardCode} and this load type/size.`);}
  let rate;
  try {
    rate = calculateLocalRate({ rateCardVersionId: graph.rateCardVersionId, currency: 'CAD',
      serviceCode: pos ? 'mbbs_cross_charge' : 'delivery', binTypeCode: pricing.binTypeCode,
      rawDistanceMetres: metres, distanceBands: bands, components: [] });
  } catch (error) {throw rateFailure(error);}
  const trips = pricing.quantityUnit==='yard'
    ? Math.ceil(Math.round(yard.totalUnits*100)/Math.round(capacityPerTrip*100)) : Math.ceil(yard.totalUnits / capacityPerTrip);
  const rawDistanceMetres=rate.rawDistanceMetres;
  return { ...yard, rateOriginYardCode,trips, capacityPerTrip, rawDistanceMetres, rateCardCode: expectedCard,
    rateCardVersionId: graph.rateCardVersionId, versionNumber: graph.versionNumber, rateCardName: graph.displayName,
    selectedDistanceBandId: rate.selectedDistanceBandId, unitAmountMinor: rate.subtotalMinor,
    totalAmountMinor: safeMoney(rate.subtotalMinor * trips), explanation: {...rate.calculationExplanation,rawDistanceMetres} };
}
/** @param {unknown} error */
function rateFailure(error) {
  const cause=error instanceof Error?error:new Error(String(error));
  return new DeliveryRequestError('code' in cause && cause.code === 'MBT_RATE_MONEY_OVERFLOW' ? 'DELIVERY_QUOTE_OVERFLOW' : 'DELIVERY_QUOTE_UNAVAILABLE', cause.message);
}
/** @param {DeliveryPricingInput} input @param {DeliveryRateGraph|DeliveryRateGraph[]} graphs
 * @param {number|number[]} distances @param {DeliveryCapacities} capacities */
export function calculateDeliveryQuote(input, graphs, distances, capacities) {
  const pricing = normalizeDeliveryPricing(input);
  const billingOutbounds = deliveryBillingOutbounds(pricing);
  const cards = Array.isArray(graphs) ? graphs : [graphs], metres = Array.isArray(distances) ? distances : [distances];
  if (cards.length !== billingOutbounds.length || metres.length !== billingOutbounds.length) {invalid('Every billing yard needs route and rate evidence.');}
  const capacityPerTrip = deliveryCapacity(pricing,capacities);
  const outbounds = billingOutbounds.map((yard, index) => quoteOutbound(pricing, yard, cards[index], metres[index], capacityPerTrip));
  const single=outbounds.length===1?outbounds[0]:null;
  return { currency: 'CAD', capacityPerTrip, outbounds, trips: outbounds.reduce((sum, yard) => sum + yard.trips, 0),
    totalAmountMinor: safeMoney(outbounds.reduce((sum, yard) => sum + yard.totalAmountMinor, 0)),
    ...(single ? { unitAmountMinor: single.unitAmountMinor, rateCardVersionId: single.rateCardVersionId } : {}) };
}
/** @param {unknown} input */
export function normalizeSalesOrderReferences(input) {
  // Keep the existing salesOrderRefs contract for saved requests and older clients.
  if (!Array.isArray(input) || !input.length || input.length > 50) {invalid('Enter at least one Sales or Transfer Order number (maximum 50).');}
  if(input.some(value=>typeof value!=='string')) {invalid('Order numbers must be text.');}
  const refs = input.map(value => value.trim().toUpperCase());
  if (refs.some(ref => !/^(?:SO|TO)[A-Z0-9][A-Z0-9._/-]{0,77}$/.test(ref))) {invalid('Enter valid order numbers starting with SO or TO.');}
  return [...new Set(refs)];
}
/** @param {DeliveryRequest} row @param {string|Date} [now] */
export function deliveryApprovalDue(row, now = new Date()) {
  if (!['preapproved', 'proposed'].includes(row.status) || !row.approvalExpiresAt) {return null;}
  const instant = new Date(now).getTime();
  if (instant >= new Date(row.approvalExpiresAt).getTime()) {return 'expire';}
  if (!row.reminderSentAt && row.reminderAt && instant >= new Date(row.reminderAt).getTime()) {return 'remind';}
  return null;
}
/** @param {DeliveryRequest} row @returns {DeliveryRequest} */
function clearApproval(row) {
  return { ...row, approvalExpiresAt: null, reminderAt: null, reminderSentAt: null, confirmedWindow: null,
    proposedWindow: null, securedAt: null, salesOrderRefs: [] };
}
/** @param {DeliveryRequest} row @param {DeliverySettings} settings @param {string} now @returns {DeliveryRequest} */
function startApproval(row, settings, now) {
  const config = normalizeDeliverySettings(settings);
  const deadline = new Date(now).getTime() + config.approvalHours * 3600000;
  return { ...row, approvalSettings: config, approvalExpiresAt: new Date(deadline).toISOString(),
    reminderAt: new Date(deadline - config.reminderHours * 3600000).toISOString(), reminderSentAt: null };
}
/** @param {DeliveryRequest} row @param {DeliveryTransitionInput} input
 * @param {ResolvedTransitionOptions} options @param {string} action @returns {DeliveryRequest} */
function dispatchApproval(row,input,options,action) {
  if(!['submitted','proposed','preapproved'].includes(row.status)) {conflict('Dispatch cannot approve this request in its current state.');}
  const next=startApproval(clearApproval(row),options.settings || DELIVERY_DEFAULT_SETTINGS,options.now);
  next.status=action==='confirm'?'preapproved':'proposed';
  if(action==='confirm') {next.confirmedWindow=normalizeDeliveryWindow(row.requestedWindow);}
  else {next.proposedWindow=normalizeDeliveryWindow(input.window);}
  return next;
}
/** @param {DeliveryRequest} row @param {boolean} [pendingRequired] */
function assertSecuredTimeChange(row,pendingRequired=false) {
  if(row.status!=='confirmed' || !row.confirmedWindow || !row.salesOrderRefs.length) {
    conflict('Only a secured delivery request can request a time change.');
  }
  if(pendingRequired && !row.pendingWindow) {conflict('There is no pending time change.');}
}
/** @param {DeliveryRequest} row @returns {DeliveryRequest} */
function dismissTimeChange(row) {
  assertSecuredTimeChange(row,true);
  return {...row,pendingWindow:null,...proposalOwner(row,null)};
}
/** @param {DeliveryRequest} row @param {string|null} owner */
function proposalOwner(row,owner) {
  return Object.hasOwn(row,'pendingWindowProposedBy')?{pendingWindowProposedBy:owner}:{};
}
/** @param {DeliveryRequest} row @param {string} audience */
function assertTimeChangeRecipient(row,audience) {
  assertSecuredTimeChange(row,true);
  const proposer=row.pendingWindowProposedBy || 'sales';
  if(proposer===audience) {conflict('Only the other team can decide this proposed timeslot.');}
}
/** @param {DeliveryRequest} row @returns {DeliveryRequest} */
function acceptTimeChange(row) {
  return {...row,confirmedWindow:normalizeDeliveryWindow(row.pendingWindow),pendingWindow:null,...proposalOwner(row,null)};
}
/** @type {Record<string,(row:DeliveryRequest,input:DeliveryTransitionInput,options:ResolvedTransitionOptions)=>DeliveryRequest>} */
const transitions={
  reply(row,input) {normalizeDeliveryReply(input.message);return row;},
  confirm:(row,input,options)=>dispatchApproval(row,input,options,'confirm'),
  propose:(row,input,options)=>dispatchApproval(row,input,options,'propose'),
  accept(row) {
    if(row.status!=='proposed') {conflict('There is no proposed time to accept.');}
    return {...row,status:'preapproved',confirmedWindow:normalizeDeliveryWindow(row.proposedWindow)};
  },
  counter(row,input) {
    if(!['proposed','preapproved'].includes(row.status)) {conflict('There is no approval to counter.');}
    return {...clearApproval(row),status:'submitted',requestedWindow:normalizeDeliveryWindow(input.window)};
  },
  secure(row,input,options) {
    if(row.status!=='preapproved') {conflict('Accept or obtain Dispatch approval before entering Sales or Transfer Orders.');}
    return {...row,status:'confirmed',salesOrderRefs:normalizeSalesOrderReferences(input.salesOrderRefs),
      securedAt:options.now,approvalExpiresAt:null,reminderAt:null,reminderSentAt:null};
  },
  relink(row,input) {
    if(row.status!=='confirmed') {conflict('Only a secured delivery request can change order links.');}
    return {...row,salesOrderRefs:normalizeSalesOrderReferences(input.salesOrderRefs)};
  },
  'request-time-change'(row,input) {
    assertSecuredTimeChange(row);
    return {...row,pendingWindow:normalizeDeliveryWindow(input.window),...proposalOwner(row,'sales')};
  },
  'counter-time-change'(row,input) {
    assertSecuredTimeChange(row,true);
    return {...row,pendingWindow:normalizeDeliveryWindow(input.window),pendingWindowProposedBy:'dispatch'};
  },
  'accept-time-change'(row) {
    assertTimeChangeRecipient(row,'dispatch');
    return acceptTimeChange(row);
  },
  'accept-counter-time-change'(row) {
    assertTimeChangeRecipient(row,'sales');
    return acceptTimeChange(row);
  },
  'decline-time-change'(row) {
    assertTimeChangeRecipient(row,'dispatch');
    return dismissTimeChange(row);
  },
  'withdraw-counter-time-change'(row) {
    assertSecuredTimeChange(row,true);
    if(row.pendingWindowProposedBy!=='dispatch') {conflict('There is no Dispatch counter-proposal to withdraw.');}
    return dismissTimeChange(row);
  },
  'withdraw-time-change':dismissTimeChange,
  edit(row) {
    if(row.status!=='submitted') {conflict('This request cannot be edited in its current state.');}
    return {...clearApproval(row),status:'submitted'};
  },
  reraise(row) {
    if(row.status!=='expired') {conflict('This request cannot be re-raised in its current state.');}
    return {...clearApproval(row),status:'submitted'};
  },
  cancel(row) {
    if(row.status==='cancelled') {conflict('This request is already cancelled.');}
    return {...row,status:'cancelled',approvalExpiresAt:null,reminderAt:null,salesOrderRefs:[],pendingWindow:null,...proposalOwner(row,null)};
  }
};
/** @param {DeliveryRequest} row @param {string} action @param {DeliveryTransitionInput} input
 * @param {DeliveryActor} actor @param {string} audience @param {DeliveryTransitionOptions} [options] */
export function transitionDeliveryRequest(row, action, input, actor, audience, options = {}) {
  assertDeliveryYard(actor, row.requestingYardLocationId, audience);
  if (input.expectedRevision !== row.revision) {throw new DeliveryRequestError('DELIVERY_STALE_REVISION', 'This request changed. Refresh before replying.', 409);}
  const salesActions = ['edit', 'accept', 'counter', 'secure', 'relink', 'reraise', 'request-time-change', 'withdraw-time-change','accept-counter-time-change'];
  const dispatchActions = ['confirm', 'propose', 'accept-time-change', 'decline-time-change','counter-time-change','withdraw-counter-time-change'];
  if ((salesActions.includes(action) && audience !== 'sales') || (dispatchActions.includes(action) && audience !== 'dispatch')) {
    throw new DeliveryRequestError('DELIVERY_ACCESS_DENIED', 'This action belongs to the other team.', 403);
  }
  const now = new Date(options.now || new Date()).toISOString();
  assertApprovalActive(row,action,now);
  const apply=transitions[action];
  if(!Object.hasOwn(transitions,action) || !apply) {invalid('Unknown delivery request action.');}
  const next=apply(row,input,{...options,now});
  return { ...next, revision: row.revision + 1 };
}
/** @param {DeliveryRequest} row @param {string} action @param {string} now */
function assertApprovalActive(row,action,now) {
  if(['cancel','reply'].includes(action)) {return;}
  if(deliveryApprovalDue(row,now)==='expire') {
    throw new DeliveryRequestError('DELIVERY_APPROVAL_EXPIRED','This approval expired. Re-raise the request for Dispatch approval.',409);
  }
}
/** @param {unknown} value */
export function normalizeDeliveryReply(value) {
  if(typeof value!=='string' || !value.trim() || value.trim().length>2000) {invalid('Enter a reply of 1 to 2000 characters.');}
  return value.trim();
}
