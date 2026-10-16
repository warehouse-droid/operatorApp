import {randomUUID} from "node:crypto";
import {safeUploadFailureMessage} from "./driver-upload-failure.js";

// A response finish only means Node handed bytes to the transport. It is not
// evidence that the phone received them. Keep later commits after a close too.
export function traceDriverCompletion(identity, response, write) {
  const requestId = /^[0-9a-f-]{36}$/iu.test(String(identity.requestId || "")) ? identity.requestId : randomUUID();
  const started = performance.now();
  const steps = [];
  let finished = false;
  function persist(step, extra = {}) {
    const details = {...identity, requestId, lastStep: steps.at(-1)?.step || "received",
      steps: steps.map(value => ({...value})), elapsedMs: Math.round(performance.now() - started),
      clientAcknowledged: false, ...extra};
    const event = {actorType: "driver", source: "driver-completion", action: `driver.job.${step}`, details};
    try { Promise.resolve(write(event)).catch(error => console.error("Driver completion trace storage failed:", safeUploadFailureMessage(error.message))); }
    catch (error) { console.error("Driver completion trace storage failed:", safeUploadFailureMessage(error.message)); }
  }
  function mark(step) {
    steps.push({step, at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started)});
    if (["received", "evidence_committed", "next_job_started"].includes(step)) persist(step);
  }
  response.once("finish", () => { finished = true; persist("response_finished", {httpStatus: response.statusCode}); });
  response.once("close", () => { if (!finished) persist("connection_closed"); });
  mark("received");
  return {requestId, mark, fail: error => persist("completion_failed", {error: safeUploadFailureMessage(error.message), code: safeUploadFailureMessage(error.code || "completion_failed")})};
}
