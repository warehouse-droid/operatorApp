/**
 * @NApiVersion 2.1
 * @NScriptType ScheduledScript
 */
define(['N/log', './ppa_refresh_queue'], (log, queue) => {
  'use strict';
  function execute() {
    try { queue.kick(); }
    catch (error) {
      log.error({ title: 'PALLET REFRESH DISPATCH FAILED', details: String(error.message || error) });
      throw error;
    }
  }
  return { execute };
});
