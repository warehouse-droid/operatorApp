import assert from "node:assert/strict";
import test from "node:test";
import {EventEmitter} from "node:events";
import {setImmediate} from "node:timers/promises";
import {traceDriverCompletion} from "../../../src/driver-completion-trace.js";

const requestId = "109f7225-b931-4df6-8dca-ed474bc560da";
function fixture(id = requestId) {
  const response = new EventEmitter();
  const logs = [];
  const trace = traceDriverCompletion({driverLogin: "fixture", deviceId: "device", jobId: "job", requestId: id}, response, event => logs.push(event));
  return {response, logs, trace};
}
test("server logs exactly where a connection closed, then records a later successful commit", () => {
  const {response, logs, trace} = fixture();
  trace.mark("location_verified");
  response.emit("close");
  trace.mark("evidence_committed");
  const closed = logs.find(event => event.action === "driver.job.connection_closed");
  assert.equal(closed.details.lastStep, "location_verified");
  assert.equal(closed.details.requestId, requestId);
  assert.ok(logs.some(event => event.action === "driver.job.evidence_committed"));
});
test("response finish is distinguished from client acknowledgement and does not log a false disconnect", () => {
  const {response, logs, trace} = fixture();
  trace.mark("evidence_committed");
  trace.mark("next_job_started");
  response.emit("finish");
  response.emit("close");
  const sent = logs.find(event => event.action === "driver.job.response_finished");
  assert.equal(sent.details.clientAcknowledged, false);
  assert.equal(sent.details.lastStep, "next_job_started");
  assert.ok(sent.details.steps.every(step => Number.isFinite(step.elapsedMs) && step.at.endsWith("Z")));
  assert.equal(logs.filter(event => event.action === "driver.job.connection_closed").length, 0);
});
test("server error and request identity diagnostics cannot retain credentials", () => {
  const {logs, trace} = fixture("Bearer private-value");
  trace.fail(new Error("Bearer private-value data:image/jpeg;base64,private-image"));
  const log = logs.find(event => event.action === "driver.job.completion_failed");
  assert.match(log.details.requestId, /^[0-9a-f-]{36}$/u);
  assert.doesNotMatch(JSON.stringify(logs), /private-value|private-image/u);
});

test("trace storage errors are reported without interrupting job completion", async () => {
  const messages = [];
  const original = console.error;
  console.error = (...values) => messages.push(values.join(" "));
  try {
    for (const write of [() => {throw new Error("Bearer private-value");}, () => Promise.reject(new Error("Bearer private-value"))]) {
      const response = new EventEmitter();
      const trace = traceDriverCompletion({requestId}, response, write);
      assert.doesNotThrow(() => trace.mark("evidence_committed"));
      response.emit("finish");
    }
    await setImmediate();
    assert.equal(messages.length, 6);
    assert.ok(messages.every(message => message.includes("Driver completion trace storage failed:")));
    assert.doesNotMatch(messages.join(" "), /private-value/u);
  } finally {console.error = original;}
});
