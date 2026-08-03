const smartPlanningExclusionState = {
  open: false,
  search: "",
  reason: "Vendor out of stock",
  expiresAt: "",
  candidates: [],
  searching: false,
  error: ""
};

let smartPlanningExclusionSearchTimer = null;
let smartPlanningExclusionSearchRequest = 0;

function smartPlanningExclusionPayload() {
  const payload = smartState.data?.planningExclusions;
  if (Array.isArray(payload)) return { items: payload, activeCount: payload.length };
  if (payload && Array.isArray(payload.items)) return payload;
  return { items: [], activeCount: 0 };
}

function smartActivePlanningExclusions() {
  return smartPlanningExclusionPayload().items.filter((entry) => entry.active !== false);
}

function smartAutomaticBlanketPlanningPauses() {
  const payload = smartPlanningExclusionPayload();
  return Array.isArray(payload.blanketItems)
    ? payload.blanketItems.filter((entry) => entry.active !== false)
    : [];
}

function smartPausedPlanningItemIds() {
  return new Set([
    ...smartActivePlanningExclusions(),
    ...smartAutomaticBlanketPlanningPauses()
  ].map((entry) => Number(entry.itemId)).filter(Number.isInteger));
}

function smartPlanningExclusionCount() {
  const payload = smartPlanningExclusionPayload();
  if (Number.isFinite(Number(payload.combinedActiveCount))) return Number(payload.combinedActiveCount);
  return smartPausedPlanningItemIds().size;
}

function smartPlanningExclusionCandidateRows() {
  const exclusions = new Set(smartActivePlanningExclusions().map((entry) => Number(entry.itemId)));
  const blanketItems = new Set(smartAutomaticBlanketPlanningPauses().map((entry) => Number(entry.itemId)));
  if (smartPlanningExclusionState.searching) {
    return `<div class="smart-help">Searching Item Master…</div>`;
  }
  if (smartPlanningExclusionState.error) {
    return `<div class="smart-notice error">${smartEscape(smartPlanningExclusionState.error)}</div>`;
  }
  if (!smartPlanningExclusionState.search.trim()) {
    return `<div class="smart-help">Search by item ID, name, or description.</div>`;
  }
  if (!smartPlanningExclusionState.candidates.length) {
    return `<div class="smart-empty smart-empty-compact">No planning-enabled item matches.</div>`;
  }
  return smartPlanningExclusionState.candidates.map((item) => {
    const excluded = exclusions.has(Number(item.itemId));
    const blanketCovered = blanketItems.has(Number(item.itemId));
    return `<div class="smart-planning-exclusion-candidate">
      <div><strong>${smartEscape(item.itemName || item.itemId)}</strong><span>ID ${smartEscape(item.itemId)}${item.vendor ? ` · ${smartEscape(item.vendor)}` : ""}</span></div>
      <button class="smart-button ${excluded ? "" : "warn"}" data-smart-action="add-planning-exclusion" data-item-id="${smartEscape(item.itemId)}" type="button" ${excluded || !smartCanWrite() ? "disabled" : ""}>${excluded ? "Already paused for PO" : blanketCovered ? "Add manual PO pause" : "Pause vendor PO"}</button>
    </div>`;
  }).join("");
}

function smartManualPlanningExclusionRows() {
  const exclusions = smartActivePlanningExclusions();
  if (!exclusions.length) {
    return `<div class="smart-empty smart-empty-compact">No items are manually paused.</div>`;
  }
  return exclusions.map((entry) => `<div class="smart-planning-exclusion-row">
    <div class="smart-planning-exclusion-item"><strong>${smartEscape(entry.itemName || entry.itemId)}</strong><span>ID ${smartEscape(entry.itemId)}${entry.vendor ? ` · ${smartEscape(entry.vendor)}` : ""}</span></div>
    <div><strong>${smartEscape(entry.reason || "Temporarily paused")}</strong><span>${entry.expiresOn ? `Through ${smartEscape(entry.expiresOn)}` : entry.expiresAt ? `Until ${smartDate(entry.expiresAt, true)}` : "Until manually resumed"}</span></div>
    <div><span>Added ${smartDate(entry.createdAt, true)}</span></div>
    ${smartCanWrite() ? `<button class="smart-button" data-smart-action="remove-planning-exclusion" data-exclusion-id="${smartEscape(entry.id)}" data-item-name="${smartEscape(entry.itemName || entry.itemId)}" type="button">Resume planning</button>` : ""}
  </div>`).join("");
}

function smartBlanketPlanningPauseRows() {
  const items = smartAutomaticBlanketPlanningPauses();
  if (!items.length) {
    return `<div class="smart-empty smart-empty-compact">No item currently has usable Blanket PO balance.</div>`;
  }
  return items.map((entry) => {
    const refs = Array.isArray(entry.sourcePoRefs) ? entry.sourcePoRefs.filter(Boolean) : [];
    return `<div class="smart-planning-exclusion-row smart-planning-exclusion-row-automatic">
      <div class="smart-planning-exclusion-item"><strong>${smartEscape(entry.itemName || entry.itemId)}</strong><span>ID ${smartEscape(entry.itemId)}${entry.vendor ? ` · ${smartEscape(entry.vendor)}` : ""}</span></div>
      <div><strong>Blanket PO covered · ${smartNumber(entry.availablePallets, 2)} PLT remaining</strong><span>${refs.length ? `Source ${smartEscape(refs.join(", "))}` : "Open Blanket source"}</span></div>
      <div><span>Vendor PO planning paused</span><strong class="smart-planning-exclusion-to-note">TO remains available</strong></div>
      <button class="smart-button" data-smart-action="open-blanket-orders" type="button">View Blanket order</button>
    </div>`;
  }).join("");
}

function smartPlanningExclusionPanel() {
  if (!smartPlanningExclusionState.open) return "";
  return `<section class="smart-planning-exclusions" aria-label="PO planning pauses">
    <div class="smart-planning-exclusion-head">
      <div><h3>PO planning pauses</h3><p>Manual pauses exclude an item only from new vendor PO planning. Generated and manually added TO loads remain available. Blanket-covered items also pause new vendor POs while usable blanket quantity remains.</p></div>
      <button class="smart-button" data-smart-action="toggle-planning-exclusions" type="button">Close</button>
    </div>
    ${smartCanWrite() ? `<div class="smart-planning-exclusion-form">
      <label><span>Find item</span><input id="smartPlanningExclusionSearch" type="search" value="${smartEscape(smartPlanningExclusionState.search)}" placeholder="Item ID, name, or description" autocomplete="off" /></label>
      <label><span>Reason</span><input id="smartPlanningExclusionReason" value="${smartEscape(smartPlanningExclusionState.reason)}" maxlength="240" /></label>
      <label><span>Until (optional)</span><input id="smartPlanningExclusionExpiry" type="date" value="${smartEscape(smartPlanningExclusionState.expiresAt)}" /></label>
    </div>
    <div class="smart-planning-exclusion-candidates" data-smart-planning-exclusion-candidates>${smartPlanningExclusionCandidateRows()}</div>` : ""}
    <div class="smart-planning-exclusion-group"><div class="smart-planning-exclusion-group-head"><strong>Automatic — Blanket balance</strong><span>${smartAutomaticBlanketPlanningPauses().length} item(s)</span></div><div class="smart-planning-exclusion-list">${smartBlanketPlanningPauseRows()}</div></div>
    <div class="smart-planning-exclusion-group"><div class="smart-planning-exclusion-group-head"><strong>Manual temporary pauses</strong><span>${smartActivePlanningExclusions().length} item(s)</span></div><div class="smart-planning-exclusion-list">${smartManualPlanningExclusionRows()}</div></div>
  </section>`;
}

async function smartSearchPlanningExclusionItems() {
  const requestId = ++smartPlanningExclusionSearchRequest;
  const search = smartPlanningExclusionState.search.trim();
  const target = document.querySelector("[data-smart-planning-exclusion-candidates]");
  if (!search) {
    smartPlanningExclusionState.candidates = [];
    smartPlanningExclusionState.searching = false;
    smartPlanningExclusionState.error = "";
    if (target) target.innerHTML = smartPlanningExclusionCandidateRows();
    return;
  }
  smartPlanningExclusionState.searching = true;
  smartPlanningExclusionState.error = "";
  if (target) target.innerHTML = smartPlanningExclusionCandidateRows();
  try {
    const params = new URLSearchParams({ search, enabled: "true", limit: "20", offset: "0" });
    const result = await smartApi(`/api/scm/smart/items?${params}`);
    if (requestId !== smartPlanningExclusionSearchRequest) return;
    smartPlanningExclusionState.candidates = Array.isArray(result?.items) ? result.items : [];
  } catch (error) {
    if (requestId !== smartPlanningExclusionSearchRequest) return;
    smartPlanningExclusionState.candidates = [];
    smartPlanningExclusionState.error = error.message;
  } finally {
    if (requestId === smartPlanningExclusionSearchRequest) {
      smartPlanningExclusionState.searching = false;
      const current = document.querySelector("[data-smart-planning-exclusion-candidates]");
      if (current) current.innerHTML = smartPlanningExclusionCandidateRows();
    }
  }
}

async function smartRefreshPlanningExclusions() {
  const result = await smartApi("/api/scm/smart/planning-exclusions");
  if (smartState.data) smartState.data.planningExclusions = result;
  return result;
}

smartScmApp.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-smart-action]");
  if (!button || smartState.busy) return;
  const action = button.dataset.smartAction;
  try {
    if (action === "toggle-planning-exclusions") {
      smartPlanningExclusionState.open = !smartPlanningExclusionState.open;
      smartState.error = "";
      smartRender();
      if (smartPlanningExclusionState.open && smartPlanningExclusionState.search.trim()) {
        await smartSearchPlanningExclusionItems();
      }
    } else if (action === "add-planning-exclusion") {
      if (!smartCanWrite()) return;
      const reasonInput = document.getElementById("smartPlanningExclusionReason");
      const expiryInput = document.getElementById("smartPlanningExclusionExpiry");
      smartPlanningExclusionState.reason = reasonInput?.value.trim() || smartPlanningExclusionState.reason.trim();
      smartPlanningExclusionState.expiresAt = expiryInput?.value || smartPlanningExclusionState.expiresAt;
      if (!smartPlanningExclusionState.reason) throw new Error("Enter why this item is being paused.");
      const item = smartPlanningExclusionState.candidates.find((candidate) => Number(candidate.itemId) === Number(button.dataset.itemId));
      await smartWork("Pausing vendor PO planning", () => smartApi("/api/scm/smart/planning-exclusions", {
        method: "POST",
        body: {
          itemId: Number(button.dataset.itemId),
          reason: smartPlanningExclusionState.reason,
          expiresAt: smartPlanningExclusionState.expiresAt || null
        }
      }), `${item?.itemName || "Item"} paused for new vendor POs; TO remains available`);
      await smartRefreshPlanningExclusions();
      smartPlanningExclusionState.error = "";
      smartRender();
    } else if (action === "remove-planning-exclusion") {
      if (!smartCanWrite()) return;
      if (!confirm(`Resume planning for ${button.dataset.itemName || "this item"}?`)) return;
      await smartWork("Resuming item planning", () => smartApi(`/api/scm/smart/planning-exclusions/${button.dataset.exclusionId}`, {
        method: "DELETE",
        body: { note: "Resumed from the PO planning pauses panel" }
      }), `${button.dataset.itemName || "Item"} returned to planning`);
      await smartRefreshPlanningExclusions();
      smartRender();
    } else if (action === "open-blanket-orders") {
      smartPlanningExclusionState.open = false;
      smartState.tab = "blankets";
      smartRender();
      if (typeof smartLoadBlanketWorkspace === "function") await smartLoadBlanketWorkspace({ quiet: true });
    }
  } catch (error) {
    smartState.busy = "";
    smartState.error = error.message;
    smartRender();
  }
});

smartScmApp.addEventListener("input", (event) => {
  if (event.target.id === "smartPlanningExclusionSearch") {
    smartPlanningExclusionState.search = event.target.value;
    clearTimeout(smartPlanningExclusionSearchTimer);
    smartPlanningExclusionSearchTimer = setTimeout(() => {
      smartSearchPlanningExclusionItems().catch((error) => {
        smartPlanningExclusionState.searching = false;
        smartPlanningExclusionState.error = error.message;
      });
    }, 250);
  } else if (event.target.id === "smartPlanningExclusionReason") {
    smartPlanningExclusionState.reason = event.target.value;
  } else if (event.target.id === "smartPlanningExclusionExpiry") {
    smartPlanningExclusionState.expiresAt = event.target.value;
  }
});
