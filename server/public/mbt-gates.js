const token = localStorage.getItem("mbbs.staff.token")
  || localStorage.getItem("mbbs.control.token")
  || "";
const statusRegion = document.querySelector(".mbt-status");
const gateList = document.getElementById("gateList");
const reasonInput = document.getElementById("gateReason");
const refreshButton = document.getElementById("refreshGates");

let inventory = null;
let saving = false;

function normalizedRoles(operator) {
  return new Set([...(Array.isArray(operator?.roles) ? operator.roles : []), operator?.role]
    .map((role) => String(role || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_"))
    .filter(Boolean));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    cache: "no-store",
    headers: {
      accept: "application/json",
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || "The MBT gate request failed.");
    error.status = response.status;
    error.code = payload.code || "";
    throw error;
  }
  return payload;
}

function replaceStatus(title, lines, tone = "safe", busy = false) {
  if (!statusRegion) return;
  statusRegion.replaceChildren();
  statusRegion.dataset.tone = tone;
  statusRegion.setAttribute("aria-busy", String(busy));
  const heading = document.createElement("h2");
  heading.textContent = title;
  statusRegion.append(heading);
  for (const line of lines) {
    const paragraph = document.createElement("p");
    paragraph.textContent = line;
    statusRegion.append(paragraph);
  }
}

function badge(label, state) {
  const element = document.createElement("span");
  element.className = "mbt-gate-badge";
  element.dataset.state = state;
  element.textContent = label;
  return element;
}

function gateArticle(gate) {
  const article = document.createElement("article");
  article.className = "mbt-gate-card";
  article.dataset.flagKey = gate.flagKey;

  const copy = document.createElement("div");
  copy.className = "mbt-gate-copy";
  const title = document.createElement("h3");
  title.textContent = gate.label;
  const key = document.createElement("code");
  key.textContent = gate.flagKey;
  const description = document.createElement("p");
  description.textContent = gate.description;
  copy.append(title, key, description);

  const states = document.createElement("div");
  states.className = "mbt-gate-states";
  states.append(
    badge(gate.configured ? "Configured on" : "Configured off", gate.configured ? "on" : "off"),
    gate.independent
      ? badge("Admin controlled", "open")
      : badge(gate.environmentAllowed ? "Deployment open" : "Deployment closed", gate.environmentAllowed ? "open" : "closed"),
    badge(gate.effective ? "Effective" : "Inactive", gate.effective ? "effective" : "inactive")
  );

  const action = document.createElement("div");
  action.className = "mbt-gate-action";
  if (gate.locked) {
    action.append(badge("Locked", "locked"));
    const reason = document.createElement("p");
    reason.textContent = gate.lockReason || "This gate is deployment-controlled.";
    action.append(reason);
  } else {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.gateToggle = gate.flagKey;
    button.dataset.expectedRevision = String(gate.revision);
    button.dataset.nextEnabled = String(!gate.configured);
    button.textContent = gate.configured ? "Turn off" : "Turn on";
    button.setAttribute("aria-label", `${gate.configured ? "Turn off" : "Turn on"} ${gate.label}`);
    button.disabled = saving;
    action.append(button);
  }

  article.append(copy, states, action);
  return article;
}

function renderGates() {
  if (!gateList || !inventory) return;
  gateList.replaceChildren(...inventory.gates.map(gateArticle));
}

function commandKey(flagKey) {
  const nonce = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `mbt-admin-gate-${flagKey}-${nonce}`;
}

async function loadGates(message = "Gate controls ready") {
  inventory = await api("/api/mbt/config/gates");
  renderGates();
  const effective = inventory.gates.filter((gate) => gate.effective).length;
  const configured = inventory.gates.filter((gate) => gate.configured).length;
  replaceStatus(message, [
    `${configured} Admin gates are configured on; ${effective} are currently effective.`,
    inventory.environmentRootAllowed
      ? "The MBT deployment ceiling is open for approved local capabilities."
      : "The MBT deployment ceiling is closed, so every database gate remains inactive."
  ]);
}

async function updateGate(button) {
  const flagKey = String(button.dataset.gateToggle || "");
  const selected = inventory?.gates?.find((gate) => gate.flagKey === flagKey);
  if (!selected || selected.locked || saving) return;
  const reason = String(reasonInput?.value || "").trim();
  if (!reason) {
    replaceStatus("Audit reason required", ["Enter why this gate is changing, then try again."], "attention");
    reasonInput?.focus();
    return;
  }
  saving = true;
  renderGates();
  replaceStatus("Saving gate change", [
    `${selected.label} is being changed to ${selected.configured ? "off" : "on"}. Please wait.`
  ], "safe", true);
  try {
    await api(`/api/mbt/config/gates/${encodeURIComponent(flagKey)}`, {
      method: "PUT",
      headers: { "idempotency-key": commandKey(flagKey) },
      body: JSON.stringify({
        enabled: !selected.configured,
        expectedRevision: selected.revision,
        reason
      })
    });
    await loadGates(`${selected.label} is now configured ${selected.configured ? "off" : "on"}`);
  } catch (error) {
    if (error.status === 401) {
      location.replace("/");
      return;
    }
    const failureMessage = error.code === "MBT_STALE_REVISION"
      ? "Another Admin changed this gate. The latest state is shown below; review it before trying again."
      : error.message;
    inventory = await api("/api/mbt/config/gates").catch(() => inventory);
    renderGates();
    replaceStatus("Gate change not saved", [failureMessage], "attention");
  } finally {
    saving = false;
    renderGates();
  }
}

async function load() {
  if (!token) {
    location.replace("/");
    return;
  }
  try {
    const { operator } = await api("/api/auth/me");
    if (!normalizedRoles(operator).has("admin")) {
      location.replace(operator?.homeRoute || "/");
      return;
    }
    await loadGates();
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      location.replace("/");
      return;
    }
    replaceStatus("Gate controls unavailable", [error.message], "attention");
  }
}

gateList?.addEventListener("click", (event) => {
  const button = event.target.closest?.("[data-gate-toggle]");
  if (button) updateGate(button);
});

refreshButton?.addEventListener("click", async () => {
  if (saving) return;
  replaceStatus("Refreshing gate controls", ["Loading the latest server-owned revisions."], "safe", true);
  await loadGates().catch((error) => {
    replaceStatus("Refresh failed", [error.message], "attention");
  });
});

load();
