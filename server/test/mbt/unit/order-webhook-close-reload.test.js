import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// NetSuite's native Close button does not run afterSubmit; the order webhook
// User Event must send the close from the view-mode reload (beforeLoad).
const source = fs.readFileSync(new URL('../../../netsuite-order-webhook-user-event-direct.js', import.meta.url), 'utf8');
const libSource = fs.readFileSync(new URL('../../../netsuite-order-webhook-lib.js', import.meta.url), 'utf8');
const retrySource = fs.readFileSync(new URL('../../../netsuite-order-webhook-retry-scheduled.js', import.meta.url), 'utf8');
const NOW = Date.parse('2026-10-30T20:31:00.000Z');

// Loads a NetSuite AMD module the way NetSuite does, with mocked N/ modules.
function loadModule(code, modules, DateClass) {
  let exported;
  vm.runInNewContext(code, { Date: DateClass, define: (names, factory) => {
    exported = factory(...names.map(name => {
      if (!(name in modules)) throw new Error(`missing module ${name}`);
      return modules[name];
    }));
  } });
  return exported;
}

// Item master data as NetSuite stores it. lookupFields returns select fields
// as [{ value, text }]; a search result returns them via getValue/getText.
const ITEMS = {
  4754: { itemid: 'BC-AZ70S-6513-UB', displayname: 'Azores 70mm', salesdescription: 'Azores 70mm Umber', type: { value: 'InvtPart', text: 'Inventory Item' },
    weight: '23.5', custitem_toplt: '98.3', custitem_tolyr: '12.29', custitem_tosec: '0', custitem_topcs: '0' },
  1021: { itemid: 'UNI-COU60-BASALT', displayname: 'Courtstone 60mm', salesdescription: 'Courtstone 60mm Basalt', type: { value: 'InvtPart', text: 'Inventory Item' },
    weight: '23.66', custitem_toplt: '98.3', custitem_tolyr: '12.29', custitem_tosec: '0', custitem_topcs: '0' },
  77: { itemid: 'DELIVERY', displayname: '', salesdescription: 'Delivery charge', type: { value: 'Service', text: 'Service' },
    weight: '', custitem_toplt: '', custitem_tolyr: '', custitem_tosec: '', custitem_topcs: '' }
};
const ONE_LINE = [{ item: '4754', line: '1', lineuniquekey: '5211333', quantity: '191.2', itemtype: 'InvtPart' }];

function harness({ fields = {}, executionContext = 'USERINTERFACE', parameters = {}, responseCode = 202,
  parentLookup = { type: [{ value: 'SalesOrd', text: 'Sales Order' }] }, orderLines = ONE_LINE, itemSearch = 'all',
  responses = null, taskFails = false, loadFails = null, clock = null } = {}) {
  const requests = [], logs = [], loads = [], lookups = [], searches = [], tasks = [];
  const values = {
    tranid: 'SOA11023', orderstatus: 'H', lastmodifieddate: new Date('2026-10-30T20:30:45.000Z'),
    location: '28', entity: '803721', ...fields
  };
  const texts = { status: values.orderstatus === 'H' ? 'Closed' : 'Pending Fulfillment', location: '2967', ...(fields.texts || {}) };
  const order = {
    id: 1100327, type: 'salesorder',
    getValue: ({ fieldId }) => values[fieldId] ?? '',
    getText: ({ fieldId }) => texts[fieldId] ?? '',
    getLineCount: () => orderLines.length,
    getSublistValue: ({ fieldId, line }) => orderLines[line][fieldId] ?? '',
    getSublistText: () => ''
  };
  const params = {
    custscript_mbbs_webhook_url: 'https://app.example.invalid/api/netsuite/order-webhook',
    custscript_mbbs_webhook_secret: 'order-fixture-secret', ...parameters
  };
  const modules = {
    'N/record': { Type: { SALES_ORDER: 'salesorder', PURCHASE_ORDER: 'purchaseorder', TRANSFER_ORDER: 'transferorder' },
      load: options => { loads.push(options); if (loadFails) throw loadFails; return order; } },
    'N/runtime': {
      executionContext,
      ContextType: { USER_INTERFACE: 'USERINTERFACE', CSV_IMPORT: 'CSVIMPORT', SCHEDULED: 'SCHEDULED' },
      getCurrentScript: () => ({ id: 'customscript_mbbs_webhook_url', deploymentId: 'customdeploy_app_outbound_webhook_so',
        getParameter: ({ name }) => params[name] || '' })
    },
    // responses: codes (or Errors to throw) for successive posts; then responseCode.
    'N/https': { post: options => {
      requests.push({ ...options, at: DateClass.now() });
      const next = responses && responses.length ? responses.shift() : responseCode;
      if (next instanceof Error) throw next;
      return { code: next, body: '{"accepted":true}' };
    } },
    'N/task': { TaskType: { SCHEDULED_SCRIPT: 'SCHEDULED_SCRIPT' }, create: options => ({ submit: () => {
      tasks.push(options);
      if (taskFails) throw Object.assign(new Error('No deployments available'), { name: 'FAILED_TO_SUBMIT_JOB_REQUEST_1' });
      return `SCHEDSCRIPT_${tasks.length}`;
    } }) },
    'N/log': { error: (title, details) => logs.push({ level: 'error', title, details }),
      audit: (title, details) => logs.push({ level: 'audit', title, details }),
      debug: () => {} },
    'N/search': {
      lookupFields: options => {
        lookups.push(options);
        if (options.type !== 'transaction') {
          const item = ITEMS[options.id] || {};
          return Object.fromEntries(options.columns.map(column => [column,
            item[column] && typeof item[column] === 'object' ? [item[column]] : item[column] ?? '']));
        }
        if (parentLookup instanceof Error) throw parentLookup;
        return parentLookup;
      },
      // itemSearch: 'all' returns every item, 'none' throws, or an array of the ids it returns.
      create: options => {
        searches.push(options);
        if (itemSearch === 'none') throw new Error('SSS_SEARCH_ERROR');
        const ids = options.filters[0][2].filter(id => itemSearch === 'all' || itemSearch.includes(id));
        return { run: () => ({ getRange: () => ids.map(id => ({
          id,
          getValue: ({ name }) => { const field = ITEMS[id][name]; return field && typeof field === 'object' ? field.value : field ?? ''; },
          getText: ({ name }) => { const field = ITEMS[id][name]; return field && typeof field === 'object' ? field.text : ''; }
        })) }) };
      }
    }
  };
  // clock: a { now } object that advances 250 ms each time the script reads
  // the time, so the retry's wait loop finishes; otherwise time stands still.
  const DateClass = clock
    ? class extends Date {
      constructor(...args) { super(...(args.length ? args : [clock.now])); }
      static now() { clock.now += 250; return clock.now; }
    }
    : class extends Date {
      constructor(...args) { super(...(args.length ? args : [NOW])); }
      static now() { return NOW; }
    };
  const lib = loadModule(libSource, modules, DateClass);
  const withLib = { ...modules, './netsuite-order-webhook-lib': lib };
  const script = loadModule(source, withLib, DateClass);
  const retryScript = loadModule(retrySource, withLib, DateClass);
  const UserEventType = { CREATE: 'create', EDIT: 'edit', VIEW: 'view', DELETE: 'delete', APPROVE: 'approve', XEDIT: 'xedit' };
  const context = type => ({ type, UserEventType, newRecord: order });
  return {
    requests, logs, loads, lookups, searches, tasks, script,
    retry: () => retryScript.execute(),
    beforeLoad: (type = 'view') => script.beforeLoad(context(type)),
    afterSubmit: (type = 'edit') => script.afterSubmit(context(type)),
    childEvent: (type, records, entry = 'afterSubmit') => script[entry]({ type, UserEventType, ...records })
  };
}

test('view reload of a just-closed order sends the close once with eventType close', () => {
  const h = harness();
  h.beforeLoad('view');
  assert.equal(h.requests.length, 1);
  const body = JSON.parse(h.requests[0].body);
  assert.equal(body.eventType, 'close');
  assert.equal(body.trigger, 'close_reload');
  assert.equal(body.status, 'H');
  assert.equal(body.statusText, 'Closed');
  assert.equal(body.tranid, 'SOA11023');
  assert.equal(body.id, 1100327);
  assert.equal(body.recordType, 'salesorder');
  assert.equal(body.lines.length, 1);
  assert.equal(h.requests[0].headers['x-mbbs-webhook-secret'], 'order-fixture-secret');
  assert.deepEqual(h.logs.map(entry => entry.title), ['MBBS webhook invoked', 'MBBS webhook sent']);
  assert.equal(h.logs[0].details.trigger, 'close_reload');
});

test('close reload is detected from status text when the status code is absent', () => {
  const h = harness({ fields: { orderstatus: '', texts: { status: 'Closed' } } });
  h.beforeLoad('view');
  assert.equal(h.requests.length, 1);
});

test('time-zone shifted Date values still fall inside the close window', () => {
  for (const shiftHours of [-3, 3, 15]) {
    const h = harness({ fields: { lastmodifieddate: new Date(NOW + shiftHours * 3_600_000) } });
    h.beforeLoad('view');
    assert.equal(h.requests.length, 1, `shift ${shiftHours} h`);
  }
});

test('views that are not a recent UI close send nothing', () => {
  const cases = [
    ['open order', { fields: { orderstatus: 'B' } }, 'view'],
    ['closed long ago', { fields: { lastmodifieddate: new Date(NOW - 3 * 86_400_000) } }, 'view'],
    ['non-UI context', { executionContext: 'CSVIMPORT' }, 'view'],
    ['edit form load', {}, 'edit'],
    ['create form load', {}, 'create']
  ];
  for (const [label, options, type] of cases) {
    const h = harness(options);
    h.beforeLoad(type);
    assert.equal(h.requests.length, 0, label);
    assert.equal(h.loads.length, 0, label);
  }
});

test('unreadable modification time still sends, since the app ignores duplicate payloads', () => {
  const h = harness({ fields: { lastmodifieddate: 'not a date' } });
  h.beforeLoad('view');
  assert.equal(h.requests.length, 1);
});

test('beforeLoad never throws when sending fails', () => {
  const h = harness({ responseCode: 500 });
  assert.doesNotThrow(() => h.beforeLoad('view'));
  assert.deepEqual(h.logs.map(entry => entry.title).slice(-2), ['MBBS webhook failed', 'MBBS webhook retry queued']);
  const broken = harness();
  broken.script.beforeLoad({ type: 'view', UserEventType: { VIEW: 'view' }, newRecord: null });
  assert.equal(broken.requests.length, 0);
});

test('missing parameters stop the close send and are logged', () => {
  const h = harness({ parameters: { custscript_mbbs_webhook_url: '' } });
  h.beforeLoad('view');
  assert.equal(h.requests.length, 0);
  assert.equal(h.logs.at(-1).title, 'MBBS webhook missing parameters');
});

test('afterSubmit is unchanged: edits send with their own event type, deletes send nothing', () => {
  const edit = harness({ fields: { orderstatus: 'B' } });
  edit.afterSubmit('edit');
  assert.equal(edit.requests.length, 1);
  const body = JSON.parse(edit.requests[0].body);
  assert.equal(body.eventType, 'edit');
  assert.equal(body.trigger, undefined);
  assert.equal(body.manualApproval, false);
  const approve = harness({ fields: { orderstatus: 'B' } });
  approve.afterSubmit('approve');
  assert.equal(JSON.parse(approve.requests[0].body).manualApproval, true);
  const removed = harness();
  removed.afterSubmit('delete');
  assert.equal(removed.requests.length, 0);
});

const plain = value => JSON.parse(JSON.stringify(value));

// Fulfillments, receipts and invoices change the order without running its
// User Event; the same script deployed on them sends the parent order.
function childRecord({ type = 'itemfulfillment', id = 2200001, tranid = 'IF160993', createdfrom = '1100327',
  shipstatus = 'C', memo = '', lines = [{ orderline: '1', item: '4754', itemreceive: true, quantity: '191.2', location: '28' }] } = {}) {
  const values = { tranid, createdfrom, shipstatus, memo };
  return {
    id, type,
    getValue: ({ fieldId }) => values[fieldId] ?? '',
    getText: () => '',
    getLineCount: () => lines.length,
    getSublistValue: ({ fieldId, line }) => lines[line][fieldId] ?? ''
  };
}

test('a new fulfillment sends its parent sales order, not the fulfillment', () => {
  const h = harness({ fields: { orderstatus: 'F' }, executionContext: 'RESTLET' });
  h.childEvent('create', { newRecord: childRecord() });
  assert.equal(h.requests.length, 1);
  // Objects made inside the vm sandbox have another realm's prototypes.
  assert.deepEqual(plain(h.loads), [{ type: 'salesorder', id: '1100327', isDynamic: false }]);
  assert.deepEqual(plain(h.lookups[0]), { type: 'transaction', id: '1100327', columns: ['type'] });
  const body = JSON.parse(h.requests[0].body);
  assert.equal(body.recordType, 'salesorder');
  assert.equal(body.id, 1100327);
  assert.equal(body.tranid, 'SOA11023');
  assert.equal(body.status, 'F');
  assert.equal(body.eventType, 'itemfulfillment_create');
  assert.equal(body.trigger, 'child_transaction');
  assert.equal(body.manualApproval, false);
  assert.equal(body.executionContext, 'RESTLET');
  assert.deepEqual(body.sourceTransaction, { recordType: 'itemfulfillment', id: 2200001, tranid: 'IF160993', eventType: 'create' });
  assert.equal(body.lines.length, 1);
  assert.deepEqual(h.logs.map(entry => entry.title), ['MBBS webhook invoked', 'MBBS webhook sent']);
  assert.equal(h.logs[0].details.recordType, 'salesorder');
  assert.equal(h.logs[0].details.childRecordType, 'itemfulfillment');
});

test('receipts send the parent PO or TO, including a text-only type lookup', () => {
  const cases = [
    [{ type: [{ value: 'PurchOrd', text: 'Purchase Order' }] }, 'purchaseorder'],
    [{ type: [{ value: 'TrnfrOrd', text: 'Transfer Order' }] }, 'transferorder'],
    [{ type: [{ text: 'Transfer Order' }] }, 'transferorder'],
    [{ type: 'PurchOrd' }, 'purchaseorder']
  ];
  for (const [parentLookup, expected] of cases) {
    const h = harness({ parentLookup });
    h.childEvent('create', { newRecord: childRecord({ type: 'itemreceipt', tranid: 'IR50001' }) });
    assert.equal(h.requests.length, 1, expected);
    assert.equal(h.loads[0].type, expected);
    const body = JSON.parse(h.requests[0].body);
    assert.equal(body.recordType, expected);
    assert.equal(body.eventType, 'itemreceipt_create');
  }
});

test('deleting a fulfillment sends the parent order from the old record', () => {
  const h = harness();
  h.childEvent('delete', { newRecord: null, oldRecord: childRecord() });
  assert.equal(h.requests.length, 1);
  assert.equal(h.loads[0].id, '1100327');
  const body = JSON.parse(h.requests[0].body);
  assert.equal(body.eventType, 'itemfulfillment_delete');
  assert.equal(body.sourceTransaction.eventType, 'delete');
});

test('an edit sends only when it changes what the order shipped or received', () => {
  const base = { lines: [{ orderline: '1', item: '4754', itemreceive: true, quantity: '191.2', location: '28' }] };
  const cases = [
    ['memo only', childRecord({ ...base, memo: 'tracking 123' }), 0],
    ['quantity changed', childRecord({ lines: [{ ...base.lines[0], quantity: '100' }] }), 1],
    ['line removed', childRecord({ lines: [] }), 1],
    ['line unticked', childRecord({ lines: [{ ...base.lines[0], itemreceive: false }] }), 1],
    ['shipped', childRecord({ ...base, shipstatus: 'C' }), 1]
  ];
  for (const [label, newRecord, expected] of cases) {
    const h = harness();
    const oldRecord = childRecord({ ...base, shipstatus: label === 'shipped' ? 'B' : 'C' });
    h.childEvent('edit', { newRecord, oldRecord });
    assert.equal(h.requests.length, expected, label);
    if (!expected) assert.equal(h.loads.length + h.lookups.length, 0, label);
  }
});

test('ship, pack and inline edits always send the parent order', () => {
  for (const type of ['ship', 'pack', 'xedit']) {
    const h = harness();
    h.childEvent(type, { newRecord: childRecord(), oldRecord: childRecord() });
    assert.equal(h.requests.length, 1, type);
  }
});

test('transactions without an SO/PO/TO parent send nothing', () => {
  const standalone = harness();
  standalone.childEvent('create', { newRecord: childRecord({ type: 'invoice', createdfrom: '' }) });
  assert.equal(standalone.requests.length, 0);
  assert.equal(standalone.lookups.length, 0);
  const rma = harness({ parentLookup: { type: [{ value: 'RtnAuth', text: 'Return Authorization' }] } });
  rma.childEvent('create', { newRecord: childRecord({ type: 'itemreceipt' }) });
  assert.equal(rma.requests.length, 0);
  assert.equal(rma.loads.length, 0);
});

test('a failed parent lookup or send never fails the fulfillment save', () => {
  const lookupFails = harness({ parentLookup: new Error('SSS_MISSING_REQD_ARGUMENT') });
  assert.doesNotThrow(() => lookupFails.childEvent('create', { newRecord: childRecord() }));
  assert.equal(lookupFails.requests.length, 0);
  assert.equal(lookupFails.logs.at(-1).title, 'MBBS webhook exception');
  const sendFails = harness({ responseCode: 502 });
  assert.doesNotThrow(() => sendFails.childEvent('create', { newRecord: childRecord() }));
  assert.deepEqual(sendFails.logs.map(entry => entry.title).slice(-2), ['MBBS webhook failed', 'MBBS webhook retry queued']);
  const missingRecord = harness();
  assert.doesNotThrow(() => missingRecord.childEvent('delete', { newRecord: null, oldRecord: null }));
  assert.equal(missingRecord.requests.length, 0);
});

test('viewing a fulfillment does not run the close check', () => {
  const h = harness();
  const fulfillment = childRecord();
  fulfillment.getText = () => 'Closed';
  h.childEvent('view', { newRecord: fulfillment }, 'beforeLoad');
  assert.equal(h.requests.length, 0);
  assert.equal(h.loads.length, 0);
});

// The order payload used one item lookup per item; it now uses one item
// search for the whole order, which must produce the same line details.
const THREE_LINES = [
  { item: '4754', line: '1', lineuniquekey: '1', quantity: '191.2', itemtype: 'InvtPart' },
  { item: '1021', line: '2', lineuniquekey: '2', quantity: '491.5', itemtype: 'InvtPart' },
  { item: '4754', line: '3', lineuniquekey: '3', quantity: '10', itemtype: 'InvtPart' },
  { item: '77', line: '4', lineuniquekey: '4', quantity: '1', itemtype: 'Service' }
];
const sentLines = h => JSON.parse(h.requests[0].body).lines;

test('item details come from one search for all distinct items, not one lookup per item', () => {
  const h = harness({ fields: { orderstatus: 'B' }, orderLines: THREE_LINES });
  h.afterSubmit('edit');
  assert.equal(h.searches.length, 1);
  assert.equal(h.searches[0].type, 'item');
  assert.deepEqual(plain(h.searches[0].filters), [['internalid', 'anyof', ['4754', '1021', '77']]]);
  assert.equal(h.lookups.length, 0);
  const lines = sentLines(h);
  assert.equal(lines.length, 4);
  assert.equal(lines[0].itemName, 'BC-AZ70S-6513-UB');
  assert.equal(lines[0].itemTypeText, 'Inventory Item');
  assert.equal(lines[0].itemWeight, 23.5);
  assert.equal(lines[1].itemName, 'UNI-COU60-BASALT');
  assert.equal(lines[1].itemDescription, 'Courtstone 60mm Basalt');
  assert.equal(lines[1].toPlt, 98.3);
  assert.equal(lines[1].custitem_tolyr, 12.29);
  assert.equal(lines[3].itemTypeText, 'Service');
  assert.equal(lines[3].itemWeight, 0);
});

test('the search gives exactly the same payload lines as the per-item lookups', () => {
  const searched = harness({ fields: { orderstatus: 'B' }, orderLines: THREE_LINES });
  searched.afterSubmit('edit');
  const looked = harness({ fields: { orderstatus: 'B' }, orderLines: THREE_LINES, itemSearch: 'none' });
  looked.afterSubmit('edit');
  assert.equal(looked.lookups.length, 3);
  assert.deepEqual(sentLines(searched), sentLines(looked));
});

test('a failed or partial item search falls back to lookups for the missing items only', () => {
  const failed = harness({ orderLines: THREE_LINES, itemSearch: 'none' });
  failed.afterSubmit('edit');
  assert.deepEqual(failed.lookups.map(entry => entry.id), ['4754', '1021', '77']);
  assert.equal(sentLines(failed)[1].itemName, 'UNI-COU60-BASALT');
  const partial = harness({ orderLines: THREE_LINES, itemSearch: ['4754', '77'] });
  partial.afterSubmit('edit');
  assert.deepEqual(partial.lookups.map(entry => entry.id), ['1021']);
  assert.equal(sentLines(partial)[1].itemName, 'UNI-COU60-BASALT');
});

test('an order without items sends no item search', () => {
  const h = harness({ orderLines: [] });
  h.afterSubmit('edit');
  assert.equal(h.searches.length, 0);
  assert.deepEqual(sentLines(h), []);
});

// A send lost to a dropped connection or an app restart is retried by the
// retry Scheduled Script 10 seconds later, up to 3 times.
const RETRY_PARAMS = {
  custscript_mbbs_webhook_url: '', custscript_mbbs_webhook_secret: '',
  custscript_mbbs_retry_url: 'https://app.example.invalid/api/netsuite/order-webhook', custscript_mbbs_retry_secret: 'retry-fixture-secret'
};
const queuedJob = (h, index = 0) => JSON.parse(h.tasks[index].params.custscript_mbbs_retry_job);
const connectionClosed = () => Object.assign(new Error('Connection Closed'), { name: 'SSS_CONNECTION_CLOSED' });

test('a 5xx or a lost connection queues one retry with everything needed to resend', () => {
  for (const failure of [502, 503, 530, 429, 408, connectionClosed()]) {
    const h = harness({ fields: { orderstatus: 'B' }, responses: [failure] });
    assert.doesNotThrow(() => h.afterSubmit('edit'));
    assert.equal(h.tasks.length, 1, String(failure));
    assert.equal(h.tasks[0].taskType, 'SCHEDULED_SCRIPT');
    assert.equal(h.tasks[0].scriptId, 'customscript_mbbs_webhook_retry');
    assert.deepEqual(queuedJob(h), { recordType: 'salesorder', id: 1100327, eventType: 'edit', manualApproval: false,
      executionContext: 'USERINTERFACE', overrides: {}, attempt: 1, failedAt: NOW, tranid: 'SOA11023' });
    assert.equal(h.logs.at(-1).title, 'MBBS webhook retry queued');
  }
});

test('a fulfillment-triggered send keeps its trigger and source in the retry', () => {
  const h = harness({ responses: [connectionClosed()], executionContext: 'RESTLET' });
  h.childEvent('create', { newRecord: childRecord() });
  const job = queuedJob(h);
  assert.equal(job.eventType, 'itemfulfillment_create');
  assert.equal(job.executionContext, 'RESTLET');
  assert.deepEqual(job.overrides, { trigger: 'child_transaction',
    sourceTransaction: { recordType: 'itemfulfillment', id: 2200001, tranid: 'IF160993', eventType: 'create' } });
});

test('a rejected payload, a wrong secret or an unreadable order is not retried', () => {
  for (const code of [400, 401, 403, 404, 413, 422]) {
    const h = harness({ responses: [code] });
    h.afterSubmit('edit');
    assert.equal(h.tasks.length, 0, String(code));
    assert.equal(h.logs.at(-1).title, 'MBBS webhook failed');
  }
  const unreadable = harness({ loadFails: new Error('RCRD_DSNT_EXIST') });
  unreadable.afterSubmit('edit');
  assert.equal(unreadable.requests.length, 0);
  assert.equal(unreadable.tasks.length, 0);
  assert.equal(unreadable.logs.at(-1).title, 'MBBS webhook exception');
});

test('if the retry cannot be queued the order is named in the log and the save still succeeds', () => {
  const h = harness({ responses: [502], taskFails: true });
  assert.doesNotThrow(() => h.afterSubmit('edit'));
  const entry = h.logs.at(-1);
  assert.equal(entry.title, 'MBBS webhook retry not queued');
  assert.equal(entry.details.tranid, 'SOA11023');
  assert.equal(entry.details.recordId, 1100327);
});

function retryHarness(job, options = {}) {
  const clock = { now: (typeof job === 'object' ? job.failedAt : NOW) + (options.queuedAfterMs ?? 2_000) };
  return harness({ executionContext: 'SCHEDULED', clock, ...options,
    parameters: { ...RETRY_PARAMS, custscript_mbbs_retry_job: typeof job === 'string' ? job : JSON.stringify(job) } });
}

test('the retry waits until 10 seconds after the failure, then sends the same payload again', () => {
  const original = harness({ fields: { orderstatus: 'B' }, responses: [connectionClosed()], executionContext: 'RESTLET' });
  original.childEvent('create', { newRecord: childRecord() });
  const job = queuedJob(original);
  const h = retryHarness(job, { fields: { orderstatus: 'B' } });
  h.retry();
  assert.equal(h.requests.length, 1);
  assert.ok(h.requests[0].at >= job.failedAt + 10_000, `sent ${h.requests[0].at - job.failedAt} ms after the failure`);
  assert.ok(h.requests[0].at <= job.failedAt + 11_000);
  assert.equal(h.requests[0].url, 'https://app.example.invalid/api/netsuite/order-webhook');
  assert.equal(h.requests[0].headers['x-mbbs-webhook-secret'], 'retry-fixture-secret');
  assert.equal(h.requests[0].headers['x-mbbs-webhook-retry'], '1');
  // Same body, so the app treats it as a duplicate if the first send did arrive.
  assert.deepEqual(JSON.parse(h.requests[0].body), JSON.parse(original.requests[0].body));
  assert.deepEqual(h.logs.map(entry => entry.title), ['MBBS webhook retry invoked', 'MBBS webhook retry sent']);
  assert.equal(h.tasks.length, 0);
});

test('the retry does not wait again when the queue already took longer than 10 seconds', () => {
  const job = { recordType: 'salesorder', id: 1100327, eventType: 'edit', overrides: {}, attempt: 1, failedAt: NOW, tranid: 'SOA11023' };
  const h = retryHarness(job, { queuedAfterMs: 45_000 });
  h.retry();
  assert.ok(h.requests[0].at - job.failedAt < 46_000);
  const future = retryHarness({ ...job, failedAt: NOW + 3_600_000 }, { queuedAfterMs: -3_600_000 });
  future.retry();
  assert.equal(future.requests.length, 1, 'a wrong failure time never waits more than 10 seconds');
});

test('a failed retry queues the next one, and the third failure gives up naming the order', () => {
  const job = { recordType: 'salesorder', id: 1100327, eventType: 'edit', overrides: {}, attempt: 1, failedAt: NOW, tranid: 'SOA11023' };
  const first = retryHarness(job, { responses: [502] });
  first.retry();
  const second = queuedJob(first);
  assert.equal(second.attempt, 2);
  assert.ok(second.failedAt > job.failedAt + 10_000);
  const third = retryHarness(second, { responses: [connectionClosed()] });
  third.retry();
  assert.equal(queuedJob(third).attempt, 3);
  const last = retryHarness(queuedJob(third), { responses: [502] });
  last.retry();
  assert.equal(last.tasks.length, 0);
  const entry = last.logs.at(-1);
  assert.equal(entry.title, 'MBBS webhook retry gave up');
  assert.equal(entry.details.tranid, 'SOA11023');
  assert.equal(entry.details.attempts, 3);
});

test('an unreadable retry job is logged and sends nothing', () => {
  for (const job of ['not json', '', JSON.stringify({ recordType: 'salesorder', id: 1, attempt: 0 }),
    JSON.stringify({ recordType: 'salesorder', id: 1, attempt: 4 }), JSON.stringify({ id: 1, attempt: 1 })]) {
    const h = retryHarness(job, { queuedAfterMs: 0 });
    h.retry();
    assert.equal(h.requests.length, 0, job);
    assert.equal(h.logs.at(-1).title, 'MBBS webhook retry job invalid', job);
  }
});
