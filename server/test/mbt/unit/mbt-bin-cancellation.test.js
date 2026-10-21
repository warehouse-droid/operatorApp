import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'espree';
import fc from 'fast-check';
import { MbtError } from '../../../src/mbt/errors.js';

function functions(file, names, values) {
  const source = readFileSync(file, 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', range: true });
  const context = vm.createContext(values);
  for (const node of ast.body) {
    if (node.type === 'FunctionDeclaration' && names.includes(node.id.name)) {
      vm.runInContext(source.slice(...node.range), context);
    }
  }
  return context;
}

for (const [adjustment, expected] of [[-110000, 55000], [0, 165000], [10000, 175000]]) {
  test(`approved ${adjustment}-cent adjustment changes the active customer total to ${expected}`, async () => {
    const api = functions('src/mbt/customer-charge-request-service.js',
      ['currentContractTotalMinor', 'safeAdd', 'nonnegativeInteger', 'failure'], {
        MbtError,
        query: async sql => sql.includes("request_kind = 'initial_bin'")
          ? { rowCount: 1, rows: [{ request_total_minor: 55000 }] }
          : { rowCount: 1, rows: [{ total_minor: sql.includes('mbt_contract_amendments') ? adjustment : 110000 }] }
      });
    assert.equal(await api.currentContractTotalMinor({ contract_id: 'contract', quote_id: 'quote' }), expected);
  });
}

test('an adjustment cannot make the active total negative', async () => {
  const api = functions('src/mbt/customer-charge-request-service.js',
    ['currentContractTotalMinor', 'safeAdd', 'nonnegativeInteger', 'failure'], { MbtError,
      query: async sql => sql.includes("request_kind = 'initial_bin'")
        ? { rowCount: 1, rows: [{ request_total_minor: 55000 }] }
        : { rowCount: 1, rows: [{ total_minor: sql.includes('mbt_contract_amendments') ? -200000 : 110000 }] }
    });
  await assert.rejects(() => api.currentContractTotalMinor({ contract_id: 'contract', quote_id: 'quote' }),
    error => error.code === 'MBT_FRONTDESK_CONFIGURATION_INVALID');
});

test('signed adjustments conserve the active total or reject a negative result across 200 generated amounts', async () => {
  let adjustment = 0;
  const api = functions('src/mbt/customer-charge-request-service.js',
    ['currentContractTotalMinor', 'safeAdd', 'nonnegativeInteger', 'failure'], { MbtError,
      query: async sql => sql.includes("request_kind = 'initial_bin'")
        ? { rowCount: 1, rows: [{ request_total_minor: 55000 }] }
        : { rowCount: 1, rows: [{ total_minor: sql.includes('mbt_contract_amendments') ? adjustment : 110000 }] }
    });
  await fc.assert(fc.asyncProperty(fc.integer({ min: -1000000, max: 1000000 }), async amount => {
    adjustment = amount;
    if (amount < -165000) {
      await assert.rejects(() => api.currentContractTotalMinor({ contract_id: 'contract', quote_id: 'quote' }),
        error => error.code === 'MBT_FRONTDESK_CONFIGURATION_INVALID');
    } else {
      assert.equal(await api.currentContractTotalMinor({ contract_id: 'contract', quote_id: 'quote' }) - 165000, amount);
    }
  }), { seed: 20261015, numRuns: 200 });
});

test('active physical-bin cards omit cancelled bins and retain the other bins', () => {
  const texts = [];
  const node = () => ({ hidden: false, append() {}, replaceChildren() {} });
  const api = functions('public/mbt-frontdesk.js', ['renderContract'], {
    contractCard: node(), workspaceEmpty: node(), quoteCard: node(),
    element: (_name, text) => { texts.push(text); return node(); }, button: node,
    fullAddress: () => '', displayDate: () => '', contractLineContent: () => '', binAvailableForService: () => false,
    state: { contract: { revision: 1, contractNumber: 'Synthetic' }, chargeRequests: [], amendments: [], visits: [],
      serviceLines: [{ serviceLineId: 'cancelled', lineNumber: 1, status: 'cancelled' },
        { serviceLineId: 'active', lineNumber: 2, status: 'scheduled', customerConfirmation: {} }] }
  });
  api.renderContract();
  assert.ok(!texts.some(text => String(text).startsWith('Line 1 ·')));
  assert.ok(texts.some(text => String(text).startsWith('Line 2 ·')));
});
