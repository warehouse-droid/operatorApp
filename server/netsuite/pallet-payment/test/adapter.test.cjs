const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function load(name, deps = {}) {
  let api;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, `../${name}.js`), 'utf8'), {
    define(names, factory) { api = factory(...names.map(key => deps[key])); }
  }, { filename: path.resolve(__dirname, `../${name}.js`), timeout: 1000 });
  return api;
}
const core = load('ppa_core');
const config = load('ppa_config');
const service = load('ppa_service', { './ppa_core': core });
function fixture() {
  const calls = []; const saves = [];
  const base = { entity: '1', subsidiary: '1', currency: '1', docdate: '2026-01-01', modified: 'A', posting: 'T' };
  const docs = [{ ...base, id: '100', type: 'CustInvc' },
    { ...base, id: '201', type: 'CustPymt', paymentmethod: '1', foreigntotal: '220', memo: '' },
    { ...base, id: '202', type: 'CustPymt', paymentmethod: '5', foreigntotal: '800', memo: 'SOB123456 / 0070' }];
  const links = [{ invoice: '100', payment: '201', nextline: 1, foreignamount: '220' },
    { invoice: '100', payment: '202', nextline: 1, foreignamount: '800' }];
  const sourceLines = [{ invoice: '100', linekey: '1001', so: '90' }];
  const records = { '100': { createdfrom: '90', item: [{ item: '1784', lineuniquekey: '1001', quantity: 6, amount: 240, taxrate1: 13, taxrate2: 0 }] } };
  let physical = 6; let availableUsage = 5000; let deployment = config.writerDeployment;
  const customRows = new Map();
  const customerPages = new Map([['transaction', [['1']]], [config.allocationType, [['2']]]]);
  let rejectUnion = false;
  function paged(values, queryMode) {
    return { count: values.length, pageRanges: values.length ? [{ index: 0 }] : [], fetch() {
      return { data: queryMode ? { asMappedResults() { return values; } } : values.map(row => ({ getValue({ name }) { return row[name]; } })) };
    } };
  }
  const query = { runSuiteQLPaged(options) {
    calls.push(options);
    if (options.query.includes('UNION SELECT')) {
      if (rejectUnion) { return { pageRanges: [{ index: 0 }], fetch() { throw new Error('SSS_SEARCH_ERROR_OCCURRED: Invalid or unsupported search'); } }; }
      return paged([{ customer: '1' }, { customer: '2' }], true);
    }
    if (options.query.includes('NextTransactionLineLink')) { return paged(links, true); }
    if (options.query.includes('AS linekey')) { return paged(sourceLines, true); }
    return paged(docs, true);
  } };
  const search = {
    Sort: { ASC: 'ASC' }, Summary: { GROUP: 'GROUP' },
    createFilter(options) { return options; },
    createColumn(options) { return options; },
    create({ type, filters, columns }) {
      calls.push({ searchType: type, filters, columns });
      if (columns[0]?.summary === 'GROUP') {
        const pages = customerPages.get(type); assert.ok(pages);
        return { runPaged(options) {
          assert.equal(options.pageSize, 1000);
          return { count: pages.flat().length, pageRanges: pages.map((_, index) => ({ index })), fetch({ index }) {
            calls.push({ customerPage: index, type });
            return { data: pages[index].map(customer => ({ getValue(column) { assert.equal(column, columns[0]); return customer; } })) };
          } };
        } };
      }
      if (filters[0]?.[0] === 'externalid' && filters[0][1] === 'is') { throw new Error('SSS_INVALID_SRCH_OPERATOR: externalid is a select; use externalidstring'); }
      let values = customRows.get(type) || [];
      if (filters[0]?.[0] === 'externalidstring') { values = values.filter(row => row.externalid === filters[0][2]); }
      return { runPaged() { return paged(values, false); } };
    },
    load({ id }) {
      assert.equal(id, config.physicalSearch);
      const column = { name: 'quantity', summary: 'SUM', label: 'Returnable Quantity' };
      return { filterExpression: [], columns: [column], run() { return { getRange() { return [{ getValue(c) { assert.equal(c, column); return physical; } }]; } }; } };
    }
  };
  function customRecord(type, id) {
    const values = {};
    return { setValue({ fieldId, value }) { values[fieldId] = value; }, save() {
      const internalid = id || String(700 + saves.length);
      saves.push({ type, id: internalid, values });
      const found = customRows.get(type) || [];
      const old = found.find(row => row.internalid === internalid);
      if (old) { Object.assign(old, values); } else { found.push({ internalid, ...values }); }
      customRows.set(type, found);
      return internalid;
    } };
  }
  const record = {
    load({ type, id }) {
      calls.push({ type, id });
      if (type.startsWith('customrecord_')) { return customRecord(type, id); }
      const data = records[id]; assert.ok(data, `Unexpected record ${type}/${id}`);
      return { getValue({ fieldId }) { return data[fieldId]; }, getLineCount({ sublistId }) { return (data[sublistId] || []).length; },
        getSublistValue({ sublistId, fieldId, line }) { return data[sublistId][line][fieldId]; } };
    },
    create({ type }) { return customRecord(type); },
    submitFields(options) {
      saves.push(options);
      const found = (customRows.get(options.type) || []).find(row => row.internalid === String(options.id));
      assert.ok(found, `Unexpected update ${options.type}/${options.id}`);
      Object.assign(found, options.values);
    }
  };
  const runtime = { accountId: '6518947', isFeatureInEffect() { return false; }, getCurrentScript() {
    return { deploymentId: deployment, getRemainingUsage() { return availableUsage; } };
  } };
  const io = load('ppa_netsuite', { 'N/query': query, 'N/search': search, 'N/record': record, 'N/runtime': runtime,
    './ppa_core': core, './ppa_config': config });
  return { io, docs, links, sourceLines, records, calls, saves, customRows, runtime, customerPages,
    rejectCustomerUnion() { rejectUnion = true; },
    setPhysical(n) { physical = n; }, setUsage(n) { availableUsage = n; }, setDeployment(s) { deployment = s; } };
}
test('live-shape invoice/applications produce net cash and gross card rates without financial writes', () => {
  const f = fixture(); const input = f.io.snapshot('1'); const result = core.build(input);
  assert.equal(result.verified, true);
  assert.deepEqual(Array.from(result.allocations, a => [a.method, a.qty, a.rate]), [['1', 5, 4000], ['5', 1, 4520]]);
  assert.equal(f.saves.length, 0);
  assert.ok(f.calls.some(c => c.query?.includes("l.iscogs='F'")));
});
test('each invoice pallet line retains its actual Sales Order even on a consolidated invoice', () => {
  const f = fixture();
  f.records['100'].item.push({ item: '1784', lineuniquekey: '1002', quantity: 1, amount: 40, taxrate1: 13, taxrate2: 0 });
  f.sourceLines.push({ invoice: '100', linekey: '1002', so: '91' }); f.setPhysical(7);
  const input = f.io.snapshot('1');
  assert.equal(input.invoices[0].lines[1].so, '91');
});
test('customer refund Apply sublist links to the actual credit and retains the applied amount', () => {
  const f = fixture(); const base = f.docs[0];
  f.docs.push({ ...base, id: '300', type: 'CustCred', docdate: '2026-02-01' },
    { ...base, id: '400', type: 'CustRfnd', paymentmethod: '5', memo: 'CMB123456 / 0070', docdate: '2026-02-01' });
  f.records['300'] = { item: [{ item: '1784', lineuniquekey: '3001', quantity: 1, amount: 40, taxrate1: 13, taxrate2: 0 }] };
  f.records['400'] = { apply: [{ apply: true, doc: '300', amount: 45.20 }, { apply: false, doc: '999', amount: 500 }] };
  f.setPhysical(5);
  const r = core.build(f.io.snapshot('1'));
  assert.equal(r.verified, true); assert.equal(r.allocations[1].refunded, 1);
});
test('deposit application follows deposit once and catches application capacity overflow', () => {
  const f = fixture();
  f.docs[1].type = 'DepAppl'; f.docs[1].paymentmethod = undefined;
  f.docs.push({ ...f.docs[0], id: '250', type: 'CustDep', paymentmethod: '1', foreigntotal: '220' });
  f.records['201'] = { deposit: '250', apply: [{ apply: true, doc: '100', amount: 220 }] };
  const input = f.io.snapshot('1');
  assert.equal(input.payments[0].source, '250'); assert.equal(input.payments[0].amount, 22000);
  f.links.push({ invoice: '999', payment: '201', nextline: 2, foreignamount: '1' });
  f.records['201'].apply.push({ apply: true, doc: '999', amount: 1 });
  assert.throws(() => f.io.snapshot('1'), /SOURCE_APPLICATION_CAPACITY_EXCEEDED/);
});
test('native Deposit Application applies even if the generic link table omits its Payment link', () => {
  const f = fixture(); f.docs[1].type = 'DepAppl'; f.docs[1].paymentmethod = undefined;
  f.docs.push({ ...f.docs[0], id: '250', type: 'CustDep', paymentmethod: '1', foreigntotal: '220' });
  f.records['201'] = { deposit: '250', apply: [{ apply: true, doc: '100', amount: 220 }, { apply: false, doc: '999', amount: 1 }] };
  f.links.splice(0, 1);
  const r = core.build(f.io.snapshot('1'));
  assert.equal(r.verified, true); assert.equal(r.allocations[0].method, '1'); assert.equal(r.allocations[0].qty, 5);
});
test('missing tax and resource limits stop calculation, never defaulting card tax to zero', () => {
  const f = fixture(); delete f.records['100'].item[0].taxrate1;
  assert.throws(() => f.io.snapshot('1'), /MISSING_LINE_TAX/);
  const g = fixture(); g.setUsage(100);
  assert.throws(() => g.io.snapshot('1'), /CUSTOMER_TOO_LARGE/);
});
test('persistence writes only agreed custom-record fields and prevents a second writer deployment', () => {
  const f = fixture(); const r = core.build(f.io.snapshot('1'));
  f.io.ensureWriter(); f.io.putAllocation(r.allocations[1], false, []);
  const saved = f.saves[0]; assert.equal(saved.type, 'customrecord_pallet_payment_alloc');
  assert.equal(saved.values.custrecord_ppa_rate, 45.20);
  assert.equal(saved.values.custrecord_ppa_last4, '0070');
  assert.equal(saved.values.custrecord_ppa_verified, false);
  assert.deepEqual(Array.from(saved.values.custrecord_ppa_payments), ['202']);
  f.setDeployment('customdeploy_duplicate'); assert.throws(() => f.io.ensureWriter(), /SINGLE_DESIGNATED/);
  f.runtime.accountId = '999999'; assert.throws(() => f.io.ensureWriter(), /WRONG_NETSUITE_ACCOUNT/);
});
test('credit application evidence comes from real applied invoices and excludes unapplied lines', () => {
  const f = fixture();
  f.docs.push({ ...f.docs[0], id: '300', type: 'CustCred', docdate: '2026-02-01' });
  f.records['300'] = { item: [{ item: '1784', lineuniquekey: '3001', quantity: 1, amount: 40, taxrate1: 13, taxrate2: 0 }] };
  f.links.push({ invoice: '999', payment: '300', paymenttype: 'CustCred', nextline: 0, foreignamount: '45.20' });
  f.setPhysical(5);
  const input = f.io.snapshot('1');
  assert.equal(input.credits[0].onAccount, 4520);
  assert.equal(input.payments.length, 2);
});
test('real adapter and service upsert linked refund history, rerun without duplication and reverse a removed refund', () => {
  const f = fixture(); const base = f.docs[0];
  f.docs.push({ ...base, id: '300', type: 'CustCred', docdate: '2026-02-01' },
    { ...base, id: '400', type: 'CustRfnd', paymentmethod: '5', memo: 'CMB123456 / 0070', docdate: '2026-02-01' });
  f.records['300'] = { item: [{ item: '1784', lineuniquekey: '3001', quantity: 1, amount: 40, taxrate1: 13, taxrate2: 0 }] };
  f.records['400'] = { apply: [{ apply: true, doc: '300', amount: 45.20 }] }; f.setPhysical(5);
  service.refresh(f.io, '1', false); service.refresh(f.io, '1', false);
  const allocations = f.customRows.get(config.allocationType); const events = f.customRows.get(config.refundType);
  assert.equal(allocations.length, 2); assert.equal(events.length, 1);
  const visa = allocations.find(row => row.custrecord_ppa_method === '5');
  assert.equal(visa.custrecord_ppa_verified, true); assert.equal(visa.custrecord_ppa_refunded_qty, 1);
  assert.equal(events[0].custrecord_pra_allocation, visa.internalid);
  assert.equal(events[0].custrecord_pra_refund, '400'); assert.equal(events[0].custrecord_pra_creditmemo, '300');
  assert.equal(events[0].custrecord_pra_amount, 45.20); assert.equal(events[0].custrecord_pra_status, 'COMPLETED');
  f.docs.splice(3); f.setPhysical(6);
  service.refresh(f.io, '1', false);
  assert.equal(visa.custrecord_ppa_refunded_qty, 0); assert.equal(events[0].custrecord_pra_status, 'REVERSED');
  assert.ok(f.saves.every(write => [config.allocationType, config.refundType].includes(write.type)));
});
test('customer selection validates IDs and includes both new and previously allocated customers', () => {
  const f = fixture(); assert.deepEqual(Array.from(f.io.customers('1')), ['1']);
  assert.deepEqual(Array.from(f.io.customers('')), ['1', '2']);
  assert.throws(() => f.io.customers('1 OR 1=1'), /INVALID_INTERNAL_ID/);
});
test('blank customer discovers all pallet customers even when native UNION paging is unsupported', () => {
  const f = fixture(); f.rejectCustomerUnion();
  f.customerPages.set('transaction', [['1', '3'], ['1001', '1002']]);
  f.customerPages.set(config.allocationType, [['2', '3'], ['2000']]);
  assert.deepEqual(Array.from(f.io.customers('')), ['1', '2', '3', '1001', '1002', '2000']);
  assert.equal(f.calls.filter(call => call.customerPage !== undefined).length, 4);
  assert.equal(f.calls.filter(call => call.query).length, 0, 'discovery must not depend on the unsupported SuiteQL path');
  assert.equal(f.saves.length, 0);
  const searches = f.calls.filter(call => call.searchType);
  assert.equal(searches.length, 2);
  for (const search of searches) { assert.equal(search.columns[0].summary, 'GROUP'); assert.equal(search.columns[0].sort, 'ASC'); }
  assert.equal(searches[0].searchType, 'transaction'); assert.equal(searches[0].columns[0].name, 'entity');
  assert.deepEqual(JSON.parse(JSON.stringify(searches[0].filters.slice(0, 3))), [['type', 'anyof', ['CustInvc', 'CustCred']], 'and', ['item', 'anyof', '1784']]);
  assert.equal(searches[1].searchType, config.allocationType); assert.equal(searches[1].columns[0].name, config.allocationFields.customer);
});
test('all-customer discovery handles empty history and selected-customer mode bypasses every discovery search', () => {
  const f = fixture(); f.rejectCustomerUnion(); f.customerPages.set('transaction', []); f.customerPages.set(config.allocationType, []);
  assert.deepEqual(Array.from(f.io.customers('')), []);
  f.calls.length = 0; assert.deepEqual(Array.from(f.io.customers('5240')), ['5240']); assert.equal(f.calls.length, 0);
});
test('custom record searches use the explicit parent join and deterministic internal-ID ordering', () => {
  const f = fixture(); f.io.existing('1');
  const child = f.calls.find(call => call.searchType === config.refundType);
  assert.equal(child.filters[0].join, 'custrecord_pra_allocation');
  assert.equal(child.filters[0].name, 'custrecord_ppa_customer');
  assert.equal(child.columns[0].name, 'internalid'); assert.equal(child.columns[0].sort, 'ASC');
});
test('manual reservation is linked back to the same original lot and completion replaces pending once', () => {
  const f = fixture(); service.refresh(f.io, '1', false);
  const allocations = f.customRows.get(config.allocationType); const cash = allocations.find(row => row.custrecord_ppa_method === '1');
  const manual = { internalid: '900', externalid: 'MANUAL-RETURN-1', custrecord_pra_allocation: cash.internalid,
    custrecord_pra_creditmemo: '', custrecord_pra_refund: '', custrecord_pra_return_ref: 'R-1', custrecord_pra_qty: 1,
    custrecord_pra_amount: 40, custrecord_pra_status: 'PENDING' };
  f.customRows.set(config.refundType, [manual]);
  service.refresh(f.io, '1', false);
  assert.equal(cash.custrecord_ppa_pending_qty, 1); assert.equal(cash.custrecord_ppa_refunded_qty, 0);
  const base = f.docs[0];
  f.docs.push({ ...base, id: '300', type: 'CustCred', docdate: '2026-02-01' },
    { ...base, id: '400', type: 'CustRfnd', paymentmethod: '1', docdate: '2026-02-01' });
  f.records['300'] = { item: [{ item: '1784', lineuniquekey: '3001', quantity: 1, amount: 40, taxrate1: 13, taxrate2: 0 }] };
  f.records['400'] = { apply: [{ apply: true, doc: '300', amount: 40 }] }; f.setPhysical(5);
  manual.custrecord_pra_status = 'COMPLETED'; manual.custrecord_pra_creditmemo = '300'; manual.custrecord_pra_refund = '400';
  service.refresh(f.io, '1', false);
  assert.equal(cash.custrecord_ppa_pending_qty, 0); assert.equal(cash.custrecord_ppa_refunded_qty, 1);
  assert.equal(f.customRows.get(config.refundType).length, 1);
});
test('changed record contents, unequal credit rates and cross-scope deposits/refunds require review', () => {
  const missing = fixture(); missing.records['100'].item = [];
  assert.throws(() => missing.io.snapshot('1'), /PALLET_LINES_MISSING/);
  const credit = fixture(); credit.docs.push({ ...credit.docs[0], id: '300', type: 'CustCred' });
  credit.records['300'] = { item: [
    { item: '1784', lineuniquekey: '3001', quantity: 1, amount: 40, taxrate1: 13, taxrate2: 0 },
    { item: '1784', lineuniquekey: '3002', quantity: 1, amount: 50, taxrate1: 13, taxrate2: 0 }] };
  assert.throws(() => credit.io.snapshot('1'), /MULTIPLE_CREDIT_RATES_REVIEW/);
  const deposit = fixture(); deposit.docs[1].type = 'DepAppl';
  deposit.docs.push({ ...deposit.docs[0], id: '250', type: 'CustDep', entity: '2', paymentmethod: '1', foreigntotal: '220' });
  deposit.records['201'] = { deposit: '250', apply: [{ apply: true, doc: '100', amount: 220 }] };
  assert.throws(() => deposit.io.snapshot('1'), /DEPOSIT_SCOPE_MISMATCH/);
  const refund = fixture(); const base = refund.docs[0];
  refund.docs.push({ ...base, id: '300', type: 'CustCred' }, { ...base, id: '400', type: 'CustRfnd', subsidiary: '2' });
  refund.records['300'] = { item: [{ item: '1784', lineuniquekey: '3001', quantity: 1, amount: 40, taxrate1: 13, taxrate2: 0 }] };
  refund.records['400'] = { apply: [{ apply: true, doc: '300', amount: 45.20 }] };
  assert.throws(() => refund.io.snapshot('1'), /REFUND_SCOPE_MISMATCH/);
});
test('a real mixed credit cannot turn the goods refund into additional pallet refunds', () => {
  const f = fixture(); const base = f.docs[0];
  f.docs.push({ ...base, id: '300', type: 'CustCred', docdate: '2026-02-01' },
    { ...base, id: '400', type: 'CustRfnd', paymentmethod: '5', memo: 'CMB123456 / 0070', docdate: '2026-02-01' });
  f.records['300'] = { item: [
    { item: '1784', lineuniquekey: '3001', quantity: 1, amount: 40, taxrate1: 13, taxrate2: 0 },
    { item: '999', lineuniquekey: '3002', quantity: 1, amount: 100, taxrate1: 13, taxrate2: 0 }] };
  // A partial refund of the mixed credit still needs an explicit pallet allocation.
  f.records['400'] = { apply: [{ apply: true, doc: '300', amount: 45.20 }] }; f.setPhysical(5);
  const result = core.build(f.io.snapshot('1'));
  assert.equal(result.verified, false);
  assert.ok(result.issues.some(issue => issue.startsWith('MIXED_CREDIT_REQUIRES_MANUAL_ALLOCATION')));
  assert.equal(result.events.length, 0);
});
test('evidence-backed card overrides preserve method and reject an inconsistent override', () => {
  const f = fixture(); f.docs[2].memo = 'SOB123456';
  try {
    config.cardOverrides['202'] = { method: '5', last4: '0070', evidence: 'Fixture receipt reviewed' };
    assert.equal(core.build(f.io.snapshot('1')).verified, true);
    config.cardOverrides['202'].method = '4';
    assert.throws(() => f.io.snapshot('1'), /INVALID_CARD_OVERRIDE/);
  } finally { delete config.cardOverrides['202']; }
});
test('retired unused lots and manual settlement entries survive a source rebuild correctly', () => {
  const f = fixture(); service.refresh(f.io, '1', false);
  const rows = f.customRows.get(config.allocationType); const old = rows[1];
  f.links.splice(1, 1); f.links[0].foreignamount = '240'; f.docs[1].foreigntotal = '240';
  service.refresh(f.io, '1', false);
  assert.equal(old.isinactive, true); assert.equal(old.custrecord_ppa_verified, false);
});
