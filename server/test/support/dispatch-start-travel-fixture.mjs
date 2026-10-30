import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

export const sourcePath = process.env.DISPATCH_TRAVEL_SOURCE || new URL('../../public/dispatch.js', import.meta.url);
export const source = readFileSync(sourcePath, 'utf8');
export const guardNames = [
  'executionStatusFromRecord', 'loadDriverActivityRecords',
  'isPhysicalDriverActivityRecord', 'stopDriverActivityRecords',
  'stopHasDriverActivity', 'physicalActivityPositionChanged',
  'driverActivityDetails', 'dispatchEditableRouteBoundary'
];

export function sourceFunction(name, input = source) {
  const start = input.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Missing ${name}`);
  const next = input.indexOf('\nfunction ', start + 1);
  assert.ok(next > start, `Missing end of ${name}`);
  return input.slice(start, next).trimEnd();
}

export const runtimeSource = guardNames.map(name => sourceFunction(name)).join('\n\n');
export const runtimePath = path.join(process.env.DISPATCH_TRAVEL_ARTIFACT_DIR || '/app/test-artifacts', 'dispatch-travel-runtime.js');

export function browserGuard(activity = [], code = runtimeSource) {
  mkdirSync(path.dirname(runtimePath), { recursive: true });
  writeFileSync(runtimePath, code);
  const context = vm.createContext({ driverJobStatuses: activity });
  vm.runInContext(code, context, { filename: runtimePath });
  return context;
}

export function route({ loadId = 'dao-load-2', yard = 'UNILOCK Ayr' } = {}) {
  const load = {
    id: loadId,
    name: 'Load 2',
    driverLogin: 'dao',
    stops: [
      { id: 'unilock-pick', type: 'pick', location: yard, orderId: 'VENDOR-A', orderRefs: ['VENDOR-A'] },
      { id: 'unilock-drop', type: 'drop', orderId: 'VENDOR-A', dropAddress: '3445 yard' },
      { id: 'rymar-pick', type: 'pick', location: 'Rymar', orderId: 'VENDOR-B', orderRefs: ['VENDOR-B'] },
      { id: 'rymar-drop', type: 'drop', orderId: 'VENDOR-B', dropAddress: '2967 yard' },
      { id: 'transfer-pick', type: 'pick', location: '3445', orderId: 'TRANSFER', orderRefs: ['TRANSFER'] },
      { id: 'transfer-drop', type: 'drop', orderId: 'TRANSFER', dropAddress: '2967 yard' }
    ]
  };
  return load;
}

export function initialTravel(load = route(), overrides = {}) {
  return {
    load_id: load.id,
    job_id: [366, 'T4', load.id, 'TRAVEL', 'Previous delivery', load.stops[0]?.location, '']
      .map(value => encodeURIComponent(String(value || ''))).join(':'),
    stop_id: `travel-Previous delivery-${load.stops[0]?.location}`,
    stop_type: 'travel',
    status: 'in_progress',
    job_details: { toStopId: '', fromStopId: '' },
    ...overrides
  };
}

export function suffixMove(load) {
  const [first, second, third, fourth, fifth, sixth] = load.stops;
  return [first, second, fifth, sixth, third, fourth];
}
