(function (global) {
  'use strict';
  const prefix = 'mbbs.netsuite-failure.v1:';
  function safe(value, limit = 4000) {
    return String(value ?? '')
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/giu, '[private key omitted]')
      .replace(/data:[^\s,]*,[^\s"'<>]+/giu, '[image omitted]')
      .replace(/\b(?:Bearer|Basic)\s+[^\s"'<>;,]+/giu, '[authorization omitted]')
      .replace(/(["']?\b(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization|api[_-]?key|token|secret|signature|client_assertion)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s&;,}]+)/giu, '$1[redacted]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[token omitted]')
      .replace(/https?:\/\/[^\s"'<>]+/giu, urlText => {
        try { const url = new URL(urlText); return `${url.protocol}//${url.host}${url.pathname}`; }
        catch { return '[URL omitted]'; }
      }).slice(0, limit);
  }
  function create({ actorId, locationId, request }) {
    const memory = new Map();
    let running = null;
    function queued() {
      const rows = new Map(memory);
      try {
        for (let index = 0; index < global.localStorage.length; index++) {
          const key = global.localStorage.key(index);
          if (!key?.startsWith(prefix)) continue;
          try { rows.set(key, JSON.parse(global.localStorage.getItem(key))); }
          catch { /* A damaged entry must not prevent other reports from uploading. */ }
        }
      } catch { /* Device storage can be unavailable; keep in-memory evidence. */ }
      return rows;
    }
    async function deliver() {
      if (global.navigator.onLine === false) return;
      for (const [key, entry] of queued()) {
        if (!entry?.actorId || entry.actorId !== actorId()) continue;
        try {
          const result = await request(entry.failure);
          if (result?.ok !== true || result.failureId !== entry.failure.failureId) continue;
          memory.delete(key);
          try { global.localStorage.removeItem(key); } catch { /* Re-delivery is idempotent. */ }
        } catch { /* Retain the report until connectivity and this account return. */ }
      }
    }
    function flush() {
      if (!running) running = deliver().finally(() => { running = null; });
      return running;
    }
    function report(input) {
      try {
        const account = input.actorOperatorId || actorId();
        const error = input.error;
        const failure = { failureId: global.crypto.randomUUID(), occurredAt: new Date().toISOString(),
          locationId: input.locationId ?? locationId(), functionKey: input.functionKey || 'operator', stage: input.stage || 'client',
          errorMessage: safe(error?.message || error || 'NetSuite operation failed.'),
          errorCode: safe(error?.code || error?.payload?.code || 'CLIENT_ERROR', 160), errorName: safe(error?.name || 'Error', 80),
          stack: safe(error?.stack || ''), browserOnline: global.navigator.onLine !== false, clientVersion: '20261030-netsuite-errors-v1' };
        for (const key of ['requestId', 'orderId', 'orderRef', 'orderType']) failure[key] = safe(input[key] || '', 180);
        if (Number.isInteger(error?.status)) failure.httpStatus = error.status;
        const key = prefix + failure.failureId, entry = { actorId: account, failure };
        memory.set(key, entry);
        try { global.localStorage.setItem(key, JSON.stringify(entry)); }
        catch { global.console.error('NetSuite error could not be saved on this device; reporting immediately.', failure); }
        void flush();
        return failure.failureId;
      } catch (error) { global.console.error('NetSuite client error reporting failed.', safe(error?.message)); return null; }
    }
    const resume = () => { void flush(); };
    const timer = global.setInterval(resume, 15000);
    for (const event of ['online', 'focus', 'storage']) global.addEventListener(event, resume);
    function stop() {
      global.clearInterval(timer);
      for (const event of ['online', 'focus', 'storage']) global.removeEventListener(event, resume);
    }
    return { report, flush, stop };
  }
  global.OperatorNetSuiteFailures = { create };
})(window);
