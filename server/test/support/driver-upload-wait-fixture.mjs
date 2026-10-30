import {loadUpload, photo, xhrFixture} from "./driver-upload-fixtures.mjs";

export async function flushUploadTasks() {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

function lifecycle() {
  const handlers = new Map();
  return {
    visibilityState: "visible",
    addEventListener(name, handler) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(handler);
    },
    removeEventListener(name, handler) {handlers.get(name)?.delete(handler);},
    fire(name) {for (const handler of [...(handlers.get(name) || [])]) handler();},
    count() {return [...handlers.values()].reduce((total, entries) => total + entries.size, 0);}
  };
}

export async function waitingUpload(overrides = {}) {
  let now = 100000;
  let sequence = 0;
  const timers = new Map();
  class UploadDate extends Date {static now() {return now;}}
  const document = lifecycle();
  const windowEvents = lifecycle();
  const controller = new AbortController();
  const fixture = xhrFixture(() => {});
  const value = photo(1000000);
  const failures = [];
  const phases = [];
  const result = {};
  const upload = loadUpload({
    ...fixture, Date: UploadDate, document, navigator: {onLine: true},
    addEventListener: windowEvents.addEventListener,
    removeEventListener: windowEvents.removeEventListener,
    setTimeout(callback, ms) {const id = ++sequence; timers.set(id, {callback, at: now + ms}); return id;},
    clearTimeout(id) {timers.delete(id);},
    ...overrides
  });
  const options = {signal: controller.signal,
    ticket: async () => ({uploadUrl: "https://fixture.invalid/upload", token: "fixture-only"}), // secret-scan: allow -- synthetic ticket for the fake transport.
    onFailure: failure => failures.push(failure), onProgress: progress => phases.push(progress)};
  const operation = upload.upload(value, options).then(reference => {result.reference = reference;}, error => {result.error = error;});
  await flushUploadTasks();
  return {upload, value, options, fixture, xhr: fixture.requests[0], failures, phases, result, operation,
    controller, document, windowEvents, timers,
    async advance(ms, runTimers = true) {
      now += ms;
      if (runTimers) {
        for (const [id, timer] of [...timers]) {
          if (timer.at <= now && timers.delete(id)) timer.callback();
        }
      }
      await flushUploadTasks();
    },
    async stop() {controller.abort(); await operation;}
  };
}
