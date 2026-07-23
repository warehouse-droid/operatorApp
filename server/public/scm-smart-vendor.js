const smartVendorAutocompleteTimers = new Map();

function smartVendorReplyDecision(line) {
  const status = String(line.vendorResponses?.[0]?.response_status || "").toLowerCase();
  if (["cancel", "cancelled", "out_of_stock"].includes(status)) return "cancel";
  if (["hold", "awaiting", "production_eta", "credit_hold"].includes(status)) return "hold";
  return "confirm";
}

function smartVendorReplyOptions(selected) {
  return ["confirm", "hold", "cancel"]
    .map((status) => `<option value="${status}" ${selected === status ? "selected" : ""}>${status[0].toUpperCase()}${status.slice(1)}</option>`)
    .join("");
}

function smartVendorDecisionPallets(line, decision) {
  if (decision === "cancel") return 0;
  const requested = Number(line.proposedPallets || 0);
  const draft = line.reason?.vendorReplyDraft || {};
  const saved = String(draft.decision || "") === decision ? Number(draft.decisionPallets) : 0;
  if (Number.isFinite(saved) && saved > 0) return Math.min(saved, requested);
  const confirmed = Number(line.confirmedPallets ?? line.vendorResponses?.[0]?.confirmed_pallets);
  if (decision === "confirm" && Number.isFinite(confirmed) && confirmed > 0) return Math.min(confirmed, requested);
  const remaining = Number(line.residualPallets || 0);
  return Number.isFinite(remaining) && remaining > 0 ? Math.min(remaining, requested) : requested;
}

function smartVendorConfirmedPallets(line, decision) {
  return decision === "confirm" ? smartVendorDecisionPallets(line, decision) : 0;
}

function smartVendorLineSalesQuantity(line, confirmedPallets) {
  return Number(confirmedPallets || 0) * Number(line.toPlt || 0);
}

function smartVendorEvidenceNumber(value, digits = 2) {
  const number = Number(value);
  return Number.isFinite(number) ? smartNumber(number, digits) : "—";
}

function smartVendorPhysicalPalletRows(proposal, editable) {
  return (proposal.physicalPalletLines || []).map((line) => {
    const quantity = Number(line.quantity ?? line.salesQuantity ?? 0);
    const automaticQuantity = Number(line.automaticQuantity ?? quantity);
    const overridden = line.overridden === true || line.overrideQuantity !== null && line.overrideQuantity !== undefined;
    const itemWeight = Number(line.itemWeightLbs || 0);
    const lineWeight = Number(line.lineWeightLbs || 0);
    const inputDisabled = !editable || !overridden ? "disabled" : "";
    const toggleDisabled = editable ? "" : "disabled";
    return `<tr class="smart-physical-pallet-line" data-vendor-physical-pallet-line="${smartEscape(line.id)}" data-vendor-pallet-destination="${smartEscape(line.destinationLocationId)}" data-vendor-pallet-automatic="${smartEscape(automaticQuantity)}"><td><strong>${smartEscape(line.itemName || "PALLET")}</strong> ${smartPill("reviewed", "Official PALLET")}<div class="smart-help">${line.itemId ? `ID ${smartEscape(line.itemId)} · ` : ""}Official ancillary item · ${itemWeight > 0 ? `${smartNumber(itemWeight, 0)} lb / ${smartEscape(line.unit || "EACH")}` : "NetSuite weight unavailable"}</div></td><td><strong>${overridden ? "Manual override" : "Automatic"}</strong><div class="smart-help">${overridden ? "Saved quantity is protected from automatic regeneration." : "Defaults to the material PLT for this destination."}</div></td><td class="numeric">${smartNumber(automaticQuantity, 2)} ${smartEscape(line.unit || "EACH")}</td><td><input data-vendor-pallet-quantity type="number" min="0" step="0.01" value="${smartEscape(quantity)}" ${inputDisabled} aria-label="Official PALLET quantity for ${smartEscape(line.destinationName || proposal.destinationName)}" /></td><td class="numeric" data-vendor-pallet-effective>${smartNumber(quantity, 2)} ${smartEscape(line.unit || "EACH")}${itemWeight > 0 ? `<div class="smart-help">${smartNumber(lineWeight, 0)} lb</div>` : ""}</td><td><label class="smart-pallet-override-toggle"><input data-vendor-pallet-override-toggle type="checkbox" ${overridden ? "checked" : ""} ${toggleDisabled} /> Override</label></td></tr>`;
  }).join("");
}

function smartVendorLoadCard(proposal) {
  const editable = smartCanWrite()
    && ["order_requested", "vendor_replied"].includes(proposal.status)
    && !proposal.netsuitePurchaseOrderId
    && !proposal.netsuitePurchaseOrderRef;
  const confirmedPallets = proposal.lines.reduce((sum, line) => {
    const decision = smartVendorReplyDecision(line);
    return sum + smartVendorConfirmedPallets(line, decision);
  }, 0);
  const originalLines = proposal.lines.filter((line) => !line.isAlternative);
  const disabled = editable ? "" : "disabled";
  return `<article class="smart-proposal smart-vendor-load" data-vendor-load="${proposal.id}">
    <div class="smart-proposal-head smart-vendor-load-head">
      <div><strong>PO</strong><div>${smartPill(proposal.status)}</div></div>
      <div class="smart-proposal-route"><strong>${smartEscape(typeof smartProposalRoute === "function" ? smartProposalRoute(proposal) : `${proposal.vendor || proposal.sourceName || "Vendor"} → ${proposal.destinationName}`)}</strong><span>Load #${proposal.id} · plan #${proposal.runId} · requested ${smartDate(proposal.orderRequestedAt, true)}</span><span>Reply due ${smartDate(proposal.vendorReplyDueAt, true)} · plan built ${smartDate(proposal.planningRunCompletedAt || proposal.planningRunCreatedAt, true)}</span></div>
      <div class="smart-proposal-metric"><strong>${smartNumber(proposal.totalPallets, 2)} PLT</strong><span>Requested load</span></div>
      <div class="smart-proposal-metric"><strong data-vendor-confirmed-total>${smartNumber(confirmedPallets, 2)} PLT</strong><span>Confirm decisions</span></div>
      <div class="smart-proposal-metric"><strong>${smartEscape(proposal.netsuitePurchaseOrderRef || "—")}</strong><span>NetSuite PO review</span></div>
      <div class="smart-vendor-head-action">${editable ? `<button class="smart-button primary" data-smart-action="confirm-vendor-load" data-proposal-id="${proposal.id}" type="button">Confirm Load</button>` : ""}${smartPill(proposal.vendorResponseStatus || "awaiting")}</div>
    </div>
    ${proposal.poExecutionError ? `<div class="smart-vendor-error">${smartEscape(proposal.poExecutionError)}</div>` : ""}
    <div class="smart-vendor-meta">
      <label class="smart-field"><span>Ready date</span><input data-vendor-load-field="readyDate" type="date" value="${smartEscape(String(proposal.vendorReadyDate || "").slice(0, 10))}" ${disabled} /></label>
      <label class="smart-field"><span>Vendor reference</span><input data-vendor-load-field="vendorReference" value="${smartEscape(proposal.vendorReference || "")}" ${disabled} /></label>
      <label class="smart-field"><span>Packing number</span><input data-vendor-load-field="packingNumber" value="${smartEscape(proposal.vendorPackingNumber || "")}" ${disabled} /></label>
      <label class="smart-field"><span>Credit status</span><input data-vendor-load-field="creditStatus" value="${smartEscape(proposal.vendorCreditStatus || "")}" ${disabled} /></label>
      <label class="smart-field smart-vendor-remarks"><span>Load remarks</span><input data-vendor-load-field="remarks" value="${smartEscape(proposal.vendorRemarks || "")}" ${disabled} /></label>
    </div>
    <div class="smart-proposal-lines smart-table-wrap"><table class="smart-table smart-vendor-lines"><thead><tr><th>Item</th><th>Decision</th><th class="numeric">Requested</th><th class="numeric">Decision qty</th><th class="numeric">Decision sales qty</th><th></th></tr></thead><tbody>
      ${proposal.lines.map((line) => {
        const decision = smartVendorReplyDecision(line);
        const decisionPallets = smartVendorDecisionPallets(line, decision);
        const quantityDisabled = !editable || decision === "cancel" ? "disabled" : "";
        return `<tr data-vendor-reply-line="${line.id}" data-requested-pallets="${Number(line.proposedPallets || 0)}" data-to-plt="${Number(line.toPlt || 0)}" data-sales-unit="${smartEscape(line.unit || "UOM")}"><td><strong>${smartEscape(line.itemName)}</strong>${line.isAlternative ? ` ${smartPill("reviewed", "Alternative")}` : ""}<div class="smart-help">ID ${line.itemId} · ${smartEscape(line.itemDescription || line.unit || "")}${line.alternativeForLineId ? ` · replaces line ${line.alternativeForLineId}` : ""}</div></td><td><select data-vendor-line-field="decision" data-vendor-decision ${disabled}>${smartVendorReplyOptions(decision)}</select></td><td class="numeric">${smartNumber(line.proposedPallets, 2)} PLT</td><td><input data-vendor-line-field="decisionPallets" data-vendor-decision-input data-vendor-confirmed-input type="number" min="0.01" max="${Number(line.proposedPallets || 0)}" step="0.01" value="${smartEscape(decisionPallets)}" ${quantityDisabled} /></td><td class="numeric" data-vendor-sales-quantity>${smartNumber(smartVendorLineSalesQuantity(line, decisionPallets), 3)} ${smartEscape(line.unit || "UOM")}</td><td>${editable && line.isAlternative ? `<button class="smart-button danger" data-smart-action="remove-vendor-alternative" data-proposal-id="${proposal.id}" data-line-id="${line.id}" type="button">Remove</button>` : ""}</td></tr>`;
      }).join("")}
      ${smartVendorPhysicalPalletRows(proposal, editable)}
    </tbody></table></div>
    ${editable ? `<div class="smart-vendor-alternative">
      <div><strong>Add alternative item</strong><div class="smart-help">Candidates must be planning enabled for this destination yard and use the same NetSuite vendor, pallet conversion, and weight. Suggestions are ranked by yard need and demand.</div></div>
      <select data-vendor-alternative-for="${proposal.id}" aria-label="Original unavailable line">${originalLines.map((line) => `<option value="${line.id}">For ${smartEscape(line.itemName)} · ${smartNumber(line.proposedPallets, 2)} PLT</option>`).join("")}</select>
      <input type="search" data-vendor-alternative-search="${proposal.id}" placeholder="Search item ID, name, description, or series" autocomplete="off" />
      <button class="smart-button" data-smart-action="suggest-vendor-alternatives" data-proposal-id="${proposal.id}" type="button">System suggestions</button>
      <div class="smart-vendor-alternative-results" data-vendor-alternative-results="${proposal.id}"><span class="smart-help">Search manually or load system suggestions.</span></div>
    </div>` : ""}
    <div class="smart-vendor-load-actions">
      ${editable ? `<button class="smart-button blue" data-smart-action="save-vendor-load" data-proposal-id="${proposal.id}" type="button">Save draft</button>` : ""}
      ${proposal.netsuitePurchaseOrderRef ? `<span class="smart-help">Staged as ${smartEscape(proposal.netsuitePurchaseOrderRef)} for this entire load.</span>` : ""}
    </div>
  </article>`;
}

function smartVendorReplies() {
  const loads = smartState.vendorReplyLoads || [];
  return `<section class="smart-section">
    <div class="smart-section-head"><div><h2>Vendor reply loads</h2><p>Choose Confirm, Hold, or Cancel for each line. Confirm Load sends confirmed lines to review and splits every held line into its own vendor-reply load.</p></div><div class="smart-vendor-section-actions"><span class="smart-help">${loads.length} requested load(s)</span><a class="smart-button blue smart-vendor-review-link" href="/scm/netsuite-po"><span class="smart-vendor-review-icon" aria-hidden="true">PO</span><span><strong>NetSuite PO review</strong><small>Review priced drafts</small></span><span class="smart-vendor-review-arrow" aria-hidden="true">→</span></a></div></div>
    <div class="smart-toolbar smart-vendor-toolbar"><input id="smartVendorLoadSearch" type="search" value="${smartEscape(smartState.vendorSearch)}" placeholder="Search load, item, vendor, or yard" /><button class="smart-button" data-smart-action="refresh-vendor-loads" type="button">Refresh</button></div>
    <div class="smart-proposals smart-vendor-loads">${loads.map(smartVendorLoadCard).join("") || `<div class="smart-empty">No requested PO load matches this search. In PO / TO proposals, mark a reviewed PO load Order Requested first.</div>`}</div>
  </section>`;
}

function smartVendorLoadPayload(card) {
  const payload = { lines: [], palletQuantityOverrides: {} };
  card.querySelectorAll("[data-vendor-load-field]").forEach((input) => {
    payload[input.dataset.vendorLoadField] = input.value;
  });
  card.querySelectorAll("[data-vendor-reply-line]").forEach((row) => {
    const line = {
      proposalLineId: Number(row.dataset.vendorReplyLine),
      requestedPallets: Number(row.dataset.requestedPallets || 0)
    };
    row.querySelectorAll("[data-vendor-line-field]").forEach((input) => {
      line[input.dataset.vendorLineField] = input.dataset.vendorLineField === "decisionPallets" ? Number(input.value || 0) : input.value;
    });
    payload.lines.push(line);
  });
  card.querySelectorAll("[data-vendor-pallet-destination]").forEach((row) => {
    const destinationLocationId = row.dataset.vendorPalletDestination;
    const overridden = row.querySelector("[data-vendor-pallet-override-toggle]")?.checked === true;
    const rawQuantity = row.querySelector("[data-vendor-pallet-quantity]")?.value || "";
    payload.palletQuantityOverrides[destinationLocationId] = overridden
      ? rawQuantity.trim() === "" ? Number.NaN : Number(rawQuantity)
      : null;
  });
  return payload;
}

function smartUpdateVendorReplyLine(row) {
  const decision = row.querySelector("[data-vendor-decision]")?.value || "hold";
  const input = row.querySelector("[data-vendor-decision-input]");
  const decisionPallets = decision === "cancel" ? 0 : Math.max(Number(input?.value || 0), 0);
  const salesQuantity = decisionPallets * Number(row.dataset.toPlt || 0);
  const salesTarget = row.querySelector("[data-vendor-sales-quantity]");
  if (salesTarget) salesTarget.textContent = `${smartNumber(salesQuantity, 3)} ${row.dataset.salesUnit || "UOM"}`;
}

function smartUpdateVendorConfirmedTotal(card) {
  const total = [...card.querySelectorAll("[data-vendor-reply-line]")].reduce((sum, row) => {
    if (row.querySelector("[data-vendor-decision]")?.value !== "confirm") return sum;
    return sum + Math.max(Number(row.querySelector("[data-vendor-decision-input]")?.value || 0), 0);
  }, 0);
  const target = card.querySelector("[data-vendor-confirmed-total]");
  if (target) target.textContent = `${smartNumber(total, 2)} PLT`;
}

function smartValidateVendorLoadPayload(payload) {
  for (const quantity of Object.values(payload.palletQuantityOverrides || {})) {
    if (quantity === null) continue;
    if (!Number.isFinite(Number(quantity)) || Number(quantity) < 0) {
      throw new Error("Every PALLET override must be a number at or above zero.");
    }
  }
  for (const line of payload.lines || []) {
    if (line.decision === "cancel") continue;
    const decisionPallets = Number(line.decisionPallets);
    const requestedPallets = Number(line.requestedPallets);
    const label = line.decision === "hold" ? "Hold" : "Confirm";
    if (!(decisionPallets > 0)) throw new Error(`Every ${label} line needs a quantity above 0 PLT.`);
    if (Number.isFinite(requestedPallets) && decisionPallets > requestedPallets) {
      throw new Error(`${label} quantity cannot exceed the requested pallets.`);
    }
  }
  return payload;
}

function smartReplaceVendorLoad(proposal) {
  smartState.vendorReplyLoads = (smartState.vendorReplyLoads || []).map((load) => Number(load.id) === Number(proposal.id) ? proposal : load);
  if (smartState.data) smartState.data.vendorReplyLoads = smartState.vendorReplyLoads;
  if (smartState.plan && Number(smartState.plan.id) === Number(proposal.runId)) {
    smartState.plan.proposals = (smartState.plan.proposals || []).map((row) => Number(row.id) === Number(proposal.id) ? proposal : row);
  }
}

async function smartReloadVendorLoads() {
  const params = new URLSearchParams({ search: smartState.vendorSearch || "", limit: "500" });
  smartState.vendorReplyLoads = await smartApi(`/api/scm/smart/vendor-reply-loads?${params}`);
  if (smartState.data) smartState.data.vendorReplyLoads = smartState.vendorReplyLoads;
  return smartState.vendorReplyLoads;
}

function smartVendorAlternativeMarkup(proposalId, items = []) {
  if (!items.length) return `<div class="smart-empty smart-empty-compact">No eligible planned item matches this yard and vendor.</div>`;
  return items.map((item) => {
    const planningYard = item.destinationName || item.destinationLocationId || "Selected yard";
    return `<div class="smart-vendor-alternative-result" data-vendor-alternative-result="${item.itemId}"><div class="smart-vendor-alternative-summary"><div><strong>${smartEscape(item.itemName)}</strong>${item.suggested ? ` ${smartPill("reviewed", "Suggested")}` : ""}<div class="smart-help">ID ${item.itemId} · ${smartEscape(item.series || item.description || item.unit || "")} · ${smartNumber(item.palletWeightLbs, 0)} lb / PLT</div></div><div class="smart-vendor-need-chips"><span class="smart-vendor-need-chip yard"><b>Yard plan</b> ${smartEscape(planningYard)}</span><span class="smart-vendor-need-chip"><b>Position</b> ${smartVendorEvidenceNumber(item.positionPallets)} PLT</span><span class="smart-vendor-need-chip"><b>Preferred</b> ${smartVendorEvidenceNumber(item.preferredPallets)} PLT</span><span class="smart-vendor-need-chip need"><b>Need</b> ${smartVendorEvidenceNumber(item.requiredPallets)} PLT</span><span class="smart-vendor-need-chip"><b>Demand</b> ${smartVendorEvidenceNumber(item.weeklyDemandPallets)} PLT/wk</span></div></div><label><span>PLT</span><input data-vendor-alternative-qty type="number" min="0.01" step="0.01" value="1" /></label><button class="smart-button primary" data-smart-action="add-vendor-alternative" data-proposal-id="${proposalId}" data-item-id="${item.itemId}" data-source="${item.suggested ? "system" : "manual"}" type="button">Add</button></div>`;
  }).join("");
}

async function smartLoadVendorAlternativeResults(proposalId, search = "") {
  const load = document.querySelector(`[data-vendor-load="${proposalId}"]`);
  const lineId = load?.querySelector(`[data-vendor-alternative-for="${proposalId}"]`)?.value || "";
  const params = new URLSearchParams({ search, lineId, limit: "12" });
  const target = load?.querySelector(`[data-vendor-alternative-results="${proposalId}"]`);
  if (target) target.innerHTML = `<span class="smart-help">Finding compatible items…</span>`;
  try {
    const items = await smartApi(`/api/scm/smart/vendor-reply-loads/${proposalId}/alternatives?${params}`);
    const currentTarget = document.querySelector(`[data-vendor-alternative-results="${proposalId}"]`);
    if (currentTarget) currentTarget.innerHTML = smartVendorAlternativeMarkup(proposalId, items);
  } catch (error) {
    const currentTarget = document.querySelector(`[data-vendor-alternative-results="${proposalId}"]`);
    if (currentTarget) currentTarget.innerHTML = `<div class="smart-notice error">${smartEscape(error.message)}</div>`;
  }
}

smartScmApp.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-smart-action]");
  if (!button || smartState.busy) return;
  const action = button.dataset.smartAction;
  if (!["open-vendor-load", "refresh-vendor-loads", "save-vendor-load", "confirm-vendor-load", "suggest-vendor-alternatives", "add-vendor-alternative", "remove-vendor-alternative"].includes(action)) return;
  try {
    if (action === "open-vendor-load") {
      smartState.tab = "vendors";
      smartState.vendorSearch = "";
      await smartReloadVendorLoads();
      smartRender();
      setTimeout(() => document.querySelector(`[data-vendor-load="${button.dataset.proposalId}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
    } else if (action === "refresh-vendor-loads") {
      smartState.vendorSearch = document.getElementById("smartVendorLoadSearch")?.value || "";
      await smartWork("Refreshing requested PO loads", smartReloadVendorLoads, "Vendor load queue refreshed");
    } else if (action === "save-vendor-load") {
      const card = button.closest("[data-vendor-load]");
      const payload = smartValidateVendorLoadPayload(smartVendorLoadPayload(card));
      const proposal = await smartWork("Saving vendor reply draft", () => smartApi(`/api/scm/smart/vendor-reply-loads/${button.dataset.proposalId}`, { method: "PUT", body: payload }), "Vendor reply draft saved");
      smartReplaceVendorLoad(proposal);
      smartRender();
    } else if (action === "confirm-vendor-load") {
      const card = button.closest("[data-vendor-load]");
      const payload = smartValidateVendorLoadPayload(smartVendorLoadPayload(card));
      const confirmedLines = payload.lines.filter((line) => line.decision === "confirm");
      const heldLineCount = payload.lines.filter((line) => line.decision === "hold").length;
      const stagesReview = confirmedLines.length > 0;
      const prompt = `Confirm this load? Confirm lines${stagesReview ? " go to NetSuite PO review" : " are not present"}; each Hold line becomes its own Vendor Replies load; Cancel and unused Hold quantities are finalized at 0 PLT.`;
      if (!confirm(prompt)) return;
      const workLabel = "Splitting and staging vendor decisions";
      const successLabel = stagesReview ? "Vendor decisions staged for review" : "Vendor decisions split and applied";
      const result = await smartWork(workLabel, () => smartApi(`/api/scm/smart/vendor-reply-loads/${button.dataset.proposalId}/confirm`, { method: "POST", body: payload }), successLabel);
      await smartReloadVendorLoads();
      if (smartState.plan) smartState.plan = await smartApi(`/api/scm/smart/planning-runs/${smartState.plan.id}`);
      const sourceId = result?.sourceProposalId || button.dataset.proposalId;
      smartState.notice = result?.message || (result?.reviewProposalId
        ? `Load #${sourceId} staged as NetSuite PO review #${result.reviewProposalId}; ${heldLineCount} held line(s) split into separate Vendor Replies loads.`
        : `Vendor decisions applied to load #${sourceId}; ${heldLineCount} held line(s) split into separate Vendor Replies loads.`);
      smartRender();
    } else if (action === "suggest-vendor-alternatives") {
      await smartLoadVendorAlternativeResults(button.dataset.proposalId, "");
    } else if (action === "add-vendor-alternative") {
      const resultRow = button.closest("[data-vendor-alternative-result]");
      const card = button.closest("[data-vendor-load]");
      const quantity = Number(resultRow?.querySelector("[data-vendor-alternative-qty]")?.value || 0);
      const alternativeForLineId = Number(card?.querySelector(`[data-vendor-alternative-for="${button.dataset.proposalId}"]`)?.value || 0);
      const proposal = await smartWork("Adding alternative item", () => smartApi(`/api/scm/smart/vendor-reply-loads/${button.dataset.proposalId}/lines`, {
        method: "POST",
        body: { itemId: Number(button.dataset.itemId), proposedPallets: quantity, confirmedPallets: quantity, alternativeForLineId, source: button.dataset.source }
      }), "Alternative item added to the load");
      smartReplaceVendorLoad(proposal);
      smartRender();
    } else if (action === "remove-vendor-alternative") {
      if (!confirm("Remove this alternative line from the vendor load?")) return;
      const proposal = await smartWork("Removing alternative item", () => smartApi(`/api/scm/smart/vendor-reply-loads/${button.dataset.proposalId}/lines/${button.dataset.lineId}`, { method: "DELETE" }), "Alternative item removed");
      smartReplaceVendorLoad(proposal);
      smartRender();
    }
  } catch (error) {
    smartState.busy = "";
    smartState.error = error.message;
    smartRender();
  }
});

smartScmApp.addEventListener("change", (event) => {
  const palletToggle = event.target.closest("[data-vendor-pallet-override-toggle]");
  if (palletToggle) {
    const row = palletToggle.closest("[data-vendor-pallet-destination]");
    const input = row?.querySelector("[data-vendor-pallet-quantity]");
    if (input) {
      input.disabled = !palletToggle.checked;
      if (!palletToggle.checked) input.value = row.dataset.vendorPalletAutomatic || "0";
      else input.focus();
    }
    return;
  }
  const decisionSelect = event.target.closest("[data-vendor-decision]");
  if (!decisionSelect) return;
  const row = decisionSelect.closest("[data-vendor-reply-line]");
  const card = decisionSelect.closest("[data-vendor-load]");
  const input = row?.querySelector("[data-vendor-decision-input]");
  if (!row || !card || !input) return;
  const needsQuantity = decisionSelect.value !== "cancel";
  input.disabled = !needsQuantity;
  input.value = needsQuantity ? row.dataset.requestedPallets || "0" : "0";
  smartUpdateVendorReplyLine(row);
  smartUpdateVendorConfirmedTotal(card);
});

smartScmApp.addEventListener("input", (event) => {
  if (event.target.matches("[data-vendor-decision-input]")) {
    const row = event.target.closest("[data-vendor-reply-line]");
    const card = event.target.closest("[data-vendor-load]");
    if (row) smartUpdateVendorReplyLine(row);
    if (card) smartUpdateVendorConfirmedTotal(card);
    return;
  }
  if (event.target.id === "smartVendorLoadSearch") {
    smartState.vendorSearch = event.target.value;
    clearTimeout(smartVendorAutocompleteTimers.get("load-search"));
    smartVendorAutocompleteTimers.set("load-search", setTimeout(async () => {
      try {
        await smartReloadVendorLoads();
        smartRender();
        document.getElementById("smartVendorLoadSearch")?.focus();
      } catch (error) {
        smartState.error = error.message;
        smartRender();
      }
    }, 300));
    return;
  }
  const proposalId = event.target.dataset.vendorAlternativeSearch;
  if (!proposalId) return;
  clearTimeout(smartVendorAutocompleteTimers.get(proposalId));
  smartVendorAutocompleteTimers.set(proposalId, setTimeout(() => {
    smartLoadVendorAlternativeResults(proposalId, event.target.value);
  }, 300));
});
