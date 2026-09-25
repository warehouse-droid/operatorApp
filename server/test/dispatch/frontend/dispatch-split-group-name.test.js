import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { parse } from 'espree';
import fc from 'fast-check';

const source = readFileSync(process.env.SPLIT_GROUP_SOURCE || new URL('../../../public/dispatch.js', import.meta.url), 'utf8');
const node = parse(source, { ecmaVersion: 'latest', sourceType: 'script', range: true }).body
  .find(row => row.type === 'FunctionDeclaration' && row.id.name === 'groupedDispatchOrderId');
const context = vm.createContext({});
vm.runInContext(source.slice(...node.range), context);
const group = refs => context.groupedDispatchOrderId(refs.map(id => ({ id })));

test('SPLIT-NAME: the requested S1 identifier and all split member suffixes are retained', () => {
  assert.equal(group(['SOB120921-S1','SOB121097']), 'GOB-120921S1-121097');
  assert.equal(group(['SOB120921-S2','SOB120921-S1']), 'GOB-120921S1-120921S2');
  assert.equal(group(['TOB00321-S10','TOB00322-S3']), 'GOB-321S10-322S3');
  assert.equal(group(['POA00012-S2','POA00013']), 'GOA-12S2-13');
  assert.equal(context.groupedDispatchOrderId([{ id: 'CO-SOB120921-S1', type: 'CO' }, { id: 'CO-SOB121097', type: 'CO' }]), 'CO-GOB-120921S1-121097');
});

test('PROPERTY-NAME: member order and split indices do not lose the SX suffix', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 999999 }), fc.integer({ min: 1, max: 999 }), (number, split) => {
    const refs = [`SOB${number}-S${split}`, `SOB${number + 1}`];
    assert.equal(group(refs), `GOB-${number}S${split}-${number + 1}`);
    assert.equal(group(refs.slice().reverse()), group(refs));
  }), { seed: 120921, numRuns: 100 });
});
