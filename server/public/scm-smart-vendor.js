const smartVendorAutocompleteTimers = new Map();
const smartVendorAlternativeRequestSequences = new Map();
let smartVendorLoadRequestSequence = 0;
let smartVendorEmailModalWorkflowId = null;
let smartVendorEmailModalDraft = null;
let smartVendorPoPreview = null;

function smartVendorWorkflowId(proposal = {}) {
  return Number(proposal.workflowId || proposal.id);
}

function smartVendorIsBlanket(proposal = {}) {
  return proposal.workflowKind === "blanket_po" || proposal.proposalOrigin === "blanket";
}

function smartVendorSourcePoRef(proposal = {}) {
  return smartVendorIsBlanket(proposal)
    ? String(proposal.sourcePurchaseOrderRef || "").trim()
    : "";
}

function smartVendorDefaultEmailSubject(proposal = {}) {
  const vendor = proposal.vendor || proposal.sourceName || "Vendor";
  const sourcePoRef = smartVendorSourcePoRef(proposal);
  const sourcePoLabel = sourcePoRef ? ` - Source PO ${sourcePoRef}` : "";
  return `Purchase order request - ${vendor}${sourcePoLabel} - Load #${proposal.sourceProposalId || proposal.id}`;
}

function smartVendorPendingPallets(line = {}, proposal = null) {
  const proposed = Number(line.proposedPallets || 0);
  const held = Number(line.residualPallets || 0);
  return proposal && smartVendorIsBlanket(proposal)
    && proposal.workflowStatus === "split_pending"
    && held > 0
    ? held
    : proposed;
}

function smartVendorEmailRows(proposal = {}) {
  const partialBlanket = smartVendorIsBlanket(proposal) && proposal.workflowStatus === "split_pending";
  if (!partialBlanket && Array.isArray(proposal.vendorEmailRows)) return proposal.vendorEmailRows;
  const suppliedByItem = new Map((proposal.vendorEmailRows || []).map((row) => [Number(row.itemId), row]));
  const grouped = new Map();
  for (const line of proposal.lines || []) {
    const itemName = String(line.itemName || "").trim();
    if (line.ancillaryPallet === true || itemName.toUpperCase() === "PALLET") continue;
    const itemId = Number(line.itemId);
    const supplied = suppliedByItem.get(itemId) || {};
    const key = Number.isInteger(itemId) && itemId > 0 ? String(itemId) : `line:${line.id}`;
    const current = grouped.get(key) || {
      itemId: Number.isInteger(itemId) && itemId > 0 ? itemId : null,
      itemName,
      vendorCode: line.vendorCode || supplied.vendorCode || "",
      description: line.itemDescription || supplied.description || "",
      requestedPallets: 0
    };
    current.requestedPallets += smartVendorPendingPallets(line, proposal);
    grouped.set(key, current);
  }
  return [...grouped.values()].sort((left, right) => String(left.itemName).localeCompare(String(right.itemName), "en", { numeric: true }));
}

function smartVendorEmailDraft(proposal = {}) {
  const draft = proposal.vendorEmailDraft || {};
  const local = smartVendorEmailModalDraft?.workflowId === smartVendorWorkflowId(proposal)
    ? smartVendorEmailModalDraft
    : null;
  return {
    to: local?.to ?? draft.to ?? "",
    subject: local?.subject ?? draft.subject ?? smartVendorDefaultEmailSubject(proposal),
    intro: local?.intro ?? draft.intro ?? "Hello,\n\nPlease review the requested items below and confirm availability and ready date.",
    closing: local?.closing ?? draft.closing ?? "Thank you,"
  };
}

function smartVendorStartEmailDraft(proposal = {}) {
  const workflowId = smartVendorWorkflowId(proposal);
  const saved = proposal.vendorEmailDraft || {};
  smartVendorEmailModalDraft = {
    workflowId,
    to: saved.to || "",
    subject: saved.subject || smartVendorDefaultEmailSubject(proposal),
    intro: saved.intro || "Hello,\n\nPlease review the requested items below and confirm availability and ready date.",
    closing: saved.closing || "Thank you,",
    vendorCodes: Object.fromEntries(smartVendorEmailRows(proposal)
      .filter((row) => Number.isInteger(Number(row.itemId)) && Number(row.itemId) > 0)
      .map((row) => [String(row.itemId), row.vendorCode || ""]))
  };
  return smartVendorEmailModalDraft;
}

function smartVendorEmailCode(row = {}) {
  if (smartVendorEmailModalDraft?.workflowId !== Number(smartVendorEmailModalWorkflowId)) return row.vendorCode || "";
  return smartVendorEmailModalDraft.vendorCodes?.[String(row.itemId)] ?? row.vendorCode ?? "";
}

function smartVendorTextLines(value) {
  return smartEscape(String(value || "")).replaceAll("\n", "<br />");
}

function smartVendorEmailModal() {
  const proposal = (smartState.vendorReplyLoads || [])
    .find((load) => smartVendorWorkflowId(load) === Number(smartVendorEmailModalWorkflowId));
  if (!proposal) return "";
  const workflowId = smartVendorWorkflowId(proposal);
  const draft = smartVendorEmailDraft(proposal);
  const rows = smartVendorEmailRows(proposal);
  const missingCodes = rows.filter((row) => !String(row.vendorCode || "").trim()).length;
  const lookupError = String(proposal.vendorCodeLookupError || "").trim();
  const warning = [
    lookupError,
    missingCodes
      ? `${missingCodes} item${missingCodes === 1 ? " is" : "s are"} missing a NetSuite vendor code. You may enter it below and continue.`
      : ""
  ].filter(Boolean).join(" ");
  const vendor = proposal.vendor || proposal.sourceName || "Vendor";
  const sourcePoRef = smartVendorSourcePoRef(proposal);
  return `<div class="smart-vendor-email-modal" role="presentation">
    <button class="smart-vendor-email-backdrop" data-smart-action="close-vendor-email" data-workflow-id="${workflowId}" type="button" aria-label="Close vendor email draft"></button>
    <section class="smart-vendor-email-dialog" data-vendor-email-editor="${workflowId}" data-vendor-email-source-po="${smartEscape(sourcePoRef)}" role="dialog" aria-modal="true" aria-labelledby="smartVendorEmailTitle">
      <header><div><strong id="smartVendorEmailTitle">New message</strong><span>${smartEscape(vendor)} · Load #${smartEscape(proposal.sourceProposalId || proposal.id)}${sourcePoRef ? ` · Source PO ${smartEscape(sourcePoRef)}` : ""}</span></div><button class="smart-button" data-smart-action="close-vendor-email" data-workflow-id="${workflowId}" type="button" aria-label="Close vendor email draft">Close</button></header>
      <div class="smart-vendor-email-compose">
        <div class="smart-vendor-email-envelope">
          <label class="smart-vendor-email-envelope-row"><span>To</span><input data-vendor-email-field="to" data-smart-focus-key="vendor-workflow:${workflowId}:email:to" type="text" value="${smartEscape(draft.to)}" placeholder="vendor@example.com" autocomplete="email" /></label>
          <label class="smart-vendor-email-envelope-row"><span>Subject</span><input data-vendor-email-field="subject" data-smart-focus-key="vendor-workflow:${workflowId}:email:subject" value="${smartEscape(draft.subject)}" /></label>
        </div>
        <div class="smart-vendor-email-paper">
          <textarea class="smart-vendor-email-body-field" data-vendor-email-field="intro" data-smart-focus-key="vendor-workflow:${workflowId}:email:intro" aria-label="Email introduction">${smartEscape(draft.intro)}</textarea>
          ${sourcePoRef ? `<div class="smart-vendor-email-source-po"><strong>Source PO:</strong> ${smartEscape(sourcePoRef)}</div>` : ""}
          ${warning ? `<div class="smart-vendor-email-warning">${smartEscape(warning)}</div>` : ""}
          <div class="smart-table-wrap"><table class="smart-table smart-vendor-email-table"><thead><tr><th>Item name</th><th>Vendor code</th><th>Description</th><th class="numeric">PLT qty</th></tr></thead><tbody>${rows.map((row) => `<tr data-vendor-email-item="${smartEscape(row.itemId || "")}"><td><strong>${smartEscape(row.itemName || row.itemId || "—")}</strong></td><td><input data-vendor-email-code="${smartEscape(row.itemId || "")}" data-smart-focus-key="vendor-workflow:${workflowId}:email:item:${smartEscape(row.itemId || "unknown")}:code" value="${smartEscape(smartVendorEmailCode(row))}" placeholder="Missing — enter if known" aria-label="Vendor code for ${smartEscape(row.itemName || row.itemId || "item")}" /></td><td>${smartEscape(row.description || "—")}</td><td class="numeric"><strong>${smartNumber(row.requestedPallets, 2)} PLT</strong></td></tr>`).join("") || `<tr><td colspan="4"><span class="smart-help">No material item is available for this draft.</span></td></tr>`}</tbody></table></div>
          <textarea class="smart-vendor-email-body-field closing" data-vendor-email-field="closing" data-smart-focus-key="vendor-workflow:${workflowId}:email:closing" aria-label="Email closing">${smartEscape(draft.closing)}</textarea>
        </div>
      </div>
      <footer><span class="smart-vendor-email-status" data-vendor-email-status>Edits are used immediately. Open Gmail also copies the rich table for pasting.</span><div class="smart-vendor-email-actions"><button class="smart-button blue" data-smart-action="save-vendor-email" data-workflow-id="${workflowId}" type="button">Save email draft</button><button class="smart-button primary" data-smart-action="copy-vendor-email-rich" data-workflow-id="${workflowId}" type="button">Copy email</button><button class="smart-button" data-smart-action="copy-vendor-email-plain" data-workflow-id="${workflowId}" type="button">Copy plain text</button><button class="smart-button" data-smart-action="open-vendor-gmail" data-workflow-id="${workflowId}" type="button">Open Gmail</button></div></footer>
    </section>
  </div>`;
}

function smartVendorEmailPayload(editor) {
  const payload = { to: "", subject: "", intro: "", closing: "", vendorCodes: {} };
  editor.querySelectorAll("[data-vendor-email-field]").forEach((input) => {
    payload[input.dataset.vendorEmailField] = input.value;
  });
  editor.querySelectorAll("[data-vendor-email-code]").forEach((input) => {
    const itemId = Number(input.dataset.vendorEmailCode);
    if (Number.isInteger(itemId) && itemId > 0) payload.vendorCodes[String(itemId)] = input.value.trim();
  });
  return payload;
}

function smartVendorEmailContent(editor) {
  const payload = smartVendorEmailPayload(editor);
  const sourcePoRef = String(editor?.dataset?.vendorEmailSourcePo || "").trim();
  const rows = [...editor.querySelectorAll("[data-vendor-email-item]")].map((row) => ({
    itemName: row.cells?.[0]?.innerText?.trim() || row.querySelector("td:nth-child(1)")?.textContent?.trim() || "",
    vendorCode: row.querySelector("[data-vendor-email-code]")?.value?.trim() || "",
    description: row.cells?.[2]?.innerText?.trim() || row.querySelector("td:nth-child(3)")?.textContent?.trim() || "",
    pallets: row.cells?.[3]?.innerText?.trim() || row.querySelector("td:nth-child(4)")?.textContent?.trim() || ""
  }));
  const htmlRows = rows.map((row) => `<tr><td style="border:1px solid #b9c5cc;padding:7px 9px"><strong>${smartEscape(row.itemName)}</strong></td><td style="border:1px solid #b9c5cc;padding:7px 9px">${smartEscape(row.vendorCode || "—")}</td><td style="border:1px solid #b9c5cc;padding:7px 9px">${smartEscape(row.description || "—")}</td><td style="border:1px solid #b9c5cc;padding:7px 9px;text-align:right;white-space:nowrap"><strong>${smartEscape(row.pallets)}</strong></td></tr>`).join("");
  const sourcePoHtml = sourcePoRef ? `<p><strong>Source PO:</strong> ${smartEscape(sourcePoRef)}</p>` : "";
  const html = `<div style="font-family:Arial,sans-serif;color:#17313d;font-size:14px;line-height:1.45"><p>${smartVendorTextLines(payload.intro)}</p>${sourcePoHtml}<table style="border-collapse:collapse;width:100%;max-width:900px"><thead><tr style="background:#eaf1f5"><th style="border:1px solid #b9c5cc;padding:7px 9px;text-align:left">Item name</th><th style="border:1px solid #b9c5cc;padding:7px 9px;text-align:left">Vendor code</th><th style="border:1px solid #b9c5cc;padding:7px 9px;text-align:left">Description</th><th style="border:1px solid #b9c5cc;padding:7px 9px;text-align:right">PLT qty</th></tr></thead><tbody>${htmlRows}</tbody></table><p>${smartVendorTextLines(payload.closing)}</p></div>`;
  const plainRows = rows.map((row) => `${row.itemName}\t${row.vendorCode || "—"}\t${row.description || "—"}\t${row.pallets}`).join("\n");
  const sourcePoPlain = sourcePoRef ? `Source PO: ${sourcePoRef}\n\n` : "";
  const plain = `${payload.intro}\n\n${sourcePoPlain}Item name\tVendor code\tDescription\tPLT qty\n${plainRows}\n\n${payload.closing}`;
  return { ...payload, html, plain };
}

function smartVendorSetEmailStatus(editor, message) {
  const status = editor?.querySelector("[data-vendor-email-status]");
  if (status) status.textContent = message;
}

async function smartVendorWriteClipboard({ html = "", plain = "" } = {}) {
  if (html && navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([plain], { type: "text/plain" })
      })]);
      return "rich";
    } catch {
      // Some browsers expose rich clipboard APIs but deny them; retain a plain-text fallback.
    }
  }
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(plain);
      return "plain";
    } catch {
      // Fall through to the legacy selection copy for older or permission-restricted browsers.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = plain;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
  return "plain";
}

function smartVendorPoPreviewModal() {
  if (!smartVendorPoPreview) return "";
  const workflowId = Number(smartVendorPoPreview.workflowId);
  const label = smartVendorPoPreview.label || "NetSuite purchase order";
  return `<div class="smart-vendor-pdf-modal" role="presentation">
    <button class="smart-vendor-pdf-backdrop" data-smart-action="close-vendor-po-preview" type="button" aria-label="Close purchase order preview"></button>
    <section class="smart-vendor-pdf-dialog" role="dialog" aria-modal="true" aria-labelledby="smartVendorPdfTitle">
      <header><div><strong id="smartVendorPdfTitle">${smartEscape(label)}</strong><span>NetSuite PDF preview</span></div><button class="smart-button" data-smart-action="close-vendor-po-preview" type="button" aria-label="Close purchase order preview">Close</button></header>
      <iframe src="/api/scm/smart/vendor-workflows/${workflowId}/purchase-order.pdf" title="${smartEscape(label)} PDF"></iframe>
    </section>
  </div>`;
}

function smartVendorReplyDecision(line, proposal = null) {
  if (proposal && smartVendorIsBlanket(proposal)
    && proposal.workflowStatus === "split_pending"
    && Number(line.residualPallets || 0) > 0) {
    return "hold";
  }
  const saved = String(line.reason?.vendorReplyDraft?.decision || "").toLowerCase();
  if (["cancel", "cancelled", "out_of_stock"].includes(saved)) return "cancel";
  if (["hold", "awaiting", "production_eta", "credit_hold"].includes(saved)) return "hold";
  if (saved === "confirm") return "confirm";
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

function smartVendorDestinationOptions(selectedLocationId, selectedName = "") {
  const selected = Number(selectedLocationId);
  const yards = [
    { locationId: 1, name: "3445" },
    { locationId: 28, name: "2967" },
    { locationId: 15, name: "12441" },
    { locationId: 26, name: "150" }
  ];
  const legacy = Number.isInteger(selected) && selected > 0 && !yards.some((yard) => yard.locationId === selected)
    ? `<option value="${smartEscape(selected)}" selected>${smartEscape(selectedName || selected)}</option>`
    : "";
  return `${legacy}${yards.map((yard) => `<option value="${yard.locationId}" ${selected === yard.locationId ? "selected" : ""}>${yard.name}</option>`).join("")}`;
}

function smartVendorDecisionPallets(line, decision, proposal = null) {
  if (decision === "cancel") return 0;
  const requested = smartVendorPendingPallets(line, proposal);
  const draft = line.reason?.vendorReplyDraft || {};
  const saved = String(draft.decision || "") === decision ? Number(draft.decisionPallets) : 0;
  if (Number.isFinite(saved) && saved > 0) return Math.min(saved, requested);
  const confirmed = Number(line.confirmedPallets ?? line.vendorResponses?.[0]?.confirmed_pallets);
  if (decision === "confirm" && Number.isFinite(confirmed) && confirmed > 0) return Math.min(confirmed, requested);
  const remaining = Number(line.residualPallets || 0);
  return Number.isFinite(remaining) && remaining > 0 ? Math.min(remaining, requested) : requested;
}

function smartVendorConfirmedPallets(line, decision, proposal = null) {
  return decision === "confirm" ? smartVendorDecisionPallets(line, decision, proposal) : 0;
}

function smartVendorLineSalesQuantity(line, confirmedPallets) {
  return Number(confirmedPallets || 0) * Number(line.toPlt || 0);
}

function smartVendorEvidenceNumber(value, digits = 2) {
  const number = Number(value);
  return Number.isFinite(number) ? smartNumber(number, digits) : "—";
}

function smartVendorPhysicalPalletRows(proposal, editable) {
  const workflowId = smartVendorWorkflowId(proposal);
  return (proposal.physicalPalletLines || []).map((line) => {
    const quantity = Number(line.quantity ?? line.salesQuantity ?? 0);
    const automaticQuantity = Number(line.automaticQuantity ?? quantity);
    const overridden = line.overridden === true || line.overrideQuantity !== null && line.overrideQuantity !== undefined;
    const itemWeight = Number(line.itemWeightLbs || 0);
    const lineWeight = Number(line.lineWeightLbs || 0);
    const inputDisabled = !editable || !overridden ? "disabled" : "";
    const toggleDisabled = editable ? "" : "disabled";
    return `<tr class="smart-physical-pallet-line" data-vendor-physical-pallet-line="${smartEscape(line.id)}" data-vendor-pallet-destination="${smartEscape(line.destinationLocationId)}" data-vendor-pallet-automatic="${smartEscape(automaticQuantity)}"><td><strong>${smartEscape(line.itemName || "PALLET")}</strong> ${smartPill("reviewed", "Official PALLET")}<div class="smart-help">${line.itemId ? `ID ${smartEscape(line.itemId)} · ` : ""}Official ancillary item · ${itemWeight > 0 ? `${smartNumber(itemWeight, 0)} lb / ${smartEscape(line.unit || "EACH")}` : "NetSuite weight unavailable"}</div></td><td><strong>${smartEscape(line.destinationName || proposal.destinationName || "—")}</strong></td><td><strong>${overridden ? "Manual override" : "Automatic"}</strong><div class="smart-help">${overridden ? "Saved quantity is protected from automatic regeneration." : "Defaults to the material PLT for this destination."}</div></td><td class="numeric">${smartNumber(automaticQuantity, 2)} ${smartEscape(line.unit || "EACH")}</td><td><input data-vendor-pallet-quantity data-smart-focus-key="vendor-workflow:${workflowId}:pallet-line:${smartEscape(line.id)}:destination:${smartEscape(line.destinationLocationId)}:quantity" type="number" min="0" step="0.01" value="${smartEscape(quantity)}" ${inputDisabled} aria-label="Official PALLET quantity for ${smartEscape(line.destinationName || proposal.destinationName)}" /></td><td class="numeric" data-vendor-pallet-effective>${smartNumber(quantity, 2)} ${smartEscape(line.unit || "EACH")}</td><td class="numeric">${itemWeight > 0 ? `${smartNumber(lineWeight, 0)} lb` : "—"}</td><td><label class="smart-pallet-override-toggle"><input data-vendor-pallet-override-toggle data-smart-focus-key="vendor-workflow:${workflowId}:pallet-line:${smartEscape(line.id)}:destination:${smartEscape(line.destinationLocationId)}:override" type="checkbox" ${overridden ? "checked" : ""} ${toggleDisabled} /> Override</label></td></tr>`;
  }).join("");
}

function smartVendorLoadCard(proposal) {
  const workflowId = smartVendorWorkflowId(proposal);
  const isBlanket = smartVendorIsBlanket(proposal);
  const editable = smartCanWrite()
    && (proposal.canEditVendorReply ?? ["order_requested", "vendor_replied"].includes(proposal.status))
    && !proposal.netsuitePurchaseOrderId
    && !proposal.netsuitePurchaseOrderRef;
  const confirmedPallets = (proposal.lines || []).reduce((sum, line) => {
    const decision = smartVendorReplyDecision(line, proposal);
    return sum + smartVendorConfirmedPallets(line, decision, proposal);
  }, 0);
  const partialBlanket = isBlanket && proposal.workflowStatus === "split_pending";
  const displayedPallets = partialBlanket
    ? (proposal.lines || []).reduce((sum, line) => sum + smartVendorPendingPallets(line, proposal), 0)
    : Number(proposal.totalPallets || 0);
  const displayedWeight = partialBlanket
    ? (proposal.lines || []).reduce((sum, line) => sum + smartVendorPendingPallets(line, proposal) * Number(line.palletWeightLbs || 0), 0)
    : Number(proposal.totalWeightLbs || 0);
  const overCapacity = Number(proposal.utilization) > 1.000001;
  const originalLines = (proposal.lines || []).filter((line) => !line.isAlternative);
  const disabled = editable ? "" : "disabled";
  const route = typeof smartProposalRoute === "function"
    ? smartProposalRoute(proposal)
    : `${proposal.vendor || proposal.sourceName || "Vendor"} → ${proposal.destinationName}`;
  const createAction = smartCanWrite() && (proposal.canCreatePurchaseOrder ?? (!isBlanket && editable))
    ? `<button class="smart-button primary" data-smart-action="create-vendor-po" data-workflow-id="${workflowId}" type="button">Create PO in NetSuite</button>`
    : smartCanWrite() && (proposal.canCreateBlanketSplit ?? (isBlanket && editable))
      ? `<button class="smart-button primary" data-smart-action="create-blanket-split" data-workflow-id="${workflowId}" type="button">Create Split PO</button>`
      : "";
  const purchaseRef = proposal.netsuitePurchaseOrderRef || proposal.splitPurchaseOrderRef || "";
  const completedActions = !isBlanket && Number(proposal.netsuitePurchaseOrderId) > 0 && purchaseRef
    ? `<button class="smart-button" data-smart-action="preview-vendor-po" data-workflow-id="${workflowId}" type="button">Preview PO</button>${proposal.canMoveToHistory ? `<button class="smart-button blue" data-smart-action="archive-vendor-workflow" data-workflow-id="${workflowId}" type="button">Move to PO history</button>` : ""}`
    : "";
  const saveDraftAction = editable
    ? `<button class="smart-button blue" data-smart-action="save-vendor-load" data-proposal-id="${proposal.id}" type="button">${isBlanket ? "Save Blanket draft" : "Save draft"}</button>`
    : "";
  return `<article class="smart-proposal smart-vendor-load" data-vendor-load="${proposal.id}" data-vendor-workflow="${workflowId}" data-vendor-kind="${isBlanket ? "blanket_po" : "regular_po"}">
    <div class="smart-vendor-card-header">
      <div class="smart-vendor-card-primary">
        <div class="smart-vendor-identity"><strong>${isBlanket ? "Blanket PO" : "PO"}</strong>${smartPill(proposal.workflowStatus || proposal.status)}${smartPill(proposal.vendorResponseStatus || "awaiting")}${overCapacity ? smartPill("attention", "Over capacity · manual") : ""}</div>
        <div class="smart-vendor-route" title="${smartEscape(route)}"><strong>${smartEscape(route)}</strong></div>
        <div class="smart-vendor-head-actions">${saveDraftAction}<button class="smart-button" data-smart-action="toggle-vendor-email" data-workflow-id="${workflowId}" type="button">Draft email</button>${createAction}${completedActions}</div>
      </div>
      <div class="smart-vendor-card-facts">
        <span><b>Load</b> #${smartEscape(proposal.sourceProposalId || proposal.id)}</span>
        ${isBlanket && proposal.sourcePurchaseOrderRef ? `<span><b>Source PO</b> ${smartEscape(proposal.sourcePurchaseOrderRef)}</span>` : ""}
        <span><b>Plan</b> #${smartEscape(proposal.runId || "—")}</span>
        <span><b>${partialBlanket ? "Held remainder" : "Requested"}</b> ${smartNumber(displayedPallets, 2)} PLT</span>
        <span><b>Weight</b> ${smartNumber(displayedWeight, 0)} lb</span>
        <span><b>Confirm decisions</b> <strong data-vendor-confirmed-total>${smartNumber(confirmedPallets, 2)} PLT</strong></span>
        <span><b>Requested at</b> ${smartDate(proposal.orderRequestedAt, true)}</span>
        <span><b>Reply due</b> ${smartDate(proposal.vendorReplyDueAt, true)}</span>
        ${purchaseRef ? `<span><b>${isBlanket ? "Split PO" : "NetSuite PO"}</b> ${smartEscape(purchaseRef)}</span>` : ""}
      </div>
    </div>
    ${partialBlanket ? `<div class="smart-vendor-partial-note">This workflow now contains only the held remainder. Previously released quantities remain on the existing split and will not be submitted again.</div>` : ""}
    ${proposal.poExecutionError ? `<div class="smart-vendor-error">${smartEscape(proposal.poExecutionError)}</div>` : ""}
    <div class="smart-vendor-meta">
      <label class="smart-field"><span>Ready date</span><input data-vendor-load-field="readyDate" data-smart-focus-key="vendor-workflow:${workflowId}:load:ready-date" type="date" value="${smartEscape(String(proposal.vendorReadyDate || "").slice(0, 10))}" ${disabled} /></label>
      <label class="smart-field"><span>Vendor reference</span><input data-vendor-load-field="vendorReference" data-smart-focus-key="vendor-workflow:${workflowId}:load:vendor-reference" value="${smartEscape(proposal.vendorReference || "")}" ${disabled} /></label>
      <label class="smart-field"><span>Packing number</span><input data-vendor-load-field="packingNumber" data-smart-focus-key="vendor-workflow:${workflowId}:load:packing-number" value="${smartEscape(proposal.vendorPackingNumber || "")}" ${disabled} /></label>
      <label class="smart-field"><span>Credit status</span><input data-vendor-load-field="creditStatus" data-smart-focus-key="vendor-workflow:${workflowId}:load:credit-status" value="${smartEscape(proposal.vendorCreditStatus || "")}" ${disabled} /></label>
      <label class="smart-field smart-vendor-remarks"><span>Load remarks</span><input data-vendor-load-field="remarks" data-smart-focus-key="vendor-workflow:${workflowId}:load:remarks" value="${smartEscape(proposal.vendorRemarks || "")}" ${disabled} /></label>
      ${isBlanket ? `<label class="smart-field"><span>Split PO reference</span><input data-vendor-load-field="splitPoRef" data-smart-focus-key="vendor-workflow:${workflowId}:load:split-po-ref" value="${smartEscape(proposal.splitPurchaseOrderRef || "")}" placeholder="Enter after vendor reply" ${editable ? "" : "disabled"} /></label>` : ""}
    </div>
    <div class="smart-proposal-lines smart-table-wrap"><table class="smart-table smart-vendor-lines"><thead><tr><th>Item</th><th>Location</th><th>Decision</th><th class="numeric">Requested</th><th class="numeric">Decision qty</th><th class="numeric">Decision sales qty</th><th class="numeric">Requested weight</th><th></th></tr></thead><tbody>
      ${(proposal.lines || []).map((line) => {
        const decision = smartVendorReplyDecision(line, proposal);
        const requestedPallets = smartVendorPendingPallets(line, proposal);
        const decisionPallets = smartVendorDecisionPallets(line, decision, proposal);
        const requestedWeight = partialBlanket
          ? requestedPallets * Number(line.palletWeightLbs || 0)
          : Number(line.lineWeightLbs || 0);
        const quantityDisabled = !editable || decision === "cancel" ? "disabled" : "";
        const destinationLocationId = line.destinationLocationId || proposal.destinationLocationId || "";
        const destinationName = line.destinationName || proposal.destinationName || "—";
        return `<tr data-vendor-reply-line="${line.id}" data-destination-location-id="${smartEscape(destinationLocationId)}" data-saved-destination-location-id="${smartEscape(destinationLocationId)}" data-requested-pallets="${requestedPallets}" data-to-plt="${Number(line.toPlt || 0)}" data-sales-unit="${smartEscape(line.unit || "UOM")}"><td><strong>${smartEscape(line.itemName)}</strong>${line.isAlternative ? ` ${smartPill("reviewed", "Alternative")}` : ""}<div class="smart-help">ID ${line.itemId} · ${smartEscape(line.itemDescription || line.unit || "")}${line.alternativeForLineId ? ` · replaces line ${line.alternativeForLineId}` : ""}</div></td><td>${editable ? `<select class="smart-line-destination-select" data-vendor-line-destination data-smart-focus-key="vendor-workflow:${workflowId}:line:${smartEscape(line.id)}:destination" aria-label="Destination yard for ${smartEscape(line.itemName)}">${smartVendorDestinationOptions(destinationLocationId, destinationName)}</select>` : `<strong>${smartEscape(destinationName)}</strong>`}</td><td><select data-vendor-line-field="decision" data-vendor-decision data-smart-focus-key="vendor-workflow:${workflowId}:line:${smartEscape(line.id)}:decision" ${disabled}>${smartVendorReplyOptions(decision)}</select></td><td class="numeric">${smartNumber(requestedPallets, 2)} PLT</td><td><input data-vendor-line-field="decisionPallets" data-vendor-decision-input data-vendor-confirmed-input data-smart-focus-key="vendor-workflow:${workflowId}:line:${smartEscape(line.id)}:decision-pallets" type="number" min="0.01" max="${requestedPallets}" step="0.01" value="${smartEscape(decisionPallets)}" ${quantityDisabled} /></td><td class="numeric" data-vendor-sales-quantity>${smartNumber(smartVendorLineSalesQuantity(line, decisionPallets), 3)} ${smartEscape(line.unit || "UOM")}</td><td class="numeric">${smartNumber(requestedWeight, 0)} lb</td><td>${editable && line.isAlternative ? `<button class="smart-button danger" data-smart-action="remove-vendor-alternative" data-proposal-id="${proposal.id}" data-line-id="${line.id}" type="button">Remove</button>` : ""}</td></tr>`;
      }).join("")}
      ${smartVendorPhysicalPalletRows(proposal, editable && !isBlanket)}
    </tbody></table></div>
    ${editable ? `<div class="smart-vendor-alternative">
      <div><strong>Add alternative item</strong><div class="smart-help">${isBlanket ? "Blanket alternatives must come from the same source PO and its remaining quantity." : "Candidates must be planning enabled for this destination yard and use the same NetSuite vendor, pallet conversion, and weight. Suggestions are ranked by yard need and demand."}</div></div>
      <select data-vendor-alternative-for="${proposal.id}" data-smart-focus-key="vendor-workflow:${workflowId}:alternative:source-line" aria-label="Original unavailable line">${originalLines.map((line) => `<option value="${line.id}">For ${smartEscape(line.itemName)} · ${smartNumber(smartVendorPendingPallets(line, proposal), 2)} PLT</option>`).join("")}</select>
      <input type="search" data-vendor-alternative-search="${proposal.id}" data-smart-focus-key="vendor-workflow:${workflowId}:alternative:search" placeholder="${isBlanket ? "Search this source PO's remaining items" : "Search item ID, name, description, or series"}" autocomplete="off" />
      <button class="smart-button" data-smart-action="suggest-vendor-alternatives" data-proposal-id="${proposal.id}" type="button">${isBlanket ? "Show source balance" : "System suggestions"}</button>
      <div class="smart-vendor-alternative-results" data-vendor-alternative-results="${proposal.id}"><span class="smart-help">${isBlanket ? "Search or show every eligible item remaining on this source PO." : "Search manually or load system suggestions."}</span></div>
    </div>` : ""}
    <div class="smart-vendor-load-actions">
      ${editable ? `<button class="smart-button danger smart-vendor-remove-load" data-smart-action="remove-vendor-load" data-proposal-id="${proposal.id}" type="button">${isBlanket ? "Cancel release" : "Remove Load"}</button>` : ""}
      ${purchaseRef ? `<span class="smart-help">Created as ${smartEscape(purchaseRef)} for this entire load.</span>` : ""}
    </div>
  </article>`;
}

function smartVendorReplies() {
  const loads = smartState.vendorReplyLoads || [];
  return `<section class="smart-section">
    <div class="smart-section-head"><div><h2>Vendor reply loads</h2><p>Save vendor decisions, prepare the vendor email, then create a regular NetSuite PO or finalize a Blanket split. Created regular POs stay here until moved to PO history.</p></div><div class="smart-vendor-section-actions"><span class="smart-help">${loads.length} active workflow(s)</span>${smartCanWrite() ? `<a class="smart-button blue smart-vendor-review-link" href="/scm/netsuite-po"><span class="smart-vendor-review-icon" aria-hidden="true">PO</span><span><strong>NetSuite PO history</strong><small>Application-created POs</small></span><span class="smart-vendor-review-arrow" aria-hidden="true">→</span></a>` : ""}</div></div>
    <div class="smart-toolbar smart-vendor-toolbar"><input id="smartVendorLoadSearch" type="search" value="${smartEscape(smartState.vendorSearch)}" placeholder="Search load, item, vendor, or yard" /><button class="smart-button" data-smart-action="refresh-vendor-loads" type="button">Refresh</button></div>
    <div class="smart-proposals smart-vendor-loads">${loads.map(smartVendorLoadCard).join("") || `<div class="smart-empty">No requested PO load matches this search. In PO / TO proposals, mark a reviewed PO load Order Requested first.</div>`}</div>
  </section>${smartVendorEmailModal()}${smartVendorPoPreviewModal()}`;
}

function smartVendorLoadPayload(card) {
  const payload = { lines: [], palletQuantityOverrides: {} };
  card.querySelectorAll("[data-vendor-load-field]").forEach((input) => {
    payload[input.dataset.vendorLoadField] = input.value;
  });
  card.querySelectorAll("[data-vendor-reply-line]").forEach((row) => {
    const line = {
      proposalLineId: Number(row.dataset.vendorReplyLine),
      requestedPallets: Number(row.dataset.requestedPallets || 0),
      destinationLocationId: Number(row.querySelector("[data-vendor-line-destination]")?.value || row.dataset.destinationLocationId || 0)
    };
    row.querySelectorAll("[data-vendor-line-field]").forEach((input) => {
      line[input.dataset.vendorLineField] = input.dataset.vendorLineField === "decisionPallets" ? Number(input.value || 0) : input.value;
    });
    payload.lines.push(line);
  });
  if (card.dataset.vendorKind !== "blanket_po") card.querySelectorAll("[data-vendor-pallet-destination]").forEach((row) => {
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
    if (!Number.isInteger(Number(line.destinationLocationId)) || Number(line.destinationLocationId) <= 0) {
      throw new Error("Every vendor reply line needs a valid destination yard.");
    }
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
  const requestSequence = ++smartVendorLoadRequestSequence;
  const params = new URLSearchParams({ search: smartState.vendorSearch || "", limit: "500" });
  const loads = await smartApi(`/api/scm/smart/vendor-reply-loads?${params}`);
  if (requestSequence !== smartVendorLoadRequestSequence) return smartState.vendorReplyLoads;
  smartState.vendorReplyLoads = loads;
  if (smartState.data) smartState.data.vendorReplyLoads = loads;
  return smartState.vendorReplyLoads;
}

function smartVendorAlternativeMarkup(proposalId, items = [], { isBlanket = false } = {}) {
  if (!items.length) return `<div class="smart-empty smart-empty-compact">${isBlanket ? "No item with remaining quantity on this source Blanket PO matches the search." : "No eligible planned item matches this yard and vendor."}</div>`;
  return items.map((item) => {
    const fromBlanketPool = isBlanket || item.sameSourcePo === true;
    const planningYard = item.destinationName || item.destinationLocationId || "Selected yard";
    const evidence = fromBlanketPool
      ? `<span class="smart-vendor-need-chip yard"><b>Source PO</b> ${smartEscape(item.sourcePoRef || "—")}</span><span class="smart-vendor-need-chip need"><b>Remaining</b> ${smartVendorEvidenceNumber(item.remainingPallets)} PLT</span><span class="smart-vendor-need-chip"><b>Ordered</b> ${smartVendorEvidenceNumber(item.orderedSalesQty, 3)} ${smartEscape(item.unit || "UOM")}</span><span class="smart-vendor-need-chip"><b>Already allocated</b> ${smartVendorEvidenceNumber(item.allocatedSalesQty, 3)} ${smartEscape(item.unit || "UOM")}</span>`
      : `<span class="smart-vendor-need-chip yard"><b>Yard plan</b> ${smartEscape(planningYard)}</span><span class="smart-vendor-need-chip"><b>Position</b> ${smartVendorEvidenceNumber(item.positionPallets)} PLT</span><span class="smart-vendor-need-chip"><b>Preferred</b> ${smartVendorEvidenceNumber(item.preferredPallets)} PLT</span><span class="smart-vendor-need-chip need"><b>Need</b> ${smartVendorEvidenceNumber(item.requiredPallets)} PLT</span><span class="smart-vendor-need-chip"><b>Demand</b> ${smartVendorEvidenceNumber(item.weeklyDemandPallets)} PLT/wk</span>`;
    const remaining = Number(item.remainingPallets);
    return `<div class="smart-vendor-alternative-result" data-vendor-alternative-result="${item.itemId}" data-vendor-alternative-remaining="${Number.isFinite(remaining) ? remaining : ""}"><div class="smart-vendor-alternative-summary"><div><strong>${smartEscape(item.itemName)}</strong>${item.suggested ? ` ${smartPill("reviewed", "Suggested")}` : ""}<div class="smart-help">ID ${item.itemId} · ${smartEscape(item.series || item.description || item.unit || "")} · ${smartNumber(item.palletWeightLbs, 0)} lb / PLT</div></div><div class="smart-vendor-need-chips">${evidence}</div></div><label><span>PLT</span><input data-vendor-alternative-qty data-smart-focus-key="vendor-proposal:${smartEscape(proposalId)}:alternative-item:${smartEscape(item.itemId)}:source-line:${smartEscape(item.sourceLineId || "none")}:pallets" type="number" min="${fromBlanketPool ? "1" : "0.01"}" step="${fromBlanketPool ? "1" : "0.01"}" ${fromBlanketPool && Number.isFinite(remaining) ? `max="${remaining}"` : ""} value="1" /></label><button class="smart-button primary" data-smart-action="add-vendor-alternative" data-proposal-id="${proposalId}" data-item-id="${item.itemId}" data-source-line-id="${smartEscape(item.sourceLineId || "")}" data-source="${item.suggested ? "system" : "manual"}" type="button">Add</button></div>`;
  }).join("");
}

async function smartLoadVendorAlternativeResults(proposalId, search = "") {
  const load = document.querySelector(`[data-vendor-load="${proposalId}"]`);
  const isBlanket = load?.dataset.vendorKind === "blanket_po";
  const requestSequence = Number(smartVendorAlternativeRequestSequences.get(String(proposalId)) || 0) + 1;
  smartVendorAlternativeRequestSequences.set(String(proposalId), requestSequence);
  const lineId = load?.querySelector(`[data-vendor-alternative-for="${proposalId}"]`)?.value || "";
  const params = new URLSearchParams({ search, lineId, limit: "12" });
  const target = load?.querySelector(`[data-vendor-alternative-results="${proposalId}"]`);
  if (target) target.innerHTML = `<span class="smart-help">Finding compatible items…</span>`;
  try {
    const items = await smartApi(`/api/scm/smart/vendor-reply-loads/${proposalId}/alternatives?${params}`);
    if (smartVendorAlternativeRequestSequences.get(String(proposalId)) !== requestSequence) return;
    const currentTarget = document.querySelector(`[data-vendor-alternative-results="${proposalId}"]`);
    if (currentTarget) currentTarget.innerHTML = smartVendorAlternativeMarkup(proposalId, items, { isBlanket });
  } catch (error) {
    if (smartVendorAlternativeRequestSequences.get(String(proposalId)) !== requestSequence) return;
    const currentTarget = document.querySelector(`[data-vendor-alternative-results="${proposalId}"]`);
    if (currentTarget) currentTarget.innerHTML = `<div class="smart-notice error">${smartEscape(error.message)}</div>`;
  }
}

smartScmApp.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-smart-action]");
  if (!button || smartState.busy) return;
  const action = button.dataset.smartAction;
  if (!["open-vendor-load", "refresh-vendor-loads", "save-vendor-load", "confirm-vendor-load", "remove-vendor-load", "suggest-vendor-alternatives", "add-vendor-alternative", "remove-vendor-alternative", "toggle-vendor-email", "close-vendor-email", "save-vendor-email", "copy-vendor-email-rich", "copy-vendor-email-plain", "open-vendor-gmail", "create-vendor-po", "create-blanket-split", "archive-vendor-workflow", "preview-vendor-po", "close-vendor-po-preview"].includes(action)) return;
  try {
    if (action === "close-vendor-po-preview") {
      smartVendorPoPreview = null;
      smartRender();
    } else if (action === "toggle-vendor-email") {
      const workflowId = Number(button.dataset.workflowId);
      const proposal = (smartState.vendorReplyLoads || []).find((load) => smartVendorWorkflowId(load) === workflowId);
      if (!proposal) throw new Error("This Vendor Replies workflow is no longer available. Refresh the list and try again.");
      smartVendorPoPreview = null;
      smartVendorEmailModalWorkflowId = workflowId;
      smartVendorStartEmailDraft(proposal);
      smartRender();
      setTimeout(() => document.querySelector(`[data-vendor-email-editor="${workflowId}"] [data-vendor-email-field="to"]`)?.focus(), 0);
    } else if (action === "close-vendor-email") {
      smartVendorEmailModalWorkflowId = null;
      smartVendorEmailModalDraft = null;
      smartRender();
    } else if (action === "save-vendor-email") {
      const editor = button.closest("[data-vendor-email-editor]");
      const workflowId = Number(button.dataset.workflowId);
      if (!editor) throw new Error("The vendor email editor is no longer available. Open the draft again.");
      const emailDraft = smartVendorEmailPayload(editor);
      smartVendorEmailModalDraft = { workflowId, ...emailDraft };
      const proposal = await smartWork("Saving vendor email draft", () => smartApi(`/api/scm/smart/vendor-workflows/${workflowId}/email-draft`, {
        method: "PUT",
        body: emailDraft
      }), "Vendor email draft saved");
      smartReplaceVendorLoad(proposal);
      smartVendorEmailModalWorkflowId = workflowId;
      smartRender();
    } else if (["copy-vendor-email-rich", "copy-vendor-email-plain"].includes(action)) {
      const editor = button.closest("[data-vendor-email-editor]");
      if (!editor) throw new Error("The vendor email editor is no longer available. Open the draft again.");
      const content = smartVendorEmailContent(editor);
      const clipboardMode = await smartVendorWriteClipboard(action === "copy-vendor-email-rich"
        ? { html: content.html, plain: content.plain }
        : { plain: content.plain });
      smartVendorSetEmailStatus(editor, action === "copy-vendor-email-rich" && clipboardMode === "rich"
        ? "Rich email copied. Paste it into Gmail to retain the formatted table."
        : "Plain-text email copied.");
    } else if (action === "open-vendor-gmail") {
      const editor = button.closest("[data-vendor-email-editor]");
      if (!editor) throw new Error("The vendor email editor is no longer available. Open the draft again.");
      const content = smartVendorEmailContent(editor);
      let clipboardError = null;
      let clipboardMode = "";
      const copyPromise = smartVendorWriteClipboard({ html: content.html, plain: content.plain })
        .then((mode) => { clipboardMode = mode; })
        .catch((error) => { clipboardError = error; });
      const gmailParams = new URLSearchParams({ view: "cm", fs: "1", su: content.subject, body: content.plain });
      if (content.to) gmailParams.set("to", content.to);
      const gmailUrl = `https://mail.google.com/mail/?${gmailParams}`;
      window.open(gmailUrl, "_blank", "noopener,noreferrer");
      await copyPromise;
      smartVendorSetEmailStatus(editor, clipboardError
        ? "Gmail opened with the live plain-text body. This browser did not permit rich-table copying."
        : clipboardMode === "rich"
          ? "Gmail opened with the live body; the rich table is also copied if you want to paste it over the plain version."
          : "Gmail opened with the live plain-text body; this browser copied the plain version only.");
    } else if (action === "create-vendor-po") {
      const card = button.closest("[data-vendor-load]");
      const workflowId = Number(button.dataset.workflowId);
      const vendorReply = smartValidateVendorLoadPayload(smartVendorLoadPayload(card));
      if (!confirm("Create this purchase order in NetSuite now? Confirmed lines will be staged from the saved structured vendor decisions; Hold and Cancel quantities remain governed by the vendor-reply workflow.")) return;
      const result = await smartWork("Creating NetSuite purchase order", () => smartApi(`/api/scm/smart/vendor-workflows/${workflowId}/create-purchase-order`, {
        method: "POST",
        body: { vendorReply }
      }), "Purchase order created in NetSuite");
      await smartReloadVendorLoads();
      smartState.notice = `${result.purchaseOrderRef || result.workflow?.netsuitePurchaseOrderRef || "Purchase order"} created. This load remains in Vendor Replies until you move it to PO history.`;
      smartRender();
    } else if (action === "create-blanket-split") {
      const card = button.closest("[data-vendor-load]");
      const workflowId = Number(button.dataset.workflowId);
      const payload = smartValidateVendorLoadPayload(smartVendorLoadPayload(card));
      if (!String(payload.splitPoRef || "").trim()) throw new Error("Enter the split PO reference supplied after the vendor reply.");
      if (!confirm(`Create local split PO ${payload.splitPoRef}? Only confirmed quantities will be released; held quantities stay reserved and cancelled quantities return to the Blanket pool.`)) return;
      const result = await smartWork("Creating Blanket split purchase order", () => smartApi(`/api/scm/smart/vendor-workflows/${workflowId}/create-blanket-split`, {
        method: "POST",
        body: payload
      }), "Blanket split purchase order created");
      await smartReloadVendorLoads();
      const splitRef = result.splitPurchaseOrderRef || result.splitPoRef || result.release?.splitPoRef || payload.splitPoRef;
      smartState.notice = result.workflow?.workflowArchivedAt
        ? `${splitRef} created and moved to Blanket history.`
        : `${splitRef} created. Held Blanket quantity remains in Vendor Replies.`;
      smartRender();
    } else if (action === "archive-vendor-workflow") {
      const workflowId = Number(button.dataset.workflowId);
      if (!confirm("Move this created purchase order to NetSuite PO history? You can restore it to Vendor Replies from history.")) return;
      await smartWork("Moving purchase order to history", () => smartApi(`/api/scm/smart/vendor-workflows/${workflowId}/archive`, {
        method: "PATCH",
        body: { archived: true }
      }), "Purchase order moved to history");
      await smartReloadVendorLoads();
      smartRender();
    } else if (action === "preview-vendor-po") {
      const card = button.closest("[data-vendor-load]");
      smartVendorEmailModalWorkflowId = null;
      smartVendorEmailModalDraft = null;
      smartVendorPoPreview = {
        workflowId: Number(button.dataset.workflowId),
        label: card?.querySelector(".smart-vendor-card-facts span:last-child")?.textContent?.trim() || "NetSuite purchase order"
      };
      smartRender();
    } else if (action === "open-vendor-load") {
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
      const isBlanket = card?.dataset.vendorKind === "blanket_po";
      const proposal = await smartWork("Saving vendor reply draft", () => smartApi(`/api/scm/smart/vendor-reply-loads/${button.dataset.proposalId}`, { method: "PUT", body: payload }), isBlanket ? "Blanket reply draft saved" : "Vendor reply draft saved");
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
    } else if (action === "remove-vendor-load") {
      const proposalId = Number(button.dataset.proposalId);
      const isBlanket = button.closest("[data-vendor-load]")?.dataset.vendorKind === "blanket_po";
      const prompt = isBlanket
        ? `Cancel Blanket release #${proposalId}? Reserved quantities will return to the source PO pool and the audit history will remain.`
        : `Remove load #${proposalId} from Vendor Replies? This cancels the local load and keeps its audit history.`;
      if (!confirm(prompt)) return;
      const removed = await smartWork(
        "Removing vendor reply load",
        () => smartApi(`/api/scm/smart/vendor-reply-loads/${proposalId}`, { method: "DELETE" }),
        `Load #${proposalId} removed from Vendor Replies`
      );
      await smartReloadVendorLoads();
      if (smartState.plan && Number(smartState.plan.id) === Number(removed?.runId)) {
        smartState.plan = await smartApi(`/api/scm/smart/planning-runs/${smartState.plan.id}`);
      }
      smartRender();
    } else if (action === "suggest-vendor-alternatives") {
      await smartLoadVendorAlternativeResults(button.dataset.proposalId, "");
    } else if (action === "add-vendor-alternative") {
      const resultRow = button.closest("[data-vendor-alternative-result]");
      const card = button.closest("[data-vendor-load]");
      const isBlanket = card?.dataset.vendorKind === "blanket_po";
      const quantity = Number(resultRow?.querySelector("[data-vendor-alternative-qty]")?.value || 0);
      const alternativeForLineId = Number(card?.querySelector(`[data-vendor-alternative-for="${button.dataset.proposalId}"]`)?.value || 0);
      const originalLine = card?.querySelector(`[data-vendor-reply-line="${alternativeForLineId}"]`);
      const destinationLocationId = Number(originalLine?.dataset.destinationLocationId || 0);
      const sourceLineId = Number(button.dataset.sourceLineId || 0);
      const remaining = Number(resultRow?.dataset.vendorAlternativeRemaining);
      if (!(quantity > 0)) throw new Error("Enter an alternative quantity above 0 PLT.");
      if (!(alternativeForLineId > 0) || !(destinationLocationId > 0)) throw new Error("Choose the unavailable line and its destination before adding an alternative.");
      if (isBlanket && (!Number.isInteger(quantity) || !(sourceLineId > 0))) {
        throw new Error("Blanket alternatives require a whole-pallet quantity from this source PO.");
      }
      if (isBlanket && Number.isFinite(remaining) && quantity > remaining) {
        throw new Error(`Blanket alternative quantity cannot exceed the ${smartNumber(remaining, 2)} PLT source balance.`);
      }
      await smartWork("Adding alternative item", () => smartApi(`/api/scm/smart/vendor-reply-loads/${button.dataset.proposalId}/lines`, {
        method: "POST",
        body: {
          itemId: Number(button.dataset.itemId),
          sourceLineId: sourceLineId || null,
          destinationLocationId,
          proposedPallets: quantity,
          confirmedPallets: quantity,
          alternativeForLineId,
          source: button.dataset.source
        }
      }), "Alternative item added to the load");
      await smartReloadVendorLoads();
      smartRender();
    } else if (action === "remove-vendor-alternative") {
      if (!confirm("Remove this alternative line from the vendor load?")) return;
      await smartWork("Removing alternative item", () => smartApi(`/api/scm/smart/vendor-reply-loads/${button.dataset.proposalId}/lines/${button.dataset.lineId}`, { method: "DELETE" }), "Alternative item removed");
      await smartReloadVendorLoads();
      smartRender();
    }
  } catch (error) {
    smartState.busy = "";
    smartState.error = error.message;
    smartRender();
  }
});

smartScmApp.addEventListener("change", (event) => {
  const destinationSelect = event.target.closest("[data-vendor-line-destination]");
  if (destinationSelect) {
    const row = destinationSelect.closest("[data-vendor-reply-line]");
    if (row) row.dataset.destinationLocationId = destinationSelect.value;
    return;
  }
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
  if (event.target.matches("[data-vendor-email-field]")) {
    if (smartVendorEmailModalDraft?.workflowId === Number(smartVendorEmailModalWorkflowId)) {
      smartVendorEmailModalDraft[event.target.dataset.vendorEmailField] = event.target.value;
    }
    return;
  }
  if (event.target.matches("[data-vendor-email-code]")) {
    const itemId = Number(event.target.dataset.vendorEmailCode);
    if (smartVendorEmailModalDraft?.workflowId === Number(smartVendorEmailModalWorkflowId)
      && Number.isInteger(itemId) && itemId > 0) {
      smartVendorEmailModalDraft.vendorCodes[String(itemId)] = event.target.value;
    }
    return;
  }
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

window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (smartVendorEmailModalWorkflowId !== null) {
    smartVendorEmailModalWorkflowId = null;
    smartVendorEmailModalDraft = null;
    smartRender();
    return;
  }
  if (smartVendorPoPreview) {
    smartVendorPoPreview = null;
    smartRender();
  }
});
