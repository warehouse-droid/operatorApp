import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHook } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { app } from "../../../src/server.js";
import { query, withTransaction, closeDb } from "../../../src/db.js";
import { updateOperatorPassword, loginOperator } from "../../../src/auth-repository.js";
import { planningFixture } from "../support/bin-planning-fixtures.js";
after(closeDb);

test("leaving a planner while event-stream authentication is pending cannot open an orphaned stream", async () => {
  const f = await planningFixture(2190);
  await updateOperatorPassword(f.actor.operatorId, 'events-test-password');
  const token = (await loginOperator(f.actor.operatorId, 'events-test-password')).token;
  const timers = new Set();
  const hook = createHook({ init(_id, type, _parent, resource) { if (type === 'Timeout' && resource._repeat === 25000) timers.add(resource); } }).enable();
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  let received; const requestReceived = new Promise(resolve => { received = resolve; });
  let disconnected; const clientDisconnected = new Promise(resolve => { disconnected = resolve; });
  server.once('request', (_req, res) => { res.once('close', disconnected); received(); });
  try {
    await withTransaction(async () => {
      await query('LOCK TABLE operator_sessions IN ACCESS EXCLUSIVE MODE');
      const abort = new AbortController();
      const response = fetch(`http://127.0.0.1:${server.address().port}/api/events?client=dispatch&token=${encodeURIComponent(token)}`, { signal: abort.signal }).catch(error => error);
      await requestReceived;
      // The session table remains locked until this response disconnects.
      abort.abort(); await response; await clientDisconnected;
    });
    await delay(250);
    assert.equal(timers.size, 0, 'A closed planner must not create an event-stream heartbeat after authentication finishes');
  } finally {
    hook.disable(); for (const timer of timers) clearInterval(timer);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
