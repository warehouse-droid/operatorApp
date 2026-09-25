import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { parse } from 'espree';

const filename = path.resolve(process.env.RECEIPT_CONFIRMATION_SOURCE_FILE || 'public/operator.js');
const source = fs.readFileSync(filename, 'utf8');
const declarations = parse(source, { ecmaVersion: 'latest', sourceType: 'script', range: true }).body
  .filter(node => node.type === 'FunctionDeclaration');
let cursor = 0, functions = '';
for (const node of declarations) {
  functions += source.slice(cursor, node.start).replace(/[^\n]/gu, ' ') + source.slice(node.start, node.end);
  cursor = node.end;
}
functions += source.slice(cursor).replace(/[^\n]/gu, ' ');

export const order = { netsuite_id: '-185021706058979', order_type: 'purchase_order', tranid: 'SN1401278', destination_location_id: 1, lines: [] };
export const result = { receiptStatus: 'received', itemReceiptId: 1013762, itemReceiptTranid: 'IR14813',
  operatorNetSuitePosting: { transactions: [{ transactionType: 'IR', transactionRef: 'IR14813', transactionId: 1013762 }] } };
export function job(status = 'completed') {
  return { id: 'saved-request', requestId: 'saved-request', actorOperatorId: 'operator-a', functionKey: 'receiving', locationId: 1, status,
    steps: [{ transactionType: 'IR', status: status === 'completed' ? 'posted' : 'uncertain', transactionId: 1013762, transactionRef: 'IR14813' }],
    result: status === 'completed' ? { localFinalization: result } : {} };
}
export function harness(responses = [], initial = {}, storage = new Map()) {
  const calls = [], reloads = [], screens = [];
  const context = vm.createContext({ console, Date, Math, Set, Map, JSON, Promise,
    initialOperatorState: initial, STATE_KEY: 'mbbs.operator.state',
    receiptOrder: null, receivingSelectedId: order.netsuite_id, receivingSelectedOrder: null,
    receivingOrderType: 'purchase_order', receivingStep: 'orders', receivingSearch: 'SN1401278',
    receiptRequestId: '', receiptResult: null, receiptSubmitting: false, receiptPhotoDataUrls: [],
    receiptStatusText: '', receiptJobStage: '', receiptNetSuitePolicy: null, receiptNetSuitePolicyError: '',
    receiptActivePhotoSlot: 0, receiptStartedAt: 0, receiptCameraActive: false, operatorPhotoCamera: {},
    receiptServiceWorkerReloadPending: false, currentModule: 'receiving', locationId: 1,
    operator: { id: 'operator-a', display_name: 'Operator A' },
    window: { localStorage: {
      getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key),
    }, location: { reload: () => reloads.push('reload') } },
    app: { innerHTML: '' },
  });
  vm.runInContext(functions, context, { filename: path.resolve('public/operator.js') });
  Object.assign(context, {
    api: async (url, options) => {
      calls.push({ url, method: options?.method || 'GET' });
      const response = responses.shift();
      assert.ok(response, `Unexpected request ${url}`);
      if (response instanceof Error) throw response;
      return typeof response === 'function' ? response() : response;
    },
    render: () => screens.push(context.currentModule), showToast() {},
    loadReceivingOptions: async () => {}, loadReceivingOrders: async () => {}, loadReceivingItemSuggestions: async () => {},
    invalidateReceivingRequests() {}, stopReceiptCamera() {}, saveOperatorState() {},
    shell: (_title, _subtitle, body, actions = '') => body + actions,
    t: (_key, fallback) => fallback, tf: (_key, fallback) => fallback, localizeMessage: value => value,
    currentLocation: () => ({ text: '3445' }), renderCameraSwitchButton: () => '',
    escapeHtml: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
  });
  return { context, calls, storage, reloads, screens };
}
