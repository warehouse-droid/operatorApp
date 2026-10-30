import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { evaluateExecutedPrefixPolicy } from '../../../src/dispatch-planner-performance.js';
import { browserGuard, initialTravel, route, suffixMove } from '../../support/dispatch-start-travel-fixture.mjs';

test('Dao Load 2: initial travel permits moving the later transfer pair above Rymar', () => {
  const load = route();
  const ui = browserGuard([initialTravel(load)]);
  assert.equal(ui.dispatchEditableRouteBoundary(load), 0);
  assert.equal(ui.physicalActivityPositionChanged(load, suffixMove(load)), false);
});

test('initial travel keeps its destination pickup and all preceding stops in place', () => {
  const load = route();
  const ui = browserGuard([initialTravel(load)]);
  const stops = [...load.stops];
  stops.unshift(stops.pop());
  assert.equal(ui.physicalActivityPositionChanged(load, stops), true);
});

test('initial travel resolves the first pickup after a preceding delivery', () => {
  const load = route();
  const travel = initialTravel(load);
  load.stops.unshift({ id: 'service-drop', type: 'drop', orderId: 'SERVICE' });
  const ui = browserGuard([travel]);
  assert.equal(ui.dispatchEditableRouteBoundary(load), 1);
  assert.equal(ui.physicalActivityPositionChanged(load, [load.stops[1], load.stops[0], ...load.stops.slice(2)]), true);
});

test('a repeated yard later in the route does not become the initial destination', () => {
  const load = route();
  load.stops[4].location = load.stops[0].location;
  assert.equal(browserGuard([initialTravel(load)]).dispatchEditableRouteBoundary(load), 0);
});

test('camelCase travel records and string details resolve the same destination', () => {
  const load = route();
  const record = initialTravel(load);
  const travel = { loadId: record.load_id, jobId: record.job_id, stopId: record.stop_id,
    stopType: 'travel', status: 'in_progress', jobDetails: '{}' };
  assert.equal(browserGuard([travel]).dispatchEditableRouteBoundary(load), 0);
});

test('physical activity takes the maximum boundary and keeps recorded work locked', () => {
  const load = route();
  for (const status of ['in_progress', 'complete']) {
    const activity = [initialTravel(load), { load_id: load.id, stop_id: 'rymar-drop', stop_type: 'dropoff', status }];
    const ui = browserGuard(activity);
    assert.equal(ui.dispatchEditableRouteBoundary(load), 3);
    assert.equal(ui.physicalActivityPositionChanged(load, suffixMove(load)), true);
  }
});

test('explicit and legacy inter-stop target evidence keeps precedence', () => {
  const load = route();
  for (const details of [{ toStopId: 'rymar-pick' }, { to_stop_id: 'rymar-pick' }, JSON.stringify({ toStopId: 'rymar-pick' })]) {
    assert.equal(browserGuard([initialTravel(load, { job_details: details })]).dispatchEditableRouteBoundary(load), 2);
  }
  assert.equal(browserGuard([initialTravel(load, { stop_id: 'travel-unilock-drop-rymar-pick' })]).dispatchEditableRouteBoundary(load), 2);
});

test('missing and invalid details still allow recovery from the authoritative initial-travel ID', () => {
  const load = route();
  for (const details of [null, '{invalid', 'null']) {
    assert.equal(browserGuard([initialTravel(load, { job_details: details })]).dispatchEditableRouteBoundary(load), 0);
  }
});

test('ambiguous, wrong-load and inter-stop identifiers keep the conservative boundary', () => {
  const load = route();
  const travel = initialTravel(load);
  const cases = [
    '', 'malformed', travel.job_id + ':extra', travel.job_id + 'inter-stop-leg',
    travel.job_id.replace(':TRAVEL:', ':RETURN:'),
    travel.job_id.replace(encodeURIComponent(load.id), 'OTHER'),
    travel.job_id.replace('UNILOCK%20Ayr', 'Other%20vendor'),
    travel.job_id.replace('UNILOCK%20Ayr', '%E0%A4%A')
  ];
  for (const jobId of cases) {
    assert.equal(browserGuard([{ ...travel, job_id: jobId }]).dispatchEditableRouteBoundary(load), 5, jobId);
  }
  const noPickup = { ...load, stops: load.stops.map(stop => ({ ...stop, type: 'drop' })) };
  assert.equal(browserGuard([travel]).dispatchEditableRouteBoundary(noPickup), 5);
});

test('completed, pending and unrelated travel leave an unstarted route editable', () => {
  const load = route();
  for (const extra of [{ status: 'complete' }, { status: 'pending' }, { load_id: 'OTHER' }]) {
    assert.equal(browserGuard([initialTravel(load, extra)]).dispatchEditableRouteBoundary(load), -1);
  }
  assert.equal(browserGuard([]).dispatchEditableRouteBoundary(load), -1);
  assert.equal(browserGuard([initialTravel(load)]).dispatchEditableRouteBoundary({ id: load.id, stops: [] }), -1);
});

test('the browser guard leaves route and activity evidence unchanged', () => {
  const load = route();
  const activity = [initialTravel(load)];
  const before = structuredClone({ load, activity });
  browserGuard(activity).physicalActivityPositionChanged(load, suffixMove(load));
  assert.deepEqual({ load, activity }, before);
});

test('the real server policy accepts this suffix move and still rejects recorded physical changes', () => {
  const load = route();
  const previousPlan = { id: 366, orders: [], trucks: [{ id: 'T4', plate: 'TRUCK', driverLogin: 'dao', loads: [load] }] };
  const nextPlan = structuredClone(previousPlan);
  nextPlan.trucks[0].loads[0].stops = suffixMove(nextPlan.trucks[0].loads[0]);
  assert.equal(evaluateExecutedPrefixPolicy({ previousPlan, nextPlan, activity: [initialTravel(load)] }).allowed, true);
  assert.equal(evaluateExecutedPrefixPolicy({ previousPlan, nextPlan, activity: [
    { load_id: load.id, stop_id: 'rymar-drop', stop_type: 'dropoff', status: 'complete' }
  ] }).allowed, false);
});

test('property: encoded load IDs and pickup names preserve the exact initial-travel boundary', () => {
  fc.assert(fc.property(
    fc.array(fc.constantFrom('a', ':', '-', '%', ' ', '/', '北', 'é', '🚚'), { minLength: 1, maxLength: 25 }).map(chars => chars.join('')),
    fc.array(fc.constantFrom('A', ':', '-', '%', ' ', '/', '仓', 'é', '🚚'), { minLength: 1, maxLength: 25 }).map(chars => chars.join('')),
    (loadId, yard) => {
      const load = route({ loadId, yard });
      const ui = browserGuard([initialTravel(load)]);
      assert.equal(ui.dispatchEditableRouteBoundary(load), 0);
      assert.equal(ui.physicalActivityPositionChanged(load, suffixMove(load)), false);
      const travel = initialTravel(load);
      for (const [index, value] of [[2, encodeURIComponent(loadId + 'other')], [3, 'RETURN'],
        [5, encodeURIComponent(yard + 'other')], [6, 'inter-stop-leg']]) {
        const parts = travel.job_id.split(':');
        parts[index] = value;
        assert.equal(browserGuard([{ ...travel, job_id: parts.join(':') }]).dispatchEditableRouteBoundary(load), 5);
      }
      assert.equal(browserGuard([{ ...travel, job_id: travel.job_id + ':' }]).dispatchEditableRouteBoundary(load), 5);
    }
  ), { seed: 20261022, numRuns: 100 });
});

test('property: every suffix permutation stays editable while a moved destination remains locked', () => {
  fc.assert(fc.property(fc.shuffledSubarray([1, 2, 3, 4, 5], { minLength: 5, maxLength: 5 }), indexes => {
    const load = route();
    const ui = browserGuard([initialTravel(load)]);
    const suffix = indexes.map(index => load.stops[index]);
    assert.equal(ui.physicalActivityPositionChanged(load, [load.stops[0], ...suffix]), false);
    assert.equal(ui.physicalActivityPositionChanged(load, [...suffix, load.stops[0]]), true);
  }), { seed: 3667164, numRuns: 100 });
});
