import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeOperatorKitSource, mapOperatorKitSelections, assertOperatorKitStepCurrent,
  operatorStepHasKits } from '../../../src/operator-netsuite-posting-kits.js';
import { kitFixture, sobFixture, kitDraft } from '../../support/operator-kit-fixture.mjs';

const rejected = { code: 'OPERATOR_NETSUITE_POSTING_KIT_INVALID' };
const resolve = fixture => {
  const source = normalizeOperatorKitSource(fixture.evidence);
  return { source, lines: mapOperatorKitSelections(source, fixture.selected) };
};

test('SOB120656 sends the kit parent and retains the physical sand confirmation', () => {
  const fixture = sobFixture();
  const { source, lines } = resolve(fixture);
  const draft = kitDraft(source, lines);
  assert.deepEqual(draft.steps[0].payload.item.items, [
    { orderLine: 1, quantity: 95.6, location: 1, itemReceive: true },
    { orderLine: 2, quantity: 1, location: 1, itemReceive: true }
  ]);
  assert.equal(operatorStepHasKits(draft.steps[0]), true);
  assert.deepEqual(draft.steps[0].lineSnapshot[1].kit.physicalLines, [fixture.selected[1]]);
  assert.equal(draft.steps[0].lineSnapshot[1].kit.definition.parent.itemId, 10126);
  assert.equal(draft.steps[0].lineSnapshot[1].kit.definition.members[0].itemId, 599);
  assert.ok(draft.claims.includes('source:IF:SO:997764'));
  assertOperatorKitStepCurrent(draft.steps[0], source);
});

test('several members collapse once and fewer complete kits than ordered are allowed', () => {
  const { source, lines } = resolve(kitFixture({ ordered: 5, count: 2, ratios: [2, 3, 0.5] }));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].quantity, 2);
  assert.deepEqual(lines[0].kit.physicalLines.map(line => line.quantity), [4, 6, 1]);
  assert.equal(kitDraft(source, lines).steps[0].payload.item.items[0].quantity, 2);
});

test('the same member SKU in different kits keeps its exact parent identity', () => {
  const a = kitFixture({ ordered: 4, count: 2 });
  const b = kitFixture({ ordered: 4, count: 3, kitOffset: 1 });
  const evidence = Object.fromEntries(Object.keys(a.evidence).map(key => [key, [...a.evidence[key], ...b.evidence[key]]]));
  const source = normalizeOperatorKitSource(evidence);
  const selected = mapOperatorKitSelections(source, [...b.selected, ...a.selected]);
  assert.deepEqual(selected.map(line => [line.orderLine, line.quantity]), [[2, 2], [12, 3]]);
});

for (const [name, change] of [
  ['missing member', f => f.selected.pop()],
  ['fractional kit', f => { f.selected.forEach(line => { line.quantity /= 2; }); }],
  ['unequal counts', f => { f.selected[0].quantity += 2; }],
  ['over remaining', f => { f.evidence.sourceItems[0].quantityFulfilled = 1; }],
  ['wrong item', f => { f.selected[0].itemId = 1234; }],
  ['wrong stable key', f => { f.selected[0].sourceLineKey = '1'; }],
  ['duplicate physical line', f => f.selected.push({ ...f.selected[0] })],
  ['different inventory location', f => { f.selected[0].location = 15; }],
  ['NaN quantity', f => { f.selected[0].quantity = NaN; }],
  ['negative quantity', f => { f.selected[0].quantity = -1; }],
  ['parent selected directly', f => { f.selected[0].sourceLineKey = '4974657'; f.selected[0].itemId = 10126; }]
]) {
  test(`rejects ${name} before posting`, () => {
    const fixture = kitFixture({ ratios: [2, 3] }); change(fixture);
    assert.throws(() => resolve(fixture), rejected);
  });
}

for (const [name, change] of [
  ['definition ratio changed', f => { f.evidence.kitDefinitions[0].member.items[0].quantity = 2; }],
  ['missing definition member', f => { f.evidence.kitDefinitions[0].member.items = []; }],
  ['duplicate member SKU definition', f => f.evidence.kitDefinitions[0].member.items.push({ ...f.evidence.kitDefinitions[0].member.items[0] })],
  ['nested kit', f => { f.evidence.sourceRows[1].itemtype = 'Kit'; }],
  ['serial member', f => { f.evidence.sourceRows[1].isserialitem = 'T'; }],
  ['lot member', f => { f.evidence.sourceRows[1].islotitem = 'T'; }],
  ['bin member', f => { f.evidence.sourceRows[1].usebins = 'T'; }],
  ['unknown inventory flags', f => { delete f.evidence.sourceRows[1].usebins; }],
  ['drop ship member', f => { f.evidence.kitDefinitions[0].member.items[0].dropShipMember = true; }],
  ['nonfulfillable kit', f => { f.evidence.kitDefinitions[0].isFulfillable = false; }],
  ['conflicting source identity', f => { f.evidence.sourceItems[0].lineUniqueKey = 2; }],
  ['wrong kit relationship', f => { f.evidence.sourceRows[1].kitmemberof = '8'; }],
  ['duplicate REST identity', f => f.evidence.sourceItems.push({ ...f.evidence.sourceItems[0] })],
  ['missing REST parent', f => { f.evidence.sourceItems = []; }],
  ['different member location', f => { f.evidence.sourceRows[1].location = '15'; }]
]) {
  test(`fails closed on ${name}`, () => {
    const fixture = kitFixture(); change(fixture);
    assert.throws(() => normalizeOperatorKitSource(fixture.evidence), rejected);
  });
}

test('pre-POST validation rejects a changed definition, location, identity or exhausted quantity', () => {
  const f = kitFixture({ ordered: 3, count: 2 });
  const { source, lines } = resolve(f);
  const step = { ...kitDraft(source, lines).steps[0] };
  for (const change of [
    current => { current.kitGroups[0].members[0].quantityPerKit = 3; },
    current => { current.kitGroups[0].parent.location = 15; },
    current => { current.kitGroups[0].members[0].sourceLineKey = 'new'; },
    current => { current.availableLines[0].remainingQuantity = 1; }
  ]) {
    const current = structuredClone(source); change(current);
    assert.throws(() => assertOperatorKitStepCurrent(step, current), rejected);
  }
  const validProgress = structuredClone(source); validProgress.availableLines[0].remainingQuantity = 2;
  assertOperatorKitStepCurrent(step, validProgress);
});

test('source reads must agree about the parent quantity and every REST source line', () => {
  const mismatch = kitFixture(); mismatch.evidence.sourceRows[0].quantity = '-4';
  assert.throws(() => normalizeOperatorKitSource(mismatch.evidence), rejected);
  const extra = kitFixture(); extra.evidence.sourceItems.push({ ...extra.evidence.sourceItems[0], line: 90 });
  assert.throws(() => normalizeOperatorKitSource(extra.evidence), rejected);
});

test('combined local allocations cannot exceed one source kit remaining quantity', () => {
  const { source, lines } = resolve(kitFixture());
  assert.throws(() => kitDraft(source, [...lines, ...structuredClone(lines)]), rejected);
});

test('a saved kit quantity that disagrees with physical confirmations cannot post', () => {
  const { source, lines } = resolve(kitFixture({ ordered: 3, count: 2 }));
  const step = kitDraft(source, lines).steps[0];
  step.lineSnapshot[0].quantity = 1;
  assert.throws(() => assertOperatorKitStepCurrent(step, source), rejected);
});
