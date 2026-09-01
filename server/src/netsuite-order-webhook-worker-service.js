function requiredFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`NetSuite order webhook worker dependency ${name} is required.`);
  }
  return value;
}

function message(error) {
  return String(error?.message || error || "NetSuite order webhook processing failed.").slice(0, 8_000);
}

export function createNetSuiteOrderWebhookWorker(dependencies = {}) {
  const claim = requiredFunction(dependencies.claim, "claim");
  const processJob = requiredFunction(dependencies.process, "process");
  const complete = requiredFunction(dependencies.complete, "complete");
  const fail = requiredFunction(dependencies.fail, "fail");
  const renew = typeof dependencies.renew === "function" ? dependencies.renew : async () => true;
  const logger = dependencies.logger || console;
  const setIntervalFn = dependencies.setIntervalFn || setInterval;
  const clearIntervalFn = dependencies.clearIntervalFn || clearInterval;
  const completeInProcess = dependencies.completeInProcess === true;
  const heartbeatMs = Math.max(1_000, Number(dependencies.heartbeatMs) || 30_000);
  let running = false;

  function heartbeat(job) {
    let renewing = false;
    const timer = setIntervalFn(async () => {
      if (renewing) return;
      renewing = true;
      try {
        const owned = await renew({ id: job.id, leaseToken: job.leaseToken });
        if (!owned) logger.error(`NetSuite order webhook ${job.id} lease renewal was fenced.`);
      } catch (error) {
        logger.error(`NetSuite order webhook ${job.id} lease renewal failed: ${message(error)}`);
      } finally {
        renewing = false;
      }
    }, heartbeatMs);
    timer?.unref?.();
    return () => clearIntervalFn(timer);
  }

  async function tick() {
    if (running) return { skipped: true, processed: false, failed: false };
    running = true;
    let job = null;
    let stopHeartbeat = () => {};
    try {
      job = await claim();
      if (!job) return { skipped: false, processed: false, failed: false };
      stopHeartbeat = heartbeat(job);
      const result = await processJob(job);
      if (!completeInProcess) {
        await complete({ id: job.id, leaseToken: job.leaseToken, result: result || {} });
      }
      return { skipped: false, processed: true, failed: false, id: job.id };
    } catch (error) {
      if (job) {
        try {
          await fail({ id: job.id, leaseToken: job.leaseToken, error });
        } catch (finishError) {
          logger.error(`NetSuite order webhook ${job.id} failure could not be recorded: ${message(finishError)}`);
        }
      }
      logger.error(`NetSuite order webhook worker failed: ${message(error)}`);
      return { skipped: false, processed: false, failed: true, id: job?.id || null, error: message(error) };
    } finally {
      stopHeartbeat();
      running = false;
    }
  }

  return {
    tick,
    get running() {
      return running;
    }
  };
}
