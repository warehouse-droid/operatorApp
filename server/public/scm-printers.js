const yardPrinterApp = document.getElementById("yardPrinterApp");

const printerState = {
  operator: null,
  printers: [],
  jobs: [],
  busy: "",
  notice: "",
  error: "",
  revealed: null
};

function printerEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function printerDate(value) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function printerRoles() {
  return new Set([
    ...(Array.isArray(printerState.operator?.roles) ? printerState.operator.roles : []),
    printerState.operator?.role
  ].map((role) => String(role || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_")).filter(Boolean));
}

function printerCanWrite() {
  const roles = printerRoles();
  return roles.has("admin");
}

function printerPill(status) {
  const clean = String(status || "unknown").toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  return `<span class="smart-pill ${clean}">${printerEscape(String(status || "unknown").replaceAll("_", " "))}</span>`;
}

async function printerApi(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && typeof options.body === "object") {
    headers["Content-Type"] = "application/json";
    options = { ...options, body: JSON.stringify(options.body) };
  }
  const response = await fetch(url, { ...options, headers });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status})`);
  return payload;
}

async function printerLoad({ quiet = false } = {}) {
  if (!quiet) {
    printerState.busy = "Loading printer queues";
    printerRender();
  }
  const [printers, jobs] = await Promise.all([
    printerApi("/api/scm/smart/printers"),
    printerApi("/api/scm/smart/print-jobs?limit=100")
  ]);
  printerState.printers = printers;
  printerState.jobs = jobs;
  printerState.busy = "";
  printerRender();
}

function printerHeader() {
  return `<header class="dispatch-topbar">
    <div class="smart-brand"><div class="smart-brand-mark">PR</div><div><p>Administration</p><h1>Yard Printer Setup</h1></div></div>
    <span class="smart-mode">Source-yard routing</span>
    <div class="topbar-actions"><span class="dispatch-user">${printerEscape(printerState.operator?.display_name || printerState.operator?.username || "")}</span><button type="button" onclick="location.href='/admin'">Admin</button><button type="button" onclick="dispatchLogout()">Logout</button></div>
  </header>`;
}

function printerTokenPanel() {
  const revealed = printerState.revealed;
  if (!revealed) return "";
  const command = `powershell -ExecutionPolicy Bypass -File .\\Install-MBBSYardPrinterAgent.ps1 -ServerUrl \"${window.location.origin}\" -AgentId \"${revealed.printer.agentId}\" -Token \"${revealed.token}\"`;
  return `<section class="printer-token-panel">
    <h3>Save the ${printerEscape(revealed.printer.yardCode)} agent token now</h3>
    <p>This secret is shown once. Rotating it immediately invalidates the previous yard agent.</p>
    <div class="printer-secret"><code id="printerTokenValue">${printerEscape(revealed.token)}</code><button class="smart-button" data-printer-action="copy-token" type="button">Copy token</button></div>
    <div class="printer-secret"><code id="printerInstallCommand">${printerEscape(command)}</code><button class="smart-button" data-printer-action="copy-command" type="button">Copy setup command</button></div>
    <div class="smart-actions" style="margin-top:10px"><a class="smart-button blue" href="/tools/Install-MBBSYardPrinterAgent.ps1" download>Download Windows agent</a><button class="smart-button" data-printer-action="close-token" type="button">I saved it</button></div>
  </section>`;
}

function printerCard(printer) {
  const configured = printer.enabled && printer.hasToken && printer.printerName;
  return `<article class="printer-card" data-printer-location="${printer.locationId}">
    <div class="printer-yard"><strong>${printerEscape(printer.yardCode)}</strong><span>Location ${printer.locationId}</span></div>
    <div class="printer-config">
      <div class="printer-meta"><span>Agent <strong>${printerEscape(printer.agentId)}</strong></span>${printerPill(printer.status)}</div>
      <label class="smart-field"><span>Windows printer name</span><input data-printer-name value="${printerEscape(printer.printerName || "")}" placeholder="Exact name from Get-Printer" ${printerCanWrite() ? "" : "disabled"} /></label>
      <label class="smart-check"><input data-printer-enabled type="checkbox" ${printer.enabled ? "checked" : ""} ${printerCanWrite() ? "" : "disabled"} /> Enable this yard print queue</label>
      <div class="printer-meta"><span>${printer.hasToken ? "Agent token configured" : "Generate an agent token"}</span><span>Last seen: ${printerDate(printer.lastSeenAt)}</span></div>
      ${printer.lastError ? `<div class="smart-notice error">${printerEscape(printer.lastError)}</div>` : ""}
      ${printerCanWrite() ? `<div class="smart-actions"><button class="smart-button primary" data-printer-action="save" type="button">Save</button><button class="smart-button" data-printer-action="rotate-token" type="button">${printer.hasToken ? "Rotate" : "Generate"} token</button><button class="smart-button ${configured ? "blue" : ""}" data-printer-action="test" type="button" ${configured ? "" : "disabled"}>Queue test page</button></div>` : ""}
    </div>
  </article>`;
}

function printerJobs() {
  return `<section class="smart-section">
    <div class="smart-section-head"><div><h2>Print queue</h2><p>Jobs are leased once. If an agent disconnects after printing starts, the result becomes uncertain and requires a human check before retry.</p></div><button class="smart-button" data-printer-action="refresh" type="button">Refresh</button></div>
    <div class="smart-table-wrap"><table class="smart-table"><thead><tr><th>Job</th><th>Yard</th><th>Printer</th><th>Document</th><th>Status</th><th>Attempts</th><th>Queued / printed</th><th>Error</th><th></th></tr></thead><tbody>
      ${printerState.jobs.map((job) => `<tr><td>#${job.id}<div class="smart-help">${printerEscape(job.jobKey)}</div></td><td>${printerEscape(job.yardCode)}</td><td>${printerEscape(job.printerName || "—")}</td><td>${printerEscape(job.documentName)}<div class="smart-help">${printerEscape(job.documentType.replaceAll("_", " "))}</div></td><td>${printerPill(job.status)}</td><td>${job.attempts}</td><td>${printerDate(job.queuedAt)}<div class="smart-help">${job.printedAt ? `Printed ${printerDate(job.printedAt)}` : "Not confirmed printed"}</div></td><td>${printerEscape(job.lastError || "—")}</td><td>${printerCanWrite() && ["failed", "uncertain"].includes(job.status) ? `<button class="smart-button warn" data-printer-action="retry" data-job-id="${job.id}" type="button">Verify + requeue</button>` : ""}</td></tr>`).join("") || `<tr><td colspan="9" class="smart-empty">No Smart SCM print jobs.</td></tr>`}
    </tbody></table></div>
  </section>`;
}

function printerRender() {
  yardPrinterApp.innerHTML = `${printerHeader()}<div class="smart-main">${printerState.error ? `<div class="smart-notice error">${printerEscape(printerState.error)}</div>` : ""}${printerState.notice ? `<div class="smart-notice">${printerEscape(printerState.notice)}</div>` : ""}${printerState.busy ? `<div class="smart-notice">${printerEscape(printerState.busy)}…</div>` : ""}${printerTokenPanel()}<section class="smart-section"><div class="smart-section-head"><div><h2>Four independent yard queues</h2><p>Use the exact Windows printer name installed on each yard PC. A queue must be enabled, tokenized, and healthy before Smart SCM can confirm a TO from that source yard.</p></div></div><div class="smart-section-body printer-grid">${printerState.printers.map(printerCard).join("") || `<div class="smart-empty">Run Smart SCM migration 039 to create yard printer records.</div>`}</div></section>${printerJobs()}</div>`;
}

async function printerWork(label, task, success = "Saved") {
  printerState.busy = label;
  printerState.error = "";
  printerState.notice = "";
  printerRender();
  try {
    const result = await task();
    printerState.notice = success;
    return result;
  } catch (error) {
    printerState.error = error.message;
    throw error;
  } finally {
    printerState.busy = "";
    printerRender();
  }
}

yardPrinterApp.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-printer-action]");
  if (!button || printerState.busy) return;
  const action = button.dataset.printerAction;
  const card = button.closest("[data-printer-location]");
  const locationId = card?.dataset.printerLocation;
  try {
    if (action === "refresh") {
      await printerLoad();
    } else if (action === "save") {
      await printerWork("Saving printer setup", () => printerApi(`/api/scm/smart/printers/${locationId}`, { method: "PUT", body: { printerName: card.querySelector("[data-printer-name]").value, enabled: card.querySelector("[data-printer-enabled]").checked } }), "Yard printer setup saved");
      await printerLoad({ quiet: true });
    } else if (action === "rotate-token") {
      if (!confirm("Generate a new token? Any existing agent for this yard will stop polling until it is reconfigured.")) return;
      printerState.revealed = await printerWork("Generating one-time token", () => printerApi(`/api/scm/smart/printers/${locationId}/token`, { method: "POST", body: {} }), "Copy the new token before leaving this page");
      await printerLoad({ quiet: true });
    } else if (action === "test") {
      await printerWork("Queueing test page", () => printerApi(`/api/scm/smart/printers/${locationId}/test`, { method: "POST", body: {} }), "Test page queued");
      await printerLoad({ quiet: true });
    } else if (action === "retry") {
      if (!confirm("Confirm that the previous uncertain job did not print, then requeue it?")) return;
      await printerWork("Requeueing print job", () => printerApi(`/api/scm/smart/print-jobs/${button.dataset.jobId}/retry`, { method: "POST", body: {} }), "Print job requeued");
      await printerLoad({ quiet: true });
    } else if (action === "copy-token") {
      await navigator.clipboard.writeText(printerState.revealed?.token || "");
      printerState.notice = "Token copied";
      printerRender();
    } else if (action === "copy-command") {
      await navigator.clipboard.writeText(document.getElementById("printerInstallCommand")?.textContent || "");
      printerState.notice = "Setup command copied";
      printerRender();
    } else if (action === "close-token") {
      printerState.revealed = null;
      printerRender();
    }
  } catch (error) {
    printerState.busy = "";
    printerState.error = error.message;
    printerRender();
  }
});

window.addEventListener("mbbs-language-changed", printerRender);

requireDispatchLogin({
  mount: yardPrinterApp,
  roles: ["admin"],
  async onReady(operator) {
    printerState.operator = operator;
    printerRender();
    try {
      await printerLoad();
    } catch (error) {
      printerState.busy = "";
      printerState.error = error.message;
      printerRender();
    }
    setInterval(() => {
      if (document.visibilityState === "visible" && !document.querySelector(".printer-card input:focus")) {
        printerLoad({ quiet: true }).catch(() => null);
      }
    }, 15000);
  }
});
