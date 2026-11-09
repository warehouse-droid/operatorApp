// Reports browser errors on staff pages to the Admin audit log (POST /api/client-errors):
// uncaught exceptions, unhandled promise rejections and scripts/styles that fail to load.
(function () {
  if (window.__mbbsClientErrorReporter) return;
  window.__mbbsClientErrorReporter = true;

  const ENDPOINT = "/api/client-errors";
  const MAX_REPORTS_PER_PAGE = 15;
  const TOKEN_KEYS = ["mbbs.staff.token", "mbbs.control.token", "mbbs.operator.token", "mbbs.dispatch.token", "mbbs.sales.token"];
  const seen = new Set();
  let sent = 0;

  function token() {
    try {
      for (const key of TOKEN_KEYS) {
        const value = localStorage.getItem(key);
        if (value) return value;
      }
    } catch {
      // Storage can be unavailable (private mode); report anonymously.
    }
    return "";
  }

  function text(value, max) {
    return String(value == null ? "" : value).slice(0, max);
  }

  function send(report) {
    const key = `${report.kind}|${report.message}|${report.source || ""}|${report.line || ""}`;
    if (seen.has(key) || sent >= MAX_REPORTS_PER_PAGE) return;
    seen.add(key);
    sent += 1;
    const body = JSON.stringify({
      kind: report.kind,
      message: text(report.message, 2000),
      source: text(report.source, 300),
      line: report.line || null,
      column: report.column || null,
      stack: text(report.stack, 4000),
      page: window.location.pathname,
      online: navigator.onLine,
      clientTime: new Date().toISOString()
    });
    const authToken = token();
    try {
      fetch(ENDPOINT, {
        method: "POST",
        keepalive: true,
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
        body
      }).catch(() => {});
    } catch {
      // Never let error reporting raise another error.
    }
  }

  window.addEventListener("error", (event) => {
    const target = event.target;
    if (target && target !== window && (target.tagName === "SCRIPT" || target.tagName === "LINK")) {
      const url = target.src || target.href || "";
      send({ kind: "resource", message: `Failed to load ${target.tagName.toLowerCase()} ${url.split("?")[0]}`, source: url });
      return;
    }
    if (target && target !== window) return; // images and media report their own failures in the UI
    send({
      kind: "error",
      message: event.message || "Script error",
      source: event.filename,
      line: event.lineno,
      column: event.colno,
      stack: event.error && event.error.stack
    });
  }, true);

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    const message = reason && reason.message ? reason.message : text(reason, 2000) || "Unhandled promise rejection";
    // Network drops and expired logins are not code defects (failed API calls are audited server-side).
    if (/^(Login required|Failed to fetch|NetworkError|Load failed)/i.test(message)) return;
    send({ kind: "unhandledrejection", message, stack: reason && reason.stack });
  });
})();
