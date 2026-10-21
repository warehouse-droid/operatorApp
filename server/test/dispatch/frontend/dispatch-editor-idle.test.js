import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import fc from 'fast-check';

const source = readFileSync(new URL('../../../public/dispatch-edit-activity.js', import.meta.url), 'utf8');
function fixture() {
  let now = 1000000, idle = 0, activity = 0, editing = true;
  const events = new Map(), intervals = new Map();
  const window = { addEventListener: (name, listener) => events.set(name, listener),
    setInterval: fn => { intervals.set(1, fn); return 1; }, clearInterval: id => intervals.delete(id) };
  vm.runInNewContext(source, { window, Date, Math, Number }, { filename: '/app/public/dispatch-edit-activity.js' });
  const tracker = window.DispatchEditActivity.create({ now: () => now,
    isEditing: () => editing, onIdle: () => { idle++; editing = false; }, onActivity: () => activity++ });
  return { tracker, events, intervals, advance: ms => { now += ms; }, setEditing: value => { editing = value; },
    get idle() { return idle; }, get activity() { return activity; },
    fire: (name, trusted = true) => events.get(name)?.({ isTrusted: trusted }), tick: () => intervals.get(1)?.() };
}

test('IDLE-01: at ten minutes without input editing ends exactly once', () => {
  const f = fixture(); f.tracker.start(); f.advance(599999); f.tick(); assert.equal(f.idle, 0);
  f.advance(1); f.tick(); assert.equal(f.idle, 1); f.tick(); assert.equal(f.idle, 1);
  assert.equal(f.intervals.size, 0);
});
test('IDLE-02: trusted activity resets age, synthetic and background events do not', () => {
  const f = fixture(); f.tracker.start(); f.advance(590000);
  f.fire('pointermove', false); f.fire('visibilitychange'); f.fire('scroll'); f.tick(); assert.equal(f.tracker.ageMs(), 590000);
  for (const name of ['pointermove', 'pointerdown', 'keydown', 'input', 'touchstart', 'touchmove', 'wheel']) {
    f.advance(6000); f.fire(name); assert.equal(f.tracker.ageMs(), 0, name);
  }
  assert.equal(f.activity, 7); f.advance(600000); f.tick(); assert.equal(f.idle, 1);
});
test('IDLE-03: late activity cannot revive idle mode; starting from server time preserves reload age', () => {
  const f = fixture(); f.tracker.start(500000); assert.equal(f.tracker.ageMs(), 500000);
  f.advance(100000); f.fire('keydown'); assert.equal(f.idle, 1); assert.equal(f.activity, 0);
  f.fire('pointerdown'); assert.equal(f.idle, 1);
});
test('IDLE-04: inactive pages do not record activity and stop removes the timer', () => {
  const f = fixture(); f.tracker.start(); f.setEditing(false); f.advance(10000); f.fire('keydown');
  assert.equal(f.tracker.ageMs(), 10000); f.tracker.stop(); f.advance(600000); f.tick(); assert.equal(f.idle, 0);
});
test('IDLE-05: arbitrary idle durations obey both sides of the ten minute boundary', () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 1200000 }), duration => {
    const f = fixture(); f.tracker.start(); f.advance(duration); f.tick();
    assert.equal(f.idle, duration >= 600000 ? 1 : 0);
  }), { seed: 20261015, numRuns: 150 });
});
