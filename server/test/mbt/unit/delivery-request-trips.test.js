import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {normalizeDeliveryPricing,deliveryJourneyRoutes,calculateDeliveryJourneyQuote} from '../../../src/delivery-request-domain.js';
import {pricing,graph,clock} from '../support/delivery-request-fixtures.js';

const multi=()=>pricing({tripType:'multi_stop',tripLegs:[
  {pickupYardCode:'3445',dropoffAddress:'200 Dropoff Road',totalUnits:10},
  {pickupAddress:'200 Dropoff Road',dropoffYardCode:'2967',totalUnits:30}]});
test('trip types: legacy and explicit single journeys keep existing billing and round trips include the reverse route',()=>{
  const single=calculateDeliveryJourneyQuote(pricing({tripType:'single'}),graph(),{'3445>customer':{providerMetres:20000}},clock.settings);
  assert.equal(single.totalAmountMinor,47000);assert.equal(single.trips,2);
  const routes=deliveryJourneyRoutes(pricing({tripType:'round_trip'}));
  assert.ok(routes.some(leg=>leg.key==='3445<customer' && leg.originAddressText===pricing().deliveryAddress && leg.destinationYardCode==='3445'));
  const round=calculateDeliveryJourneyQuote(pricing({tripType:'round_trip'}),graph(),
    {'3445>customer':{providerMetres:20000},'3445<customer':{providerMetres:50001,destinationSnapshot:{addressText:'Yard pickup'}}},clock.settings);
  assert.equal(round.totalAmountMinor,80500);assert.equal(round.trips,3);assert.equal(round.returnAmountMinor,33500);
  assert.equal(round.outbounds[1].legType,'return');assert.equal(round.outbounds[1].pickupAddress,pricing().deliveryAddress);
});
test('multi-stop journeys retain ordered pickup/dropoff quantities and price every leg independently',()=>{
  const input=multi(),normalized=normalizeDeliveryPricing(input),routes=deliveryJourneyRoutes(input);
  assert.deepEqual(normalized.tripLegs,input.tripLegs);assert.equal(normalized.totalUnits,40);assert.equal(normalized.deliveryAddress,'MBBS yard 2967');
  assert.equal(routes[0].originYardCode,'3445');assert.equal(routes[1].destinationYardCode,'2967');
  const quote=calculateDeliveryJourneyQuote(input,graph(),{'trip:0':{providerMetres:20000},'trip:1':{providerMetres:50001}},clock.settings);
  assert.equal(quote.totalAmountMinor,90500);assert.equal(quote.trips,3);
  assert.deepEqual(quote.outbounds.map(leg=>leg.totalUnits),[10,30]);assert.deepEqual(quote.outbounds.map(leg=>leg.trips),[1,2]);
  assert.deepEqual(normalizeDeliveryPricing(normalized),normalized);
});
test('trip types reject malformed leg addresses and quantities and unavailable route evidence',()=>{
  for(const input of [pricing({tripType:'other'}),pricing({tripType:'multi_stop'}),
    {...multi(),tripLegs:multi().tripLegs.slice(0,1)},{...multi(),tripLegs:Array(21).fill(multi().tripLegs[0])},
    {...multi(),tripLegs:[{dropoffAddress:'200 Dropoff Road',pickupAddress:'Any address',totalUnits:10},multi().tripLegs[1]]},
    {...multi(),tripLegs:[multi().tripLegs[0],{pickupAddress:'200 Dropoff Road',dropoffAddress:'Any address',totalUnits:10}]},
    {...multi(),tripLegs:[{...multi().tripLegs[0],pickupYardCode:'OTHER'},multi().tripLegs[1]]},
    {...multi(),tripLegs:[{...multi().tripLegs[0],totalUnits:0},multi().tripLegs[1]]},
    {...multi(),tripLegs:[{...multi().tripLegs[0],totalUnits:1.5},multi().tripLegs[1]]}]) {
    assert.throws(()=>normalizeDeliveryPricing(input),{code:'DELIVERY_REQUEST_INVALID'});
  }
  assert.throws(()=>calculateDeliveryJourneyQuote(multi(),graph(),{'trip:0':{providerMetres:20000}},clock.settings),{code:'DELIVERY_QUOTE_UNAVAILABLE'});
});
test('generated per-leg quantities preserve exact trip counts and additive charges',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:5000}),fc.integer({min:1,max:5000}),(first,second)=>{
    const input=multi();input.tripLegs[0].totalUnits=first;input.tripLegs[1].totalUnits=second;
    const quote=calculateDeliveryJourneyQuote(input,graph(),{'trip:0':{providerMetres:20000},'trip:1':{providerMetres:20000}},clock.settings);
    assert.equal(quote.trips,Math.ceil(first/26)+Math.ceil(second/26));
    assert.equal(quote.totalAmountMinor,quote.trips*23500);
  }),{seed:14102026,numRuns:100});
});
test('round-trip consolidation includes one return in every alternative and selects the cheapest complete route',()=>{
  const input=pricing({tripType:'round_trip',outbounds:[{originYardCode:'3445',totalUnits:1},{originYardCode:'150',totalUnits:1}]});
  const routes=Object.fromEntries(deliveryJourneyRoutes(input).map(leg=>[leg.key,{providerMetres:leg.key==='3445<customer'?100000:20000}]));
  const quote=calculateDeliveryJourneyQuote(input,graph(),routes,clock.settings);
  assert.equal(quote.consolidationYardCode,'150');assert.equal(quote.totalAmountMinor,70500);assert.equal(quote.trips,3);
  assert.equal(quote.returnTrips,1);assert.equal(quote.outbounds.at(-1).legType,'return');
  assert.equal(quote.alternatives.find(option=>option.consolidationYardCode==='3445').returnAmountMinor,56000);
});
test('BIN journeys retain fractional Yard quantities and still charge exactly one round-trip return',()=>{
  const input=pricing({tripType:'round_trip',loadType:'bin',totalUnits:14.01,quantityUnit:'yard',binTypeCode:'14YD',aggregate:'Gravel',binCapacityYards:14});
  const quote=calculateDeliveryJourneyQuote(input,graph('bin'),{'3445>customer':{providerMetres:20000},'3445<customer':{providerMetres:50001}},clock.settings);
  assert.equal(quote.totalAmountMinor,40000);assert.equal(quote.trips,3);assert.equal(quote.returnTrips,1);
});
