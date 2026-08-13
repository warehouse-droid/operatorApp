const yardPrinterApp = document.getElementById("yardPrinterApp");
const printerAgentUpgradeCommand = String.raw`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\Downloads\Install-MBBSYardPrinterAgent.ps1"`;

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
  return window.MBBS_I18N?.displayDateTime?.(value) || String(value);
}

function printerDuration(value) {
  if (value === null || value === undefined || String(value).trim() === "") return "—";
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60000) return `${(milliseconds / 1000).toFixed(milliseconds < 10000 ? 2 : 1)} s`;
  return `${(milliseconds / 60000).toFixed(2)} min`;
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
    <p>This secret is shown once. Yard agent v3 prints to both configured Windows printers, applies input-bin routing, and reports detailed timing. Rotating the token immediately invalidates the previous agent.</p>
    <div class="printer-secret"><code id="printerTokenValue">${printerEscape(revealed.token)}</code><button class="smart-button" data-printer-action="copy-token" type="button">Copy token</button></div>
    <div class="printer-secret"><code id="printerInstallCommand">${printerEscape(command)}</code><button class="smart-button" data-printer-action="copy-command" type="button">Copy setup command</button></div>
    <div class="smart-actions" style="margin-top:10px"><a class="smart-button blue" href="/tools/Install-MBBSYardPrinterAgent.ps1" download>Download Windows agent</a><button class="smart-button" data-printer-action="close-token" type="button">I saved it</button></div>
  </section>`;
}

function printerDestinations(printer) {
  return [1, 2].map((slot) => (printer.printers || [])
    .find((destination) => Number(destination.slot) === slot) || {
      slot,
      printerName: slot === 1 ? printer.printerName || "" : "",
      inputBin: null,
      printTransferOrders: slot === 1 && Boolean(printer.printerName),
      printSalesOrders: slot === 1 && Boolean(printer.printerName)
    });
}

function printerDestinationEditor(printer, destination) {
  const needsV3 = destination.inputBin != null && Number(printer.agentVersion || 1) < 3;
  const canTest = printer.enabled && printer.hasToken && destination.printerName && !needsV3;
  return `<fieldset class="printer-destination" data-printer-slot="${destination.slot}">
    <legend>Printer ${destination.slot}</legend>
    <label class="smart-field"><span>Windows printer name</span><input data-printer-name value="${printerEscape(destination.printerName || "")}" placeholder="Exact name from Get-Printer" ${printerCanWrite() ? "" : "disabled"} /></label>
    <label class="smart-field"><span>Input bin (Windows RawKind)</span><input data-printer-bin type="number" min="1" max="65535" step="1" inputmode="numeric" value="${destination.inputBin ?? ""}" placeholder="Blank = queue default" ${printerCanWrite() ? "" : "disabled"} /><small class="smart-help">Use the value reported by this driver/queue; 256 is Tray 3 only for the verified 2967 setup. Blank uses the Windows queue default. A bin requires yard agent v3.</small></label>
    <div class="printer-route-options">
      <label class="smart-check"><input data-printer-to type="checkbox" ${destination.printTransferOrders ? "checked" : ""} ${printerCanWrite() ? "" : "disabled"} /> TO — one copy</label>
      <label class="smart-check"><input data-printer-so type="radio" name="so-printer-${printer.locationId}" ${destination.printSalesOrders ? "checked" : ""} ${printerCanWrite() ? "" : "disabled"} /> SO — one copy</label>
    </div>
    ${printerCanWrite() ? `<button class="smart-button ${canTest ? "blue" : ""}" data-printer-action="test" data-printer-slot="${destination.slot}" type="button" title="${needsV3 ? "Install yard agent v3 before testing an input bin." : "Tests use the last saved printer name and input bin."}" ${canTest ? "" : "disabled"}>Test Printer ${destination.slot}</button><div class="smart-help">${needsV3 ? "Blocked until this yard reports agent v3." : "Save routing before testing edited values."}</div>` : ""}
  </fieldset>`;
}

function printerCard(printer) {
  const destinations = printerDestinations(printer);
  const toCount = destinations.filter((destination) => destination.printerName && destination.printTransferOrders).length;
  const soCount = destinations.filter((destination) => destination.printerName && destination.printSalesOrders).length;
  const requiresAgentUpgrade = destinations.some((destination) => destination.inputBin != null) && Number(printer.agentVersion || 1) < 3;
  return `<article class="printer-card" data-printer-location="${printer.locationId}">
    <div class="printer-yard"><strong>${printerEscape(printer.yardCode)}</strong><span>Location ${printer.locationId}</span></div>
    <div class="printer-config">
      <div class="printer-meta"><span>Agent <strong>${printerEscape(printer.agentId)}</strong> · protocol v${Number(printer.agentVersion || 1)}</span>${printerPill(printer.status)}</div>
      <div class="printer-destinations">${destinations.map((destination) => printerDestinationEditor(printer, destination)).join("")}</div>
      <div class="printer-route-summary">
        <span class="${toCount === 2 ? "ready" : "incomplete"}">TO: ${toCount}/2 printers</span>
        <span class="${soCount === 1 ? "ready" : "incomplete"}">SO: ${soCount}/1 printer</span>
      </div>
      <label class="printer-no-so"><input data-printer-so-none type="radio" name="so-printer-${printer.locationId}" ${soCount === 0 ? "checked" : ""} ${printerCanWrite() ? "" : "disabled"} /> No SO printer assigned</label>
      <label class="smart-check"><input data-printer-enabled type="checkbox" ${printer.enabled ? "checked" : ""} ${printerCanWrite() ? "" : "disabled"} /> Enable this yard print queue</label>
      <div class="printer-meta"><span>${printer.hasToken ? "Agent token configured" : "Generate an agent token"}</span><span>Last seen: ${printerDate(printer.lastSeenAt)}</span></div>
      ${requiresAgentUpgrade ? `<div class="smart-notice error">Input-bin jobs are fail-safe blocked at the head of this yard queue until agent v3 is installed.</div>` : ""}
      ${printer.lastError ? `<div class="smart-notice error">${printerEscape(printer.lastError)}</div>` : ""}
      ${printerCanWrite() ? `<div class="smart-actions"><button class="smart-button primary" data-printer-action="save" type="button">Save routing</button><button class="smart-button" data-printer-action="rotate-token" type="button">${printer.hasToken ? "Rotate" : "Generate"} token</button></div>` : ""}
    </div>
  </article>`;
}

function printerJobs() {
  const jobPrinterText = (job) => {
    const targets = Array.isArray(job.printerTargets) && job.printerTargets.length
      ? job.printerTargets
      : (job.printerNames || []).map((printerName) => ({ printerName, inputBin: null }));
    return targets.map((target) => `${target.printerName}${target.inputBin == null ? "" : ` [bin ${target.inputBin}]`}`).join(" + ");
  };
  const jobTiming = (job) => {
    const diagnostics = job.agentDiagnostics || {};
    const millisecondsBetween = (end, start) => {
      const endTime = new Date(end || "").getTime();
      const startTime = new Date(start || "").getTime();
      return Number.isFinite(endTime) && Number.isFinite(startTime) ? Math.max(0, endTime - startTime) : null;
    };
    const serverQueueMs = millisecondsBetween(job.startedAt, job.queuedAt);
    const serverPrintingMs = millisecondsBetween(job.printedAt, job.startedAt);
    const serverTiming = `Server queue ${printerDuration(serverQueueMs)} · printing ${printerDuration(serverPrintingMs)}`;
    const hasDetailedTiming = diagnostics.receivedAt
      || [diagnostics.queueWaitMs, diagnostics.downloadMs, diagnostics.processingMs, diagnostics.totalMs]
        .some((value) => Number.isFinite(Number(value)));
    if (!hasDetailedTiming) return `${serverTiming}<div class="smart-help">No v3 agent detail</div>`;
    const targets = Array.isArray(diagnostics.targets) ? diagnostics.targets : [];
    const targetTiming = targets
      .filter((target) => target && typeof target === "object" && !Array.isArray(target))
      .map((target) => `${target.printerName || "printer"}: ${printerDuration(target.waitMs ?? target.totalMs)}`)
      .join(" · ");
    return `${diagnostics.receivedAt ? `Received ${printerEscape(printerDate(diagnostics.receivedAt))}` : "Receive time unavailable"}
      <div class="smart-help">Queue ${printerDuration(diagnostics.queueWaitMs)} · download ${printerDuration(diagnostics.downloadMs)} · process ${printerDuration(diagnostics.processingMs ?? diagnostics.totalMs)}</div>
      <div class="smart-help">${serverTiming}</div>
      ${targetTiming ? `<div class="smart-help">${printerEscape(targetTiming)}</div>` : ""}`;
  };
  return `<section class="smart-section">
    <div class="smart-section-head"><div><h2>Print queue</h2><p>Jobs are leased once. If an agent disconnects after printing starts, the result becomes uncertain and requires a human check before retry.</p></div><button class="smart-button" data-printer-action="refresh" type="button">Refresh</button></div>
    <div class="smart-table-wrap"><table class="smart-table"><thead><tr><th>Job</th><th>Yard</th><th>Printer / bin</th><th>Document</th><th>Status</th><th>Attempts</th><th>Queued / printed</th><th>Agent timing</th><th>Error</th><th></th></tr></thead><tbody>
      ${printerState.jobs.map((job) => `<tr><td>#${job.id}<div class="smart-help">${printerEscape(job.jobKey)}</div></td><td>${printerEscape(job.yardCode)}</td><td>${printerEscape(jobPrinterText(job) || job.printerName || "—")}</td><td>${printerEscape(job.documentName)}<div class="smart-help">${printerEscape(job.documentType.replaceAll("_", " "))}</div></td><td>${printerPill(job.status)}</td><td>${job.attempts}</td><td>${printerDate(job.queuedAt)}<div class="smart-help">${job.printedAt ? `Printed ${printerDate(job.printedAt)}` : "Not confirmed printed"}</div></td><td>${jobTiming(job)}</td><td>${printerEscape(job.lastError || "—")}</td><td>${printerCanWrite() && ["failed", "uncertain"].includes(job.status) ? `<button class="smart-button warn" data-printer-action="retry" data-job-id="${job.id}" type="button">Verify + requeue</button>` : ""}</td></tr>`).join("") || `<tr><td colspan="10" class="smart-empty">No Smart SCM print jobs.</td></tr>`}
    </tbody></table></div>
  </section>`;
}

function printerRender() {
  yardPrinterApp.innerHTML = `${printerHeader()}<div class="smart-main">${printerState.error ? `<div class="smart-notice error">${printerEscape(printerState.error)}</div>` : ""}${printerState.notice ? `<div class="smart-notice">${printerEscape(printerState.notice)}</div>` : ""}${printerState.busy ? `<div class="smart-notice">${printerEscape(printerState.busy)}…</div>` : ""}${printerTokenPanel()}<section class="smart-section">
    <div class="smart-section-head">
      <div><h2>Windows yard agent v3</h2><p>Existing agent PC: download the script, open PowerShell as Administrator, then paste the command below. It preserves the existing token and settings and restarts as v3.</p></div>
      <a class="smart-button blue" href="/tools/Install-MBBSYardPrinterAgent.ps1" download>Download agent v3</a>
    </div>
    <div class="smart-section-body">
      <div class="printer-secret"><code id="printerAgentUpgradeCommand">${printerEscape(printerAgentUpgradeCommand)}</code><button class="smart-button" data-printer-action="copy-upgrade-command" type="button">Copy command</button></div>
    </div>
  </section><section class="smart-section"><div class="smart-section-head"><div><h2>Two printers per yard</h2><p>Assign both named printers to TO for two copies. Assign exactly one named printer to SO for one copy. Input bins are sent explicitly by yard agent v3, so multiple queues on the same physical printer can select different trays.</p></div></div><div class="smart-section-body printer-grid">${printerState.printers.map(printerCard).join("") || `<div class="smart-empty">Run the Smart SCM migrations to create yard printer records.</div>`}</div></section>${printerJobs()}</div>`;
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
      const printers = [...card.querySelectorAll(".printer-destination[data-printer-slot]")].map((destination) => ({
        slot: Number(destination.dataset.printerSlot),
        printerName: destination.querySelector("[data-printer-name]").value,
        inputBin: destination.querySelector("[data-printer-bin]").value.trim() === ""
          ? null
          : Number(destination.querySelector("[data-printer-bin]").value),
        printTransferOrders: destination.querySelector("[data-printer-to]").checked,
        printSalesOrders: destination.querySelector("[data-printer-so]").checked
      }));
      await printerWork("Saving printer routing", () => printerApi(`/api/scm/smart/printers/${locationId}`, {
        method: "PUT",
        body: {
          printers,
          enabled: card.querySelector("[data-printer-enabled]").checked
        }
      }), "Yard printer routing saved");
      await printerLoad({ quiet: true });
    } else if (action === "rotate-token") {
      if (!confirm("Generate a new token? Any existing agent for this yard will stop polling until it is reconfigured.")) return;
      printerState.revealed = await printerWork("Generating one-time token", () => printerApi(`/api/scm/smart/printers/${locationId}/token`, { method: "POST", body: {} }), "Copy the new token before leaving this page");
      await printerLoad({ quiet: true });
    } else if (action === "test") {
      const printerSlot = Number(button.dataset.printerSlot);
      await printerWork(`Queueing Printer ${printerSlot} test`, () => printerApi(`/api/scm/smart/printers/${locationId}/test`, { method: "POST", body: { printerSlot } }), `Printer ${printerSlot} test page queued`);
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
    } else if (action === "copy-upgrade-command") {
      await navigator.clipboard.writeText(printerAgentUpgradeCommand);
      printerState.notice = "Agent v3 upgrade command copied";
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

yardPrinterApp.addEventListener("input", (event) => {
  if (!event.target.matches("[data-printer-name], [data-printer-bin], [data-printer-to], [data-printer-so], [data-printer-so-none], [data-printer-enabled]")) return;
  const card = event.target.closest("[data-printer-location]");
  if (!card) return;
  card.querySelectorAll('[data-printer-action="test"]').forEach((button) => {
    button.disabled = true;
    button.classList.remove("blue");
    button.title = "Save routing before testing edited values.";
  });
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
