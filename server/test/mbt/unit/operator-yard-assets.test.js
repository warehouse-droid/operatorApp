import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";

/* global Request */

test("Operator service worker precaches the exact new page assets, preserves Driver caches, and bypasses API requests", async () => {
  const source = await readFile("public/service-worker.js", "utf8");
  const html = await readFile("public/operator.html", "utf8");
  const events = new Map(), deleted = [], installed = [];
  const context = vm.createContext({
    URL,
    Request,
    self: { addEventListener: (name, listener) => events.set(name, listener), skipWaiting: async () => {}, clients: { claim: async () => {} }, location: { origin: "https://yard.invalid" } },
    caches: {
      open: async (name) => ({ addAll: async (assets) => installed.push({ name, assets: assets.map((request) => request.url) }) }),
      keys: async () => ["mbbs-yard-operator-old", "mbbs-driver-stable"],
      delete: async (name) => deleted.push(name)
    }
  });
  new vm.Script(source, { filename: path.resolve("public/service-worker.js") }).runInContext(context);
  const waits = [];
  events.get("install")({ waitUntil: (promise) => waits.push(promise) });
  await Promise.all(waits);
  assert.equal(installed[0].name, "mbbs-yard-operator-v145-yard-access-v1");
  for (const asset of ["operator.js", "operator.css", "i18n.js"]) {
    const url = `/${asset}?v=20260915-operator-yards-v1`;
    assert.ok(html.includes(url));
    assert.ok(installed[0].assets.includes(`https://yard.invalid${url}`));
  }
  events.get("activate")({ waitUntil: (promise) => waits.push(promise) });
  await Promise.all(waits);
  assert.deepEqual(deleted, ["mbbs-yard-operator-old"]);
  let intercepted = false;
  events.get("fetch")({ request: { method: "GET", url: "https://yard.invalid/api/delivery/orders?locationId=1" }, respondWith: () => { intercepted = true; } });
  assert.equal(intercepted, false);
});

test("Dispatch live events use the real login token and retain a single connection", async () => {
  const source = await readFile("public/dispatch.js", "utf8");
  const start = source.indexOf("function connectEvents() {");
  const end = source.indexOf("\nfunction ", start + 1);
  assert.ok(start >= 0 && end > start);
  // Preserve source offsets for V8 coverage while executing the real connection
  // function; EventSource is the only network boundary replaced by this test.
  const executable = source.slice(0, start).replace(/[^\n]/g, " ") + source.slice(start, end) + source.slice(end).replace(/[^\n]/g, " ");
  const urls = [];
  const context = vm.createContext({
    eventSource: null, dispatchSessionId: "dispatch-session", readDispatchAuthToken: () => "test-token +?&",
    EventSource: class { constructor(url) { urls.push(url); } addEventListener() {} }
  });
  new vm.Script(executable, { filename: path.resolve("public/dispatch.js") }).runInContext(context);
  vm.runInContext("connectEvents(); connectEvents();", context);
  assert.equal(urls.length, 1);
  const url = new URL(urls[0], "https://yard.invalid");
  assert.equal(url.searchParams.get("token"), "test-token +?&");
  assert.equal(url.searchParams.get("sessionId"), "dispatch-session");
});
