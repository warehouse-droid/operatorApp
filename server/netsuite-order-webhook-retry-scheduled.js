/**
 * @NApiVersion 2.1
 * @NScriptType ScheduledScript
 *
 * MBBS order webhook retry. The order webhook queues this script when a send
 * fails with a lost connection or a retryable response (see
 * netsuite-order-webhook-lib.js). It waits until 10 seconds after the
 * failure, reloads the order and sends its current state again. If that also
 * fails, it queues itself again, for at most 3 retries. A giving-up entry
 * ("MBBS webhook retry gave up") names the order to sync by hand.
 *
 * Script record: ID customscript_mbbs_webhook_retry (enter _mbbs_webhook_retry).
 * Script parameters:
 * - custscript_mbbs_retry_job (Long Text): set by the webhook for each retry.
 * - custscript_mbbs_retry_url (Free-Form Text): the same webhook URL as the order webhook.
 * - custscript_mbbs_retry_secret (same field type as the order webhook's secret
 *   parameter): the same secret.
 * Deployments: several (e.g. 5), Status "Not Scheduled", so that retries for
 * several orders can wait at the same time.
 */
define(["N/log", "N/runtime", "./netsuite-order-webhook-lib"], (log, runtime, lib) => {
  // Server scripts cannot sleep, so wait by checking the clock. The wait
  // never exceeds the retry delay, even if the failure time is wrong.
  function waitUntil(time) {
    const end = Math.min(Number(time) || 0, Date.now() + lib.RETRY_DELAY_MS);
    while (Date.now() < end) {
      // waiting for the retry delay to pass
    }
  }

  function readJob(script) {
    try {
      const job = JSON.parse(script.getParameter({ name: lib.RETRY_JOB_PARAM }) || "null");
      const attempt = Number(job && job.attempt);
      if (!job || !job.recordType || !job.id || !(attempt >= 1 && attempt <= lib.MAX_RETRY_ATTEMPTS)) return null;
      return job;
    } catch (error) {
      return null;
    }
  }

  function execute() {
    const script = runtime.getCurrentScript();
    const job = readJob(script);
    if (!job) {
      log.error("MBBS webhook retry job invalid", {
        scriptId: script.id,
        deploymentId: script.deploymentId,
        job: lib.textValue(script.getParameter({ name: lib.RETRY_JOB_PARAM })).slice(0, 1000)
      });
      return;
    }
    waitUntil(Number(job.failedAt) + lib.RETRY_DELAY_MS);
    const diagnostic = {
      scriptId: script.id,
      deploymentId: script.deploymentId,
      executionContext: runtime.executionContext,
      trigger: lib.textValue(job.overrides && job.overrides.trigger),
      recordType: job.recordType,
      recordId: job.id,
      eventType: job.eventType,
      tranid: job.tranid,
      attempt: Number(job.attempt)
    };
    log.audit("MBBS webhook retry invoked", diagnostic);
    lib.sendWebhook({
      type: job.recordType,
      id: job.id,
      eventType: job.eventType,
      manualApproval: job.manualApproval === true,
      executionContext: job.executionContext
    }, diagnostic, job.overrides || {}, { attempt: Number(job.attempt) });
  }

  return { execute };
});
