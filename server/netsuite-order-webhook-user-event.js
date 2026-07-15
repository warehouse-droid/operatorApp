/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * Deploy this script on:
 * - Sales Order
 * - Purchase Order
 * - Transfer Order
 *
 * This User Event only queues the webhook worker. It must not load transaction
 * details or make outbound HTTPS requests because NetSuite workflows wait for
 * synchronous User Event processing to finish.
 *
 * Script parameters:
 * - custscriptmbbs_webhook_url or custscript_mbbs_webhook_url
 * - custscriptwh_webhook_secret_i or custscript_mbbs_webhook_secret
 * - custscriptmbbs_webhook_worker_script (optional; defaults below)
 * - custscriptmbbs_webhook_worker_deploy (optional)
 */
define(["N/log", "N/runtime", "N/task"], (log, runtime, task) => {
  const DEFAULT_WORKER_SCRIPT_ID = "customscript_mbbs_order_webhook_worker";
  const PARAM_URLS = [
    "custscriptmbbs_webhook_url",
    "custscript_mbbs_webhook_url"
  ];
  const PARAM_SECRETS = [
    "custscriptwh_webhook_secret_i",
    "custscript_mbbs_webhook_secret",
    "custscript_webhook_secret_id"
  ];
  const PARAM_WORKER_SCRIPTS = [
    "custscriptmbbs_webhook_worker_script"
  ];
  const PARAM_WORKER_DEPLOYMENTS = [
    "custscriptmbbs_webhook_worker_deploy"
  ];
  const WORKER_PARAMS = {
    recordType: "custscriptmbbs_wh_record_type",
    recordId: "custscriptmbbs_wh_record_id",
    eventType: "custscriptmbbs_wh_event_type",
    url: "custscriptmbbs_wh_url",
    secret: "custscriptmbbs_wh_secret"
  };

  function scriptParameter(script, names) {
    for (let index = 0; index < names.length; index += 1) {
      try {
        const value = script.getParameter({ name: names[index] });
        if (value) return String(value).trim();
      } catch (error) {
        // Optional/legacy parameter IDs may not exist on every deployment.
      }
    }
    return "";
  }

  function parameterSnapshot(script, names) {
    return names.map((name) => {
      let configured = false;
      let error = "";
      try {
        configured = Boolean(script.getParameter({ name }));
      } catch (lookupError) {
        error = lookupError.message || String(lookupError);
      }
      return { name, configured, error };
    });
  }

  function afterSubmit(context) {
    if (context.type === context.UserEventType.DELETE) return;

    const script = runtime.getCurrentScript();
    try {
      const url = scriptParameter(script, PARAM_URLS);
      const secret = scriptParameter(script, PARAM_SECRETS);
      if (!url || !secret) {
        log.error("MBBS webhook missing parameters", {
          scriptId: script.id,
          deploymentId: script.deploymentId,
          urlConfigured: Boolean(url),
          secretConfigured: Boolean(secret),
          acceptedUrlParameterIds: PARAM_URLS,
          acceptedSecretParameterIds: PARAM_SECRETS,
          urlParameters: parameterSnapshot(script, PARAM_URLS),
          secretParameters: parameterSnapshot(script, PARAM_SECRETS)
        });
        return;
      }

      const workerScriptId = scriptParameter(script, PARAM_WORKER_SCRIPTS)
        || DEFAULT_WORKER_SCRIPT_ID;
      const workerDeploymentId = scriptParameter(script, PARAM_WORKER_DEPLOYMENTS);
      const worker = task.create({ taskType: task.TaskType.SCHEDULED_SCRIPT });
      worker.scriptId = workerScriptId;
      if (workerDeploymentId) worker.deploymentId = workerDeploymentId;
      worker.params = {
        [WORKER_PARAMS.recordType]: String(context.newRecord.type || ""),
        [WORKER_PARAMS.recordId]: String(context.newRecord.id || ""),
        [WORKER_PARAMS.eventType]: String(context.type || ""),
        [WORKER_PARAMS.url]: url,
        [WORKER_PARAMS.secret]: secret
      };

      const taskId = worker.submit();
      log.audit("MBBS webhook queued", {
        taskId,
        recordType: context.newRecord.type,
        recordId: context.newRecord.id,
        eventType: context.type
      });
    } catch (error) {
      // A webhook integration failure must never interrupt the normal workflow.
      log.error("MBBS webhook queue failed", {
        scriptId: script.id,
        deploymentId: script.deploymentId,
        recordType: context.newRecord && context.newRecord.type,
        recordId: context.newRecord && context.newRecord.id,
        eventType: context.type,
        name: error.name,
        message: error.message,
        stack: error.stack
      });
    }
  }

  return { afterSubmit };
});
