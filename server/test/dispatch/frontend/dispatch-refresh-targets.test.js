import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { parse } from 'espree';
import fc from 'fast-check';

const source = readFileSync(new URL('../../../public/dispatch.js', import.meta.url), 'utf8');
const node = parse(source, { ecmaVersion: 'latest', sourceType: 'script', range: true }).body
  .find(node => node.type === 'FunctionDeclaration' && node.id.name === 'dispatchRefreshableOrderRefs');

function subject(extra) {
  assert.ok(node, 'Refresh target selector exists');
  const context = vm.createContext({ Map, Set,
    dispatchOrderRefKey: value => String(value || '').trim().toUpperCase(),
    orders: [], orderCatalog: [], assignedOrderEvidenceById: new Map(),
    isAuthoritativelyRetiredOrderRef: ref => ref.startsWith('RETIRED-'), ...extra });
  vm.runInContext(source.slice(0, node.range[0]).replace(/[^\n]/g, ' ') + source.slice(...node.range), context,
    { filename: 'dispatch-refresh-targets-vm:public/dispatch.js' });
  return context;
}

test('refresh target properties: only matching eligible canonical identities are requested, once', () => {
  fc.assert(fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 40 }), choices => {
    const cards = choices.map((_, i) => ({ id: `SO-TARGET-${i}`, netsuiteId: String(90000 + i) }));
    const refs = choices.flatMap((selected, i) => selected
      ? [cards[i].netsuiteId, cards[i].netsuiteId, cards[i].id.toLowerCase()]
      : [`UNKNOWN-${i}`]);
    const ui = subject({ orders: cards, orderCatalog: cards,
      assignedOrderEvidenceById: new Map(cards.map(card => [card.id, card])) });
    assert.deepEqual([...ui.dispatchRefreshableOrderRefs(refs)].sort(),
      cards.filter((_, i) => choices[i]).map(card => card.id).sort());
  }), { seed: 20261019, numRuns: 150 });
});

test('refresh targets preserve assigned evidence and expand a shared source alias into its current split cards', () => {
  const ui = subject({ orders: [{ id: 'SO-SOURCE-S1', netsuiteId: '123' }],
    orderCatalog: [{ id: 'SO-SOURCE-S2', netsuiteId: '123' }],
    assignedOrderEvidenceById: new Map([['SO-ASSIGNED', { id: 'SO-ASSIGNED', netsuiteId: '456' }]]) });
  assert.deepEqual([...ui.dispatchRefreshableOrderRefs(['123', '456'])].sort(),
    ['SO-ASSIGNED', 'SO-SOURCE-S1', 'SO-SOURCE-S2']);
});

test('refresh targets exclude missing and retired cards even when their event aliases match', () => {
  const ui = subject({ orders: [null, {}, { id: 'RETIRED-SO', netsuiteId: '123' }, { id: 'SO-ACTIVE', netsuiteId: '123' }] });
  assert.deepEqual([...ui.dispatchRefreshableOrderRefs(['123', 'RETIRED-SO', 'UNKNOWN'])], ['SO-ACTIVE']);
  assert.deepEqual([...ui.dispatchRefreshableOrderRefs([])], []);
});

test('explicit structural results load new and restored cards outside the pool, while retired refs stay excluded', () => {
  const ui = subject({});
  assert.deepEqual([...ui.dispatchRefreshableOrderRefs([], ['GOA-NEW', 'SO-RESTORED', 'GOA-NEW', 'RETIRED-SO', ''])],
    ['GOA-NEW', 'SO-RESTORED']);
});
