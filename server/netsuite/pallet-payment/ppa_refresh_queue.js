/**
 * @NApiVersion 2.1
 */
define(['N/record', 'N/search', 'N/task', 'N/runtime', 'N/log', './ppa_config'],
  (record, search, task, runtime, log, config) => {
    'use strict';
    const F = config.queueFields;
    const minute = () => Math.floor(Date.now() / 60000);
    function id(value) {
      const result = String(value);
      if (!/^[1-9]\d*$/.test(result) || !Number.isSafeInteger(Number(result))) { throw new Error('INVALID_INTERNAL_ID'); }
      return result;
    }
    function account() {
      if (String(runtime.accountId).split('_')[0] !== config.account) { throw new Error('WRONG_NETSUITE_ACCOUNT'); }
    }
    function writer() {
      account();
      if (runtime.getCurrentScript().deploymentId !== config.writerDeployment) { throw new Error('USE_SINGLE_DESIGNATED_DEPLOYMENT'); }
    }
    function select(filters) {
      return search.create({ type: config.queueType, filters,
        columns: [search.createColumn({ name: 'internalid', sort: search.Sort.ASC }), F.customer]
      }).run().getRange({ start: 0, end: config.queueBatchSize }).map(row => ({
        token: id(row.getValue({ name: 'internalid' })), customer: id(row.getValue({ name: F.customer }))
      }));
    }
    function enqueue(customer, source) {
      account();
      const customerId = id(customer);
      const rec = record.create({ type: config.queueType, isDynamic: false });
      const values = { name: `${customerId} | ${String(source).slice(0, 200)}`, isinactive: false,
        [F.customer]: customerId, [F.retry]: 0, [F.error]: '' };
      for (const [fieldId, value] of Object.entries(values)) { rec.setValue({ fieldId, value }); }
      return String(rec.save({ enableSourcing: false, ignoreMandatoryFields: false }));
    }
    function due() {
      account();
      return select([['isinactive', 'is', 'F'], 'and', [F.retry, 'lessthanorequalto', minute()]]);
    }
    function captured(customer, tokens) {
      writer();
      const customerId = id(customer);
      const ids = [...new Set(tokens.map(id))];
      if (!ids.length) { return []; }
      if (ids.length > config.queueBatchSize) { throw new Error('QUEUE_BATCH_LIMIT'); }
      return select([[F.customer, 'anyof', customerId], 'and', ['internalid', 'anyof', ids]]);
    }
    function acknowledge(customer, tokens) {
      // Never clear all rows for a customer: a later save may have added another token.
      for (const row of captured(customer, tokens)) { record.delete({ type: config.queueType, id: row.token }); }
    }
    function defer(customer, tokens, error) {
      const values = { [F.retry]: minute() + config.queueRetryMinutes, [F.error]: String(error.message || error).slice(0, 3000) };
      for (const row of captured(customer, tokens)) {
        record.submitFields({ type: config.queueType, id: row.token, values, options: { enableSourcing: false } });
      }
    }
    function kick() {
      if (!due().length) { return false; }
      try {
        const taskId = task.create({ taskType: task.TaskType.MAP_REDUCE, scriptId: config.writerScript,
          deploymentId: config.writerDeployment, params: {
            custscript_ppa_queue_only: true, custscript_ppa_dry_run: false, custscript_ppa_customer: ''
          } }).submit();
        log.audit({ title: 'PALLET REFRESH SUBMITTED', details: taskId || 'Continuation requested after current run.' });
        return true;
      } catch (error) {
        if (error.name === 'MAP_REDUCE_ALREADY_RUNNING') {
          log.audit({ title: 'PALLET REFRESH WAITING', details: 'Writer is busy; saved queue entries remain pending.' });
        } else {
          log.error({ title: 'PALLET REFRESH DISPATCH FAILED', details: String(error.message || error) });
        }
        return false;
      }
    }
    return { enqueue, due, acknowledge, defer, kick };
});
