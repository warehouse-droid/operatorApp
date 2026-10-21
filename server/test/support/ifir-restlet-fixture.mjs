import fs from 'node:fs';
import vm from 'node:vm';

export const scriptFile = 'netsuite-ifir-posting-restlet.js';
const clone = value => JSON.parse(JSON.stringify(value));

export function ifirFixture(options = {}) {
  const state = {
    transforms: [], saves: [], loads: [], logs: [], assignments: [],
    stored: new Map(), params: {
      custscript_mbbs_ifir_writes_enabled: true,
      custscript_mbbs_ifir_allow_production: false
    }, envType: 'SANDBOX', failRead: false, failSave: false, race: false,
    source: { id: 901, type: 'purchaseorder', header: { tranid: 'PO901', location: 15 }, items: [
      { line: 1, lineuniquekey: 7001, item: 501, itemtype: 'InvtPart', quantity: 10, rate: 12,
        location: 15, units: 'Each', unitstext: 'Each' },
      { line: 2, lineuniquekey: 7002, item: 502, itemtype: 'InvtPart', quantity: 10, rate: 8,
        location: 15, units: 'Each', unitstext: 'Each' }
    ] }, afterSave: null, ...options
  };
  function recordModel(data) {
    const model = {
      id: data.id, type: data.type,
      getValue: ({ fieldId }) => data.header[fieldId] ?? '',
      getText: ({ fieldId }) => data.header[`${fieldId}text`] ?? String(data.header[fieldId] ?? ''),
      setValue: ({ fieldId, value }) => { data.header[fieldId] = value; return model; },
      getLineCount: ({ sublistId }) => sublistId === 'item' ? data.items.length : 0,
      getSublistValue: ({ fieldId, line }) => data.items[line]?.[fieldId] ?? '',
      getSublistText: ({ fieldId, line }) => data.items[line]?.[`${fieldId}text`] ?? String(data.items[line]?.[fieldId] ?? ''),
      getSublistFields: () => [...new Set(data.items.flatMap(item => Object.keys(item)))],
      setSublistValue: ({ fieldId, line, value }) => {
        if (!data.items[line]) { throw Error('Invalid line index'); }
        data.items[line][fieldId] = value;
        return model;
      },
      hasSublistSubrecord: ({ line }) => Boolean(data.items[line]?.inventorydetail),
      getSublistSubrecord: ({ line }) => {
        const rows = data.items[line].inventorydetail;
        return {
          getLineCount: () => rows.length,
          getSublistValue: ({ fieldId, line: row }) => rows[row][fieldId] ?? '',
          getSublistText: ({ fieldId, line: row }) => String(rows[row][fieldId] ?? '')
        };
      },
      save: saveOptions => {
        state.saves.push(clone(saveOptions));
        if (state.failSave) { throw Error('SAVE_UNAVAILABLE'); }
        const saved = clone(data);
        saved.id = 8001;
        saved.header.tranid = saved.type === 'itemreceipt' ? 'IR000123' : 'IF000456';
        saved.items = saved.items.filter(item => item.itemreceive !== false);
        if (state.afterSave) { state.afterSave(saved); }
        state.stored.set(saved.id, saved);
        if (state.race) { throw Object.assign(Error('Duplicate external ID'), { name: 'DUP_EXTERNALID' }); }
        return saved.id;
      }
    };
    return model;
  }
  const modules = {
    'N/record': {
      Type: { PURCHASE_ORDER: 'purchaseorder', SALES_ORDER: 'salesorder', TRANSFER_ORDER: 'transferorder',
        ITEM_RECEIPT: 'itemreceipt', ITEM_FULFILLMENT: 'itemfulfillment', OTHER_CHARGE_ITEM: 'otherchargeitem' },
      transform: input => {
        state.transforms.push(clone(input));
        const data = { type: input.toType, header: { createdfrom: input.fromId, status: 'Saved',
          trandate: '2026-10-21', location: 15 }, items: state.source.items.map(item => ({
          ...clone(item), orderline: item.line, orderdoc: input.fromId, itemreceive: true,
          itemunitprice: item.rate, itemfxamount: item.quantity * item.rate
        })) };
        if (state.transformChange) { state.transformChange(data); }
        return recordModel(data);
      },
      load: input => {
        state.loads.push(clone(input));
        if (Number(input.id) === state.source.id && input.type === state.source.type) { return recordModel(state.source); }
        if (input.type === 'otherchargeitem') {
          return recordModel({ id: input.id, type: input.type, items: [],
            header: { subtype: 'Purchase', generateaccruals: false } });
        }
        if (state.failRead) { throw Error('READ_UNAVAILABLE'); }
        const saved = state.stored.get(Number(input.id));
        if (!saved || saved.type !== input.type) { throw Error('RECORD_NOT_FOUND'); }
        return recordModel(saved);
      }
    },
    'N/search': {
      Type: { TRANSACTION: 'transaction' },
      create: input => ({ run: () => ({ getRange: () => {
        if (state.failSearch) { throw Error('SEARCH_UNAVAILABLE'); }
        const external = input.filters.find(filter => Array.isArray(filter) && filter[0] === 'externalidstring')?.[2];
        return [...state.stored.values()].filter(data => data.header.externalid === external).map(data => ({
          id: data.id, recordType: data.type,
          getValue: ({ name }) => ({ internalid: data.id, recordtype: data.type,
            type: data.type === 'itemreceipt' ? 'ItemRcpt' : 'ItemShip', createdfrom: data.header.createdfrom,
            externalid: data.header.externalid, tranid: data.header.tranid })[name]
        }));
      } }) })
    },
    'N/runtime': {
      get envType() { return state.envType; }, accountId: 'TEST_SB1', EnvType: { PRODUCTION: 'PRODUCTION', SANDBOX: 'SANDBOX' },
      getCurrentScript: () => ({ getParameter: ({ name }) => state.params[name], getRemainingUsage: () => 4900 })
    },
    'N/log': {
      audit: input => state.logs.push(['audit', clone(input)]),
      error: input => state.logs.push(['error', clone(input)])
    }
  };
  let entry;
  const source = options.scriptSource ?? fs.readFileSync(process.env.MBBS_IFIR_TEST_SOURCE || scriptFile, 'utf8');
  vm.runInNewContext(source, { define: (names, factory) => { entry = factory(...names.map(name => modules[name])); } },
    { filename: `${process.cwd()}/${scriptFile}`, timeout: 2000 });
  const request = { action: 'post', sourceOrderKind: 'PO', transactionType: 'IR', sourceNetSuiteId: 901,
    payload: { externalId: 'MBBS-OP-test-1', memo: 'PO901', custbody9: 'PO901', item: { items: [
      { orderLine: 1, quantity: 2, itemReceive: true, location: 15, custcol_plt: 1 },
      { orderLine: 2, itemReceive: false, location: 15 }
    ] } } };
  const step = () => ({ ...clone(request), externalId: request.payload.externalId,
    lineSnapshot: [{ orderLine: 1, itemId: 501, quantity: 2, location: 15, salesUom: 'EACH' }] });
  return { state, request, step,
    post: (input = request) => clone(entry.post(clone(input))),
    health: () => clone(entry.get()) };
}
