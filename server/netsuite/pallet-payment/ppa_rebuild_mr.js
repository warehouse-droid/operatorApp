/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/runtime', 'N/log', './ppa_netsuite', './ppa_service', './ppa_refresh_queue'], (runtime, log, io, service, queue) => {
  'use strict';
  const parameter = name => runtime.getCurrentScript().getParameter({ name });
  function queueOnly() {
    const value = parameter('custscript_ppa_queue_only');
    return value === true || value === 'T';
  }
  function previewOnly() {
    const value = parameter('custscript_ppa_dry_run');
    return value !== false && value !== 'F';
  }
  function getInputData() {
    return queueOnly() ? queue.due() : io.customers(parameter('custscript_ppa_customer'));
  }
  function map(context) {
    const value = JSON.parse(context.value);
    context.write(queueOnly() ? { key: String(value.customer), value: String(value.token) } : { key: String(value), value: '1' });
  }
  function report(customer, dryRun, result) {
    log.audit({ title: `${dryRun ? 'PREVIEW' : 'REBUILT'} customer ${customer}`, details: JSON.stringify({
      generatedAt: new Date().toISOString(), verified: result.verified, issued: result.issued, credited: result.credited,
      physical: result.physical, allocationRows: result.allocations.length, refundRows: result.events.length,
      issues: result.issues, preview: result.allocations.slice(0, 12).map(a => ({
        invoice: a.invoice, method: a.method, last4: a.last4, rate: a.rate / 100, allocated: a.qty,
        pending: a.pending, refunded: a.refunded, available: a.available
      }))
    }) });
  }
  function reduce(context) {
    const dryRun = previewOnly();
    try {
      const result = service.refresh(io, context.key, dryRun);
      if (queueOnly() && !dryRun) { queue.acknowledge(context.key, context.values); }
      report(context.key, dryRun, result);
      context.write({ key: context.key, value: result.verified ? 'VERIFIED' : 'REVIEW' });
    } catch (error) {
      if (queueOnly() && !dryRun) {
        try { queue.defer(context.key, context.values, error); }
        catch (retryError) { log.error({ title: 'PALLET QUEUE RETRY FAILED', details: String(retryError.message || retryError) }); }
      }
      throw error;
    }
  }
  function summarize(summary) {
    const counts = { verified: 0, review: 0, errors: 0 };
    if (summary.inputSummary.error) {
      counts.errors += 1;
      log.error({ title: 'PALLET INPUT FAILED', details: summary.inputSummary.error });
    }
    for (const stage of [summary.mapSummary, summary.reduceSummary]) {
      stage.errors.iterator().each((key, error) => {
        counts.errors += 1;
        log.error({ title: `PALLET CUSTOMER ${key} FAILED`, details: error }); return true;
      });
    }
    summary.output?.iterator().each((_key, value) => {
      if (value === 'VERIFIED') { counts.verified += 1; }
      if (value === 'REVIEW') { counts.review += 1; }
      return true;
    });
    const entry = { title: counts.errors ? 'Pallet rebuild finished with errors' : 'Pallet rebuild finished',
      details: JSON.stringify({ ...counts, generatedAt: new Date().toISOString(), preview: previewOnly(),
        note: 'REVIEW customers need reconciliation. Failed customers were not successfully rebuilt.' }) };
    if (counts.errors) { log.error(entry); } else { log.audit(entry); }
    if (queueOnly() && !previewOnly() && counts.errors === 0) {
      try { queue.kick(); }
      catch (error) { log.error({ title: 'PALLET REFRESH DISPATCH FAILED', details: String(error.message || error) }); }
    }
  }
  return { getInputData, map, reduce, summarize };
});
