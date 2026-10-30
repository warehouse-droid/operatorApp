/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/log', './ppa_config', './ppa_refresh_queue'], (record, log, config, queue) => {
  'use strict';
  const customerFields = { salesorder: 'entity', invoice: 'entity', creditmemo: 'entity', customerpayment: 'customer',
    customerrefund: 'customer', customerdeposit: 'customer', depositapplication: 'customer' };
  const events = ['create', 'edit', 'xedit', 'delete', 'approve', 'cancel', 'reject'];
  const value = (rec, fieldId) => rec.getValue({ fieldId });
  const absent = entry => entry === undefined || entry === null;
  function fullRecord(rec, fieldId, canLoad) {
    const missing = rec.getFields ? !rec.getFields().includes(fieldId) : absent(value(rec, fieldId));
    if (missing && canLoad) { return record.load({ type: rec.type, id: rec.id, isDynamic: false }); }
    return rec;
  }
  function allocationCustomer(source, canLoad) {
    const identified = fullRecord(source, 'externalid', canLoad);
    if (String(value(identified, 'externalid') || '').startsWith('PRA1-')) { return ''; }
    const rec = fullRecord(identified, config.refundFields.allocationId, canLoad);
    const allocationId = value(rec, config.refundFields.allocationId);
    if (!allocationId) { throw new Error('MANUAL_ALLOCATION_LINK_MISSING'); }
    const allocation = record.load({ type: config.allocationType, id: allocationId, isDynamic: false });
    const result = value(allocation, config.allocationFields.customer);
    if (!result) { throw new Error('ALLOCATION_CUSTOMER_MISSING'); }
    return result;
  }
  function customer(rec, canLoad) {
    if (!rec) { return ''; }
    if (rec.type === config.refundType) { return allocationCustomer(rec, canLoad); }
    const fieldId = customerFields[rec.type];
    if (!fieldId) { return ''; }
    const result = value(fullRecord(rec, fieldId, canLoad), fieldId);
    if (!result) { throw new Error('TRANSACTION_CUSTOMER_MISSING'); }
    return result;
  }
  function failure(source, error) {
    log.error({ title: 'PALLET REFRESH CAPTURE FAILED', details: `${source} | ${String(error.message || error)}` });
  }
  function affected(context, source) {
    const found = new Set();
    const records = context.type === 'delete' ? [context.oldRecord] : [context.oldRecord, context.newRecord];
    for (const rec of records) {
      try {
        const result = customer(rec, rec === context.newRecord && context.type !== 'delete');
        if (result) { found.add(String(result)); }
      } catch (error) { failure(source, error); }
    }
    return found;
  }
  function afterSubmit(context) {
    if (!events.includes(context.type)) { return; }
    const rec = context.newRecord || context.oldRecord;
    if (!rec) { return; }
    const source = `${rec.type}:${rec.id}:${context.type}`;
    let queued = false;
    for (const customerId of affected(context, source)) {
      try { queue.enqueue(customerId, source); queued = true; }
      catch (error) { failure(source, error); }
    }
    if (queued) {
      try { queue.kick(); }
      catch (error) { failure(source, error); }
    }
  }
  return { afterSubmit };
});
