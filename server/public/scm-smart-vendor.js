const smartVendorAutocompleteTimers = new Map();

function smartVendorReplyStatus(line) {
  const latest = line.vendorResponses?.[0] || {};
  if (latest.response_status) return latest.response_status;
  if (Number(line.confirmedPallets || 0) > 0) {
    return Number(line.confirmedPallets) + 0.000001 < Number(line.proposedPallets || 0) ? "partial" : "confirmed";
  }
  return "awaiting";
}

function smartVendorReplyOptions(selected) {
  return ["awaiting", "confirmed", "partial", "out_of_stock", "production_eta", "credit_hold", "cancelled"]
    .map((status) => `<option value="${status}" ${selected === status ? "selected" : ""}>${status.replaceAll("_", " ")}</option>`)
    .join("");
}

function smartVendorLoadCard(proposal) {
  const editable = smartCanWrite()
    && ["order_requested", "vendor_replied"].includes(proposal.status)
    && !proposal.netsuitePurchaseOrderId
    && !proposal.netsuitePurchaseOrderRef;
  const confirmedPallets = proposal.lines.reduce((sum, line) => sum + Number(line.confirmedPallets || 0), 0);
  const originalLines = proposal.lines.filter((line) => !line.isAlternative);
  const disabled = editable ? "" : "disabled";
  return `<article class="smart-proposal smart-vendor-load" data-vendor-load="${proposal.id}">
    <div class="smart-proposal-head smart-vendor-load-head">
      <div><strong>PO</strong><div>${smartPill(proposal.status)}</div></div>
      <div class="smart-proposal-route"><strong>${smartEscape(typeof smartProposalRoute === "function" ? smartProposalRoute(proposal) : `${proposal.vendor || proposal.sourceName || "Vendor"} → ${proposal.destinationName}`)}</strong><span>Load #${proposal.id} · plan #${proposal.runId} · requested ${smartDate(proposal.orderRequestedAt, true)}</span><span>Reply due ${smartDate(proposal.vendorReplyDueAt, true)} · plan built ${smartDate(proposal.planningRunCompletedAt || proposal.planningRunCreatedAt, true)}</span></div>
      <div class="smart-proposal-metric"><strong>${smartNumber(proposal.totalPallets, 2)} PLT</strong><span>Requested load</span></div>
      <div class="smart-proposal-metric"><strong>${smartNumber(confirmedPallets, 2)} PLT</strong><span>Vendor confirmed</span></div>
      <div class="smart-proposal-metric"><strong>${smartEscape(proposal.netsuitePurchaseOrderRef || "—")}</strong><span>PO Ref · whole load</span></div>
      <div>${smartPill(proposal.vendorResponseStatus || "awaiting")}</div>
    </div>
    ${proposal.poExecutionError ? `<div class="smart-vendor-error">${smartEscape(proposal.poExecutionError)}</div>` : ""}
    <div class="smart-vendor-meta">
      <label class="smart-field"><span>Ready date</span><input data-vendor-load-field="readyDate" type="date" value="${smartEscape(String(proposal.vendorReadyDate || "").slice(0, 10))}" ${disabled} /></label>
      <label class="smart-field"><span>Vendor reference</span><input data-vendor-load-field="vendorReference" value="${smartEscape(proposal.vendorReference || "")}" ${disabled} /></label>
      <label class="smart-field"><span>Packing number</span><input data-vendor-load-field="packingNumber" value="${smartEscape(proposal.vendorPackingNumber || "")}" ${disabled} /></label>
      <label class="smart-field"><span>Credit status</span><input data-vendor-load-field="creditStatus" value="${smartEscape(proposal.vendorCreditStatus || "")}" ${disabled} /></label>
      <label class="smart-field smart-vendor-remarks"><span>Load remarks</span><input data-vendor-load-field="remarks" value="${smartEscape(proposal.vendorRemarks || "")}" ${disabled} /></label>
    </div>
    <div class="smart-proposal-lines smart-table-wrap"><table class="smart-table smart-vendor-lines"><thead><tr><th>Item</th><th>Reply status</th><th class="numeric">Requested</th><th class="numeric">Confirmed</th><th class="numeric">PO sales quantity</th><th></th></tr></thead><tbody>
      ${proposal.lines.map((line) => {
        const status = smartVendorReplyStatus(line);
        const confirmed = Number(line.confirmedPallets || 0);
        return `<tr data-vendor-reply-line="${line.id}"><td><strong>${smartEscape(line.itemName)}</strong>${line.isAlternative ? ` ${smartPill("reviewed", "Alternative")}` : ""}<div class="smart-help">ID ${line.itemId} · ${smartEscape(line.itemDescription || line.unit || "")}${line.alternativeForLineId ? ` · replaces line ${line.alternativeForLineId}` : ""}</div></td><td><select data-vendor-line-field="responseStatus" ${disabled}>${smartVendorReplyOptions(status)}</select></td><td class="numeric">${smartNumber(line.proposedPallets, 2)} PLT</td><td><input data-vendor-line-field="confirmedPallets" type="number" min="0" step="0.01" value="${smartEscape(confirmed)}" ${disabled} /></td><td class="numeric">${smartNumber(confirmed * Number(line.toPlt || 0), 3)} ${smartEscape(line.unit || "UOM")}</td><td>${editable && line.isAlternative ? `<button class="smart-button danger" data-smart-action="remove-vendor-alternative" data-proposal-id="${proposal.id}" data-line-id="${line.id}" type="button">Remove</button>` : ""}</td></tr>`;
      }).join("")}
    </tbody></table></div>
    ${editable ? `<div class="smart-vendor-alternative">
      <div><strong>Add alternative item</strong><div class="smart-help">Suggestions and autocomplete are restricted to items with the same NetSuite vendor, pallet conversion, and weight.</div></div>
      <select data-vendor-alternative-for="${proposal.id}" aria-label="Original unavailable line">${originalLines.map((line) => `<option value="${line.id}">For ${smartEscape(line.itemName)} · ${smartNumber(line.proposedPallets, 2)} PLT</option>`).join("")}</select>
      <input type="search" data-vendor-alternative-search="${proposal.id}" placeholder="Search item ID, name, description, or series" autocomplete="off" />
      <button class="smart-button" data-smart-action="suggest-vendor-alternatives" data-proposal-id="${proposal.id}" type="button">System suggestions</button>
      <div class="smart-vendor-alternative-results" data-vendor-alternative-results="${proposal.id}"><span class="smart-help">Search manually or load system suggestions.</span></div>
    </div>` : ""}
    <div class="smart-vendor-load-actions">
      ${editable ? `<button class="smart-button blue" data-smart-action="save-vendor-load" data-proposal-id="${proposal.id}" type="button">Save vendor reply</button>` : ""}
      ${editable && proposal.status === "vendor_replied" && confirmedPallets > 0 ? `<button class="smart-button primary" data-smart-action="confirm-vendor-load" data-proposal-id="${proposal.id}" type="button">Confirm load + create PO</button>` : ""}
      ${proposal.netsuitePurchaseOrderRef ? `<span class="smart-help">Created as ${smartEscape(proposal.netsuitePurchaseOrderRef)}. The reference applies to this entire load.</span>` : ""}
    </div>
  </article>`;
}

function smartVendorReplies() {
  const loads = smartState.vendorReplyLoads || [];
  return `<section class="smart-section">
    <div class="smart-section-head"><div><h2>Vendor reply loads</h2><p>This cross-plan queue contains only PO loads previously marked Order Requested. Edit the vendor-confirmed quantities, add compatible alternatives when needed, then create one PO for the whole load.</p></div><span class="smart-help">${loads.length} requested load(s)</span></div>
    <div class="smart-toolbar smart-vendor-toolbar"><input id="smartVendorLoadSearch" type="search" value="${smartEscape(smartState.vendorSearch)}" placeholder="Search load, item, vendor, or yard" /><button class="smart-button" data-smart-action="refresh-vendor-loads" type="button">Refresh</button></div>
    <div class="smart-proposals smart-vendor-loads">${loads.map(smartVendorLoadCard).join("") || `<div class="smart-empty">No requested PO load matches this search. In PO / TO proposals, mark a reviewed PO load Order Requested first.</div>`}</div>
  </section>`;
}

function smartVendorLoadPayload(card) {
  const payload = { lines: [] };
  card.querySelectorAll("[data-vendor-load-field]").forEach((input) => {
    payload[input.dataset.vendorLoadField] = input.value;
  });
  card.querySelectorAll("[data-vendor-reply-line]").forEach((row) => {
    const line = { proposalLineId: Number(row.dataset.vendorReplyLine) };
    row.querySelectorAll("[data-vendor-line-field]").forEach((input) => {
      line[input.dataset.vendorLineField] = input.value;
    });
    payload.lines.push(line);
  });
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
  if (!items.length) return `<div class="smart-empty smart-empty-compact">No compatible same-vendor item matches.</div>`;
  return items.map((item) => `<div class="smart-vendor-alternative-result" data-vendor-alternative-result="${item.itemId}"><div><strong>${smartEscape(item.itemName)}</strong>${item.suggested ? ` ${smartPill("reviewed", "Suggested")}` : ""}<div class="smart-help">ID ${item.itemId} · ${smartEscape(item.series || item.description || item.unit || "")} · ${smartNumber(item.palletWeightLbs, 0)} lb / PLT</div></div><label><span>PLT</span><input data-vendor-alternative-qty type="number" min="0.01" step="0.01" value="1" /></label><button class="smart-button primary" data-smart-action="add-vendor-alternative" data-proposal-id="${proposalId}" data-item-id="${item.itemId}" data-source="${item.suggested ? "system" : "manual"}" type="button">Add</button></div>`).join("");
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
      const payload = smartVendorLoadPayload(card);
      const proposal = await smartWork("Saving vendor reply and revising residual supply", () => smartApi(`/api/scm/smart/vendor-reply-loads/${button.dataset.proposalId}`, { method: "PUT", body: payload }), "Vendor reply saved by load");
      smartReplaceVendorLoad(proposal);
      smartRender();
    } else if (action === "confirm-vendor-load") {
      const card = button.closest("[data-vendor-load]");
      const payload = smartVendorLoadPayload(card);
      if (!confirm("Save these confirmed quantities and create one purchase order for this entire load?")) return;
      await smartWork("Saving vendor reply", () => smartApi(`/api/scm/smart/vendor-reply-loads/${button.dataset.proposalId}`, { method: "PUT", body: payload }), "Vendor reply saved");
      const result = await smartWork("Creating purchase order", () => smartApi(`/api/scm/smart/vendor-reply-loads/${button.dataset.proposalId}/confirm`, { method: "POST", body: {} }), "Purchase order created");
      await smartReloadVendorLoads();
      if (smartState.plan) smartState.plan = await smartApi(`/api/scm/smart/planning-runs/${smartState.plan.id}`);
      smartState.notice = `${result.purchaseOrderRef} created for load #${result.proposalId}.`;
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

smartScmApp.addEventListener("input", (event) => {
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
