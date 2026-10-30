import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../../../public/dispatch.js', import.meta.url), 'utf8');
function fn(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Missing production function ${name}`);
  const rest = source.slice(start + 1);
  const end = rest.search(/\n(?:async )?function /);
  assert.ok(end >= 0, `Missing boundary for ${name}`);
  return source.slice(start, start + 1 + end);
}

const addresses = {
  '3445': '3445 Kennedy Road, Toronto, ON',
  '2967': '2967 Kennedy Road, Toronto, ON',
  'UNILOCK Ayr': 'Ayr supplier address',
  Rymar: 'Rymar supplier address'
};
const names = [
  'normalizeText', 'normalizedPlaceKey', 'normalizedStreetAddressKey', 'canadianPostalCode',
  'addressMunicipalityKey', 'physicalAddressRegionCompatible', 'configuredOwnYardPlaces',
  'samePhysicalAddress', 'dropLocationForStop', 'dropAddressForStop', 'resolveStopPlace',
  'placePosition', 'fallbackPositionForAddress', 'stopAddress', 'physicalDropVisitKey',
  'physicalVisitsForLoad', 'consecutiveExactDropVisits', 'interStopForecastLegs',
  'travelLegEndpointMatchesVisit', 'travelLegMatchesVisitPair', 'travelLegForVisitPair',
  'travelLegExecutionStatus', 'renderInterStopTravelCard', 'renderCompactStopSequence',
  'renderPreviewStopSequence', 'renderLoadTimingDetails', 'previewVisitTiming'
];

function fixture() {
  const orders = [
    { id: 'PO-A', type: 'PO', sourceYard: 'UNILOCK Ayr', sourceAddress: addresses['UNILOCK Ayr'], destinationYard: '3445' },
    { id: 'PO-B', type: 'PO', sourceYard: 'Rymar', sourceAddress: addresses.Rymar, destinationYard: '2967' },
    { id: 'TO-A', type: 'TO', sourceYard: '3445', sourceAddress: addresses['3445'], destinationYard: '2967' }
  ];
  const load = { id: 'any-load', stops: [
    { id: 'a-pick', type: 'pick', orderId: 'PO-A', location: 'UNILOCK Ayr' },
    { id: 'a-drop', type: 'drop', orderId: 'PO-A', location: 'UNILOCK Ayr', dropLocation: '3445' },
    { id: 't-pick', type: 'pick', orderId: 'TO-A', location: '3445' },
    { id: 'b-pick', type: 'pick', orderId: 'PO-B', location: 'Rymar' },
    { id: 'b-drop', type: 'drop', orderId: 'PO-B', location: 'Rymar', dropLocation: '2967' },
    { id: 't-drop', type: 'drop', orderId: 'TO-A', location: '3445', dropLocation: '2967' }
  ] };
  // This is the reported zero-minute gap: drop ends and pickup starts at 14:22.
  const rows = [
    { arrival: 760, depart: 790 }, { arrival: 832, depart: 862 },
    { arrival: 862, depart: 880 }, { arrival: 910, depart: 940 },
    { arrival: 970, depart: 1000 }, { arrival: 1000, depart: 1030 }
  ];
  const state = { forecasts: [], evidence: [], stopRecords: {}, details: [] };
  const stopMarkup = (_truck, _load, stop) => `<stop id="${stop.id}" type="${stop.type}"></stop>`;
  const c = vm.createContext({
    ownYards: [], HUBS: Object.fromEntries(Object.entries(addresses).map(([key, address]) => [key, { address }])),
    MAP_CENTER: { lat: 43, lng: -79 },
    isMbtPlanningLoad: () => false,
    stopOrder: stop => orders.find(order => order.id === stop?.orderId),
    placeForLocation: location => addresses[location] ? { key: location, label: location, address: addresses[location] } : null,
    dispatchLocationHierarchyRoot: value => value,
    dropoffForStop: () => null, orderPosition: () => ({ lat: 43, lng: -79 }),
    forecastTravelRecordsForLoad: () => state.forecasts,
    interStopExecutionEvidenceForLoad: () => state.evidence,
    forecastRecordForStop: stop => state.stopRecords[stop?.id] || null,
    escapeHtml: value => String(value ?? ''),
    timestampMinuteOr: (value, fallback) => value || fallback,
    findLoad: () => ({}), timingSummaryHtml: () => '',
    renderStop: stopMarkup, renderPreviewStop: stopMarkup,
    renderCompactDropVisit: (_truck, _load, visit) => visit.entries.map(entry => stopMarkup(null, null, entry.stop)).join(''),
    renderPreviewDropVisit: (_truck, _load, visit) => visit.entries.map(entry => stopMarkup(null, null, entry.stop)).join(''),
    timingDetailHtml: value => { state.details.push(value); return ''; },
    driverRecordForStop: () => null, forecastTimingForStop: () => ({}),
    previewVisitExecutionStatus: () => 'pending', pickupStopLabel: stop => stop.location,
    dropStopLabel: (_stop, order) => order.id, stopArrivalTiming: () => ({}), recordCompletedAt: () => ''
  });
  vm.runInContext(names.map(fn).join('\n'), c);
  const visits = c.physicalVisitsForLoad(load, rows);
  const leg = (from, to, extra = {}) => ({ kind: 'inter_stop', legId: `${from}-${to}`, from, to, ...extra });
  state.forecasts = [leg('UNILOCK Ayr', '3445'), leg('3445', 'Rymar'), leg('Rymar', '2967')];
  return { c, load, rows, visits, state, leg, orders };
}

test('dispatch asset parses', () => { new vm.Script(source); });

for (const renderer of ['renderCompactStopSequence', 'renderPreviewStopSequence']) {
  test(`${renderer}: separate 3445 drop and pickup have no journey between them`, () => {
    const { c, load, rows } = fixture();
    const html = c[renderer]({}, load, { rows });
    const drop = '<stop id="a-drop" type="drop"></stop>';
    const pickup = '<stop id="t-pick" type="pick"></stop>';
    assert.ok(html.includes(drop + pickup), 'Drop and pickup must remain separate adjacent stops');
    assert.equal((html.match(/3445 to Rymar/g) || []).length, 1);
    assert.ok(html.indexOf('3445 to Rymar') > html.indexOf(pickup));
    assert.ok(html.indexOf('3445 to Rymar') < html.indexOf('<stop id="b-pick"'));
    assert.equal((html.match(/inter-stop-travel/g) || []).length, 3);
  });
}

test('timing details retain separate operations and omit zero-distance travel', () => {
  const { c, load, rows, state } = fixture();
  c.renderLoadTimingDetails({}, load, { rows });
  assert.deepEqual(state.details.filter(row => row.title.startsWith('Travel')).map(row => row.title), [
    'Travel UNILOCK Ayr to 3445', 'Travel 3445 to Rymar', 'Travel Rymar to 2967'
  ]);
  const drop = state.details.findIndex(row => row.title === 'Drop PO-A');
  assert.equal(state.details[drop + 1].title, 'Pickup 3445');
  assert.equal(state.details[drop].plannedEnd, 862);
  assert.equal(state.details[drop + 1].plannedStart, 862);
});

test('same-location rule applies to any stop types, load, customer address, and matching yard aliases', () => {
  const { c, state } = fixture();
  const visit = (address, type, id) => ({ address, entries: [{ stop: { id, type }, order: { id } }] });
  for (const [left, right] of [
    ['900 Example St, Toronto', '900 EXAMPLE ST Toronto'],
    [addresses['3445'], '3445 Kennedy Rd, Scarborough, ON'],
    [addresses['2967'], addresses['2967']],
    [addresses.Rymar, addresses.Rymar]
  ]) {
    for (const a of ['pick', 'drop']) for (const b of ['pick', 'drop']) {
      const previous = visit(left, a, 'previous');
      const next = visit(right, b, 'next');
      state.forecasts[0].status = 'complete';
      state.forecasts[0].actualArrival = '2026-10-22T18:22:00Z';
      assert.equal(c.travelLegForVisitPair({ id: 'another-load' }, previous, next, 0), null);
      assert.equal(c.renderInterStopTravelCard({}, previous, next, 0), '');
    }
  }
});

test('wrong array position cannot attach another journey to a pair', () => {
  const { c, load, visits, state } = fixture();
  const correct = state.forecasts[1];
  assert.equal(c.travelLegForVisitPair(load, visits[2], visits[3], 2), correct);
  state.forecasts = [state.forecasts[2]];
  assert.equal(c.travelLegForVisitPair(load, visits[2], visits[3], 0), null);
});

test('drop matches its physical destination, not the source of its order', () => {
  const { c, visits } = fixture();
  assert.equal(c.travelLegEndpointMatchesVisit('3445', visits[1]), true);
  assert.equal(c.travelLegEndpointMatchesVisit('UNILOCK Ayr', visits[1]), false);
  assert.equal(c.travelLegEndpointMatchesVisit('2967', visits[2]), false);
});

test('coincident planned timestamps cannot override the physical journey endpoints', () => {
  const { c, load, visits, state, leg } = fixture();
  state.stopRecords['t-pick'] = { plannedLeave: 'T1' };
  state.stopRecords['b-pick'] = { plannedArrival: 'T2' };
  const wrong = leg('Rymar', '2967', { plannedLeave: 'T1', plannedArrival: 'T2' });
  state.forecasts = [wrong, state.forecasts[1]];
  assert.equal(c.travelLegForVisitPair(load, visits[2], visits[3], 0), state.forecasts[1]);
});

test('completed travel evidence remains visible for its actual adjacent visits after forecast refresh', () => {
  const { c, load, visits, state, leg } = fixture();
  state.forecasts = [];
  const completed = leg('3445', 'Rymar', { status: 'complete', actualArrival: '2026-10-22T19:00:00Z' });
  state.evidence = [completed];
  assert.equal(c.travelLegForVisitPair(load, visits[2], visits[3], 2), completed);
  assert.match(c.renderInterStopTravelCard(load, visits[2], visits[3], 2), /status-complete/);
  assert.equal(c.travelLegForVisitPair(load, visits[1], visits[2], 1), null);
});

test('equal clock times alone do not hide travel between different locations', () => {
  const { c, load, visits, state } = fixture();
  state.forecasts = [];
  visits[3].entries[0].row.arrival = visits[2].entries[0].row.depart;
  assert.match(c.renderInterStopTravelCard(load, visits[2], visits[3], 2), /inter-stop-travel/);
});

test('pickup address overrides retain their logical forecast location', () => {
  const { c, load, rows, state, orders } = fixture();
  orders[2].pickupAddressOverride = 'External pickup site';
  const visits = c.physicalVisitsForLoad(load, rows);
  assert.equal(visits[2].address, 'External pickup site');
  assert.equal(c.travelLegForVisitPair(load, visits[2], visits[3], 2), state.forecasts[1]);
});
