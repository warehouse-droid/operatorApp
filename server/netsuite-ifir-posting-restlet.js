/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 */
/* global define */
// Upload as a separate script. This file does not replace the current REST flow.
define(['N/record', 'N/search', 'N/runtime', 'N/log'], (record, search, runtime, log) => {
  const VERSION = 1;
  const MAX_LINES = 1000;
  const PACK_FIELDS = ['custcol_plt', 'custcol_lyr', 'custcol_sec', 'custcol_pcs'];
  const SOURCES = { PO: 'purchaseorder', SO: 'salesorder', TO: 'transferorder' };
  const TARGETS = { IR: 'itemreceipt', IF: 'itemfulfillment' };
  const PAIRS = ['PO:IR', 'SO:IF', 'TO:IF', 'TO:IR'];

  /** @param {string} code @param {string} message @returns {never} */
  function fail(code, message) { throw Object.assign(new Error(message), { code }); }
  /** @param {string} message @returns {never} */
  function invalid(message) { fail('IFIR_INVALID_REQUEST', message); }
  /** @param {any} value @param {string} name */
  function object(value, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { invalid(`${name} must be an object.`); }
    return value;
  }
  /** @param {any} value @param {string[]} allowed @param {string} name */
  function keys(value, allowed, name) {
    object(value, name);
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) { invalid(`Unsupported ${name} field: ${key}.`); }
    }
  }
  /** @param {unknown} value @param {string} name */
  function positiveId(value, name) {
    if (!['number', 'string'].includes(typeof value) || !/^[1-9]\d*$/.test(String(value))
        || !Number.isSafeInteger(Number(value))) { invalid(`${name} must be a positive integer ID.`); }
    return Number(value);
  }
  /** @param {any} value @param {string} name */
  function referenceId(value, name) {
    if (value && typeof value === 'object') { keys(value, ['id'], name); return positiveId(value.id, name); }
    return positiveId(value, name);
  }
  /** @param {unknown} value @returns {number|null} */
  function finiteNumber(value) {
    if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') { return null; }
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  /** @param {unknown} value @param {string} name @param {number} [minimum] */
  function quantity(value, name, minimum = Number.MIN_VALUE) {
    const number = finiteNumber(value);
    if (number === null || number < minimum || number > 1e9) { invalid(`${name} is out of range.`); }
    return number;
  }
  /** @param {unknown} value @returns {boolean|null} */
  function flag(value) {
    if (value === true || value === 'T') { return true; }
    if (value === false || value === 'F') { return false; }
    return null;
  }
  /** @param {unknown} value */
  function text(value) { return value === undefined || value === null ? '' : String(value); }
  /** @param {unknown} value */
  function optionalId(value) {
    const number = finiteNumber(value);
    return number !== null && Number.isSafeInteger(number) && number > 0 ? String(number) : null;
  }
  /** @template T @param {()=>T} read @returns {T|null} */
  function optionalRead(read) { try { return read(); } catch { return null; } }
  /** @param {NSRecord} rec @param {string} fieldId */
  function body(rec, fieldId) { return rec.getValue({ fieldId }); }
  /** @param {NSRecord} rec @param {number} line @param {string} fieldId */
  function lineValue(rec, line, fieldId) { return rec.getSublistValue({ sublistId: 'item', line, fieldId }); }
  /** @param {NSRecord} rec @param {number} line @param {string} fieldId */
  function lineOptional(rec, line, fieldId) { return optionalRead(() => lineValue(rec, line, fieldId)); }
  /** @param {NSRecord} rec @param {number} line @param {string} fieldId */
  function lineText(rec, line, fieldId) {
    return text(optionalRead(() => rec.getSublistText({ sublistId: 'item', line, fieldId })));
  }
  /** @param {NSRecord} rec */
  function count(rec) {
    const length = rec.getLineCount({ sublistId: 'item' });
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_LINES) {
      fail('IFIR_LINE_LIMIT', `The item sublist must contain at most ${MAX_LINES} lines.`);
    }
    return length;
  }
  /** @param {'audit'|'error'} level @param {any} details */
  function logEvent(level, details) {
    try { log[level]({ title: 'MBBS IR/IF posting', details }); } catch { /* Logging must not change a save outcome. */ }
  }

  function activation() {
    const script = runtime.getCurrentScript();
    return {
      writesEnabled: flag(script.getParameter({ name: 'custscript_mbbs_ifir_writes_enabled' })) === true,
      productionAllowed: flag(script.getParameter({ name: 'custscript_mbbs_ifir_allow_production' })) === true
    };
  }
  function assertEnabled() {
    const settings = activation();
    if (!settings.writesEnabled) { fail('IFIR_WRITES_DISABLED', 'Enable writes on the RESTlet deployment after validation.'); }
    if (runtime.envType === runtime.EnvType.PRODUCTION && !settings.productionAllowed) {
      fail('IFIR_PRODUCTION_DISABLED', 'Production posting is disabled on this deployment.');
    }
  }
  function get() {
    return { ok: true, contractVersion: VERSION, ...activation(), environment: runtime.envType,
      supportedTransforms: PAIRS, maxLines: MAX_LINES, savedRecordReadback: true,
      explicitInventoryAssignments: false, kits: false };
  }

  /** @param {any} item @returns {IFIRSelection} */
  function validateLine(item) {
    keys(item, ['orderLine', 'itemReceive', 'quantity', 'location', ...PACK_FIELDS], 'item');
    const normalized = { ...item, orderLine: positiveId(item.orderLine, 'orderLine') };
    if (typeof item.itemReceive !== 'boolean') { invalid('itemReceive must explicitly be true or false.'); }
    if (item.itemReceive) { normalized.quantity = quantity(item.quantity, 'quantity'); }
    if (item.location !== undefined) { normalized.location = referenceId(item.location, 'location'); }
    for (const field of PACK_FIELDS) {
      if (item[field] !== undefined) { normalized[field] = quantity(item[field], field, 0); }
    }
    return normalized;
  }
  /** @param {any} input @returns {IFIRRequest} */
  function validateRequest(input) {
    keys(input, ['action', 'sourceOrderKind', 'transactionType', 'sourceNetSuiteId', 'payload'], 'request');
    if (input.action !== 'post' || !PAIRS.includes(`${input.sourceOrderKind}:${input.transactionType}`)) {
      invalid('Only PO -> IR, SO -> IF, TO -> IF and TO -> IR posting is supported.');
    }
    const payload = input.payload;
    keys(payload, ['externalId', 'memo', 'custbody9', 'inventoryLocation', 'shipStatus', 'item'], 'payload');
    if (typeof payload.externalId !== 'string' || !/^[A-Za-z0-9_:-]{1,255}$/.test(payload.externalId)) {
      invalid('A stable externalId of 1 to 255 letters, digits, underscores, colons or hyphens is required.');
    }
    for (const field of ['memo', 'custbody9']) {
      if (payload[field] !== undefined && (typeof payload[field] !== 'string' || payload[field].length > 4000)) {
        invalid(`${field} must be a string of at most 4000 characters.`);
      }
    }
    validateFulfillmentHeaders(input);
    keys(payload.item, ['items'], 'item sublist');
    if (!Array.isArray(payload.item.items) || !payload.item.items.length || payload.item.items.length > MAX_LINES) {
      invalid(`Supply between 1 and ${MAX_LINES} explicit item selections.`);
    }
    const items = payload.item.items.map(validateLine);
    if (new Set(items.map(item => item.orderLine)).size !== items.length || !items.some(item => item.itemReceive)) {
      invalid('Order lines must be unique and at least one must be selected.');
    }
    return { ...input, sourceNetSuiteId: positiveId(input.sourceNetSuiteId, 'sourceNetSuiteId'),
      payload: { ...payload, item: { items } } };
  }
  /** @param {any} input */
  function validateFulfillmentHeaders(input) {
    const { payload } = input;
    if (payload.inventoryLocation !== undefined) {
      if (input.transactionType !== 'IF') { invalid('inventoryLocation is only supported for IF.'); }
      referenceId(payload.inventoryLocation, 'inventoryLocation');
    }
    if (payload.shipStatus !== undefined && (input.transactionType !== 'IF' || !['A', 'B', 'C'].includes(payload.shipStatus))) {
      invalid('shipStatus must be A, B or C on an IF.');
    }
  }

  /** @param {IFIRRequest} request */
  function existingId(request) {
    const rows = search.create({ type: search.Type.TRANSACTION,
      filters: [['mainline', 'is', 'T'], 'and', ['externalidstring', 'is', request.payload.externalId]],
      columns: ['internalid', 'createdfrom'] }).run().getRange({ start: 0, end: 2 });
    if (rows.length > 1) { fail('IFIR_EXTERNAL_ID_CONFLICT', 'The external ID does not identify a unique transaction.'); }
    if (!rows.length) { return null; }
    const found = rows[0];
    if (found.recordType !== TARGETS[request.transactionType]
        || Number(found.getValue({ name: 'createdfrom' })) !== request.sourceNetSuiteId) {
      fail('IFIR_EXTERNAL_ID_CONFLICT', 'The external ID already belongs to another source or transaction type.');
    }
    return positiveId(found.id, 'existing transaction ID');
  }
  /** @param {NSRecord} rec @param {number} line @param {Map<number,IFIRClassification>} cache @returns {IFIRClassification} */
  function itemClassification(rec, line, cache) {
    const itemType = text(lineValue(rec, line, 'itemtype'));
    if (itemType !== 'OthCharge') { return { itemType }; }
    const id = positiveId(lineValue(rec, line, 'item'), 'charge item ID');
    if (!cache.has(id)) {
      const item = record.load({ type: record.Type.OTHER_CHARGE_ITEM, id, isDynamic: false });
      cache.set(id, { itemType, itemSubtype: text(body(item, 'subtype')),
        generateAccruals: flag(body(item, 'generateaccruals')) });
    }
    return /** @type {IFIRClassification} */ (cache.get(id));
  }
  /** @param {IFIRRequest} request @param {NSRecord} rec @param {number} line @param {Map<number,IFIRClassification>} cache */
  function nativeCharge(request, rec, line, cache) {
    if (request.sourceOrderKind !== 'PO') { return false; }
    const item = itemClassification(rec, line, cache);
    return item.itemType === 'OthCharge' && item.itemSubtype === 'Purchase' && item.generateAccruals === false;
  }
  /** @param {NSRecord} rec @param {number} line @param {string} fieldId @param {any} value */
  function setLine(rec, line, fieldId, value) { rec.setSublistValue({ sublistId: 'item', line, fieldId, value }); }
  /** @param {NSRecord} rec @param {number} line */
  function assertSimpleLine(rec, line) {
    const type = text(lineValue(rec, line, 'itemtype'));
    if (['Kit', 'Group', 'EndGroup'].includes(type) || optionalId(lineOptional(rec, line, 'kitmemberof'))) {
      fail('IFIR_UNSUPPORTED_KIT', 'Kit/group posting must continue through the existing flow until separately validated.');
    }
    if (flag(lineOptional(rec, line, 'inventorydetailreq')) === true
        || rec.hasSublistSubrecord({ sublistId: 'item', fieldId: 'inventorydetail', line })) {
      fail('IFIR_UNSUPPORTED_INVENTORY_DETAIL', 'Explicit bin, lot or serial allocation requires the existing posting flow.');
    }
  }
  /** @param {NSRecord} rec @param {number} line @param {IFIRSelection} selected */
  function applySelectedLine(rec, line, selected) {
    assertSimpleLine(rec, line);
    setLine(rec, line, 'itemreceive', true);
    if (selected.location !== undefined) { setLine(rec, line, 'location', selected.location); }
    setLine(rec, line, 'quantity', selected.quantity);
    for (const field of PACK_FIELDS) {
      if (selected[field] !== undefined) { setLine(rec, line, field, selected[field]); }
    }
  }
  /** @param {IFIRRequest} request @param {NSRecord} rec @param {Map<number,IFIRClassification>} cache */
  function applyLines(request, rec, cache) {
    const requested = new Map(request.payload.item.items.map(item => [item.orderLine, item]));
    const seen = new Set();
    const length = count(rec);
    for (let line = 0; line < length; line += 1) {
      const orderLine = positiveId(lineValue(rec, line, 'orderline'), 'transformed orderline');
      if (seen.has(orderLine)) { fail('IFIR_AMBIGUOUS_LINE', 'The transformed order line is not unique.'); }
      seen.add(orderLine);
      const selected = requested.get(orderLine);
      if (selected?.itemReceive === true) { applySelectedLine(rec, line, selected); }
      else if (selected || !nativeCharge(request, rec, line, cache)) { setLine(rec, line, 'itemreceive', false); }
    }
    for (const selected of requested.values()) {
      if (selected.itemReceive && !seen.has(selected.orderLine)) {
        fail('IFIR_MISSING_LINE', `Selected source line ${selected.orderLine} is unavailable on the transform.`);
      }
    }
  }
  /** @param {IFIRRequest} request @param {Map<number,IFIRClassification>} cache */
  function transform(request, cache) {
    const rec = record.transform({ fromType: SOURCES[request.sourceOrderKind], fromId: request.sourceNetSuiteId,
      toType: TARGETS[request.transactionType], isDynamic: false });
    rec.setValue({ fieldId: 'externalid', value: request.payload.externalId });
    for (const field of ['memo', 'custbody9']) {
      if (request.payload[field] !== undefined) { rec.setValue({ fieldId: field, value: request.payload[field] }); }
    }
    if (request.payload.inventoryLocation !== undefined) {
      rec.setValue({ fieldId: 'inventorylocation', value: referenceId(request.payload.inventoryLocation, 'inventoryLocation') });
    }
    if (request.payload.shipStatus !== undefined) { rec.setValue({ fieldId: 'shipstatus', value: request.payload.shipStatus }); }
    applyLines(request, rec, cache);
    return rec;
  }

  /** @param {NSRecord} rec @param {number} line */
  function units(rec, line) {
    return text(lineOptional(rec, line, 'unitsdisplay')) || lineText(rec, line, 'units');
  }
  /** @param {IFIRRequest} request */
  function sourceSnapshot(request) {
    const rec = record.load({ type: SOURCES[request.sourceOrderKind], id: request.sourceNetSuiteId, isDynamic: false });
    const lines = [];
    const length = count(rec);
    for (let line = 0; line < length; line += 1) {
      lines.push({ restLineId: finiteNumber(lineValue(rec, line, 'line')),
        lineId: optionalId(lineOptional(rec, line, 'lineuniquekey')),
        itemId: finiteNumber(lineValue(rec, line, 'item')), itemType: text(lineValue(rec, line, 'itemtype')),
        quantity: finiteNumber(lineValue(rec, line, 'quantity')), rate: finiteNumber(lineOptional(rec, line, 'rate')),
        locationId: finiteNumber(lineOptional(rec, line, 'location')), unit: units(rec, line) });
    }
    return { id: request.sourceNetSuiteId, sourceOrderKind: request.sourceOrderKind,
      recordType: SOURCES[request.sourceOrderKind], tranId: text(body(rec, 'tranid')), lines };
  }
  /** @param {NSRecord} rec @param {number} line */
  function inventorySnapshot(rec, line) {
    if (!rec.hasSublistSubrecord({ sublistId: 'item', fieldId: 'inventorydetail', line })) { return null; }
    const detail = rec.getSublistSubrecord({ sublistId: 'item', fieldId: 'inventorydetail', line });
    const length = detail.getLineCount({ sublistId: 'inventoryassignment' });
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_LINES) { fail('IFIR_LINE_LIMIT', 'Inventory detail is too large.'); }
    const items = [];
    const fields = { issueInventoryNumber: 'issueinventorynumber', receiptInventoryNumber: 'receiptinventorynumber',
      binNumber: 'binnumber', toBinNumber: 'tobinnumber', inventoryStatus: 'inventorystatus',
      toInventoryStatus: 'toinventorystatus', quantity: 'quantity' };
    for (let row = 0; row < length; row += 1) {
      /** @type {Record<string, string | number | null>} */
      const item = {};
      for (const [key, fieldId] of Object.entries(fields)) {
        const value = optionalRead(() => detail.getSublistValue({ sublistId: 'inventoryassignment', line: row, fieldId }));
        item[key] = key === 'quantity' ? finiteNumber(value) : text(value) || null;
      }
      items.push(item);
    }
    return { inventoryAssignment: { items } };
  }
  /** @param {NSRecord} rec @param {number} line @param {Map<number,IFIRClassification>} cache @returns {IFIRSavedLine} */
  function savedLine(rec, line, cache) {
    const unit = units(rec, line);
    /** @type {IFIRSavedLine} */
    const result = {
      orderLine: finiteNumber(lineValue(rec, line, 'orderline')),
      line: finiteNumber(lineValue(rec, line, 'line')),
      lineUniqueKey: optionalId(lineOptional(rec, line, 'lineuniquekey')),
      item: { id: optionalId(lineValue(rec, line, 'item')), refName: lineText(rec, line, 'item') },
      itemReceive: flag(lineValue(rec, line, 'itemreceive')),
      quantity: finiteNumber(lineValue(rec, line, 'quantity')),
      location: { id: optionalId(lineValue(rec, line, 'location')) },
      units: { id: optionalId(lineValue(rec, line, 'units')), refName: unit }, unitsDisplay: unit,
      orderDoc: { id: optionalId(lineOptional(rec, line, 'orderdoc')) },
      ...itemClassification(rec, line, cache),
      itemUnitPrice: finiteNumber(lineOptional(rec, line, 'itemunitprice')),
      itemFxAmount: finiteNumber(lineOptional(rec, line, 'itemfxamount')),
      inventoryDetail: inventorySnapshot(rec, line)
    };
    for (const field of PACK_FIELDS) { result[field] = finiteNumber(lineOptional(rec, line, field)); }
    return result;
  }
  /** @param {IFIRRequest} request @param {NSRecord} rec */
  function assertSavedIdentity(request, rec) {
    if (rec.type !== TARGETS[request.transactionType] || Number(body(rec, 'createdfrom')) !== request.sourceNetSuiteId
        || text(body(rec, 'externalid')) !== request.payload.externalId) {
      fail('IFIR_EXTERNAL_ID_CONFLICT', 'Saved transaction identity differs from the requested source, type or external ID.');
    }
  }
  /** @param {{tranId: string, item: {items: IFIRSavedLine[]}}} snapshot */
  function assertComplete(snapshot) {
    const invalidLine = snapshot.item.items.some(item => !optionalId(item.orderLine) || !item.item.id
      || item.itemReceive === null || item.quantity === null || !item.unitsDisplay);
    if (!snapshot.tranId.trim() || invalidLine || !snapshot.item.items.some(item => item.itemReceive && (item.quantity ?? 0) > 0)) {
      fail('IFIR_INCOMPLETE_READBACK', 'The saved transaction number or line evidence is incomplete; reconcile by internal/external ID.');
    }
  }
  /** @param {IFIRRequest} request @param {IFIRState} state @param {string} outcome @param {Map<number,IFIRClassification>} cache */
  function savedResponse(request, state, outcome, cache) {
    state.stage = 'readback';
    const rec = record.load({ type: TARGETS[request.transactionType], id: positiveId(state.id, 'saved transaction ID'), isDynamic: false });
    assertSavedIdentity(request, rec);
    const items = [];
    const length = count(rec);
    for (let line = 0; line < length; line += 1) { items.push(savedLine(rec, line, cache)); }
    const snapshot = { id: state.id, tranId: text(body(rec, 'tranid')), externalId: text(body(rec, 'externalid')),
      transactionType: request.transactionType, recordType: rec.type, createdFromId: Number(body(rec, 'createdfrom')),
      status: text(optionalRead(() => body(rec, 'status'))), shipStatus: text(optionalRead(() => body(rec, 'shipstatus'))),
      tranDate: body(rec, 'trandate'), memo: text(body(rec, 'memo')), custbody9: text(optionalRead(() => body(rec, 'custbody9'))),
      location: { id: optionalId(optionalRead(() => body(rec, 'location'))) }, item: { items } };
    assertComplete(snapshot);
    const source = sourceSnapshot(request);
    logEvent('audit', { outcome, id: state.id, tranId: snapshot.tranId, externalId: snapshot.externalId });
    return { ok: true, contractVersion: VERSION, complete: true, requiresReconciliation: false,
      outcome, id: state.id, tranId: snapshot.tranId, record: snapshot, source };
  }
  /** @param {IFIRRequest} request @param {NSRecord} rec @param {IFIRState} state */
  function saveOnce(request, rec, state) {
    state.stage = 'save';
    state.saveAttempted = true;
    try {
      state.id = positiveId(rec.save({ enableSourcing: true, ignoreMandatoryFields: false }), 'saved transaction ID');
      return 'created';
    } catch (error) {
      // A duplicate race or a save followed by an error may already have committed.
      // Only read here: never transform/save again within this attempt.
      state.id = existingId(request);
      if (state.id) { return 'existing'; }
      throw error;
    }
  }
  /** @param {any} input */
  function post(input) {
    /** @type {IFIRState} */
    const state = { stage: 'validation', saveAttempted: false, id: null };
    try {
      assertEnabled();
      const request = validateRequest(input);
      const cache = new Map();
      state.stage = 'duplicate_check';
      state.id = existingId(request);
      if (state.id) { return savedResponse(request, state, 'existing', cache); }
      state.stage = 'transform';
      const rec = transform(request, cache);
      const outcome = saveOnce(request, rec, state);
      return savedResponse(request, state, outcome, cache);
    } catch (error) {
      const ambiguous = state.saveAttempted || state.id !== null;
      /** @type {{code?: unknown, name?: unknown, message?: unknown}} */
      const problem = error && typeof error === 'object' ? error : { message: error };
      const result = { ok: false, contractVersion: VERSION, complete: false,
        code: text(problem.code || problem.name || 'IFIR_FAILED'), message: text(problem.message || error),
        stage: state.stage, id: state.id, ambiguous, requiresReconciliation: ambiguous,
        postingNotAttempted: !state.saveAttempted && state.id === null };
      logEvent('error', result);
      return result;
    }
  }
  return { post, get };
});
