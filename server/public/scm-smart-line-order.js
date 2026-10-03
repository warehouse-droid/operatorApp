function smartLineOrderEditable(proposal) {
  return smartCanWrite() && !proposal.netsuitePurchaseOrderId && !proposal.netsuitePurchaseOrderRef
    && !proposal.netsuiteTransferOrderId && !proposal.netsuiteTransferOrderRef
    && (["draft", "held", "reviewed", "attention", "order_requested", "vendor_replied"].includes(proposal.status)
      || (proposal.status === "confirmed" && proposal.canCreatePurchaseOrder === true));
}

function smartLineOrderRows(proposal, materialRow, palletRow, editable) {
  const lines = [...(proposal.lines || []), ...(proposal.physicalPalletLines || []).map((line) => ({ ...line, ancillaryPallet: true }))];
  return SmartScmLineOrder.ordered(lines, proposal.lineOrder).map((line, index) => {
    const key = SmartScmLineOrder.key(line);
    const handle = editable ? `<button class="smart-line-drag-handle" data-smart-line-drag draggable="true" type="button" aria-label="Move ${smartEscape(line.itemName || "PALLET")}. Use Up or Down arrow keys." title="Drag to reorder; use Up or Down arrow keys">⠿</button>` : "";
    const html = line.ancillaryPallet ? palletRow(line) : materialRow(line);
    return html.replace(/(<tr\b[^>]*)(>)/, `$1 data-smart-line-order-key="${smartEscape(key)}"$2`)
      .replace("<td>", `<td><span class="smart-line-position">${handle}<span data-smart-line-number aria-label="Line ${index + 1}">${index + 1}</span></span>`);
  }).join("");
}

function smartLineOrderHelp(editable) {
  return `<div class="smart-line-order-help">${editable ? "Drag ⠿ to rearrange lines, including PALLET. This order is used in NetSuite." : "Lines follow the saved order or the synced NetSuite order."} <span data-smart-line-order-message role="status" aria-live="polite"></span></div>`;
}

function smartLineOrderKeys(body) {
  return [...body.querySelectorAll("[data-smart-line-order-key]")].map((row) => row.dataset.smartLineOrderKey);
}

function smartNumberLineOrder(body) {
  body.querySelectorAll("[data-smart-line-number]").forEach((number, index) => {
    number.textContent = String(index + 1);
    number.setAttribute("aria-label", `Line ${index + 1}`);
  });
}

function smartUpdateLineOrderState(proposalId, lineOrder) {
  const collections = [smartState.plan?.proposals, smartState.vendorReplyLoads, smartState.data?.vendorReplyLoads];
  for (const collection of collections) {
    for (const proposal of collection || []) {
      if (Number(proposal.displayProposalId || proposal.id) !== Number(proposalId)) continue;
      proposal.lineOrder = [...lineOrder];
      proposal.lines = SmartScmLineOrder.ordered(proposal.lines || [], lineOrder);
    }
  }
}

function smartReceiveLineOrder({ proposalId, lineOrder }) {
  if (!Array.isArray(lineOrder)) return;
  smartUpdateLineOrderState(proposalId, lineOrder);
  smartScmApp.querySelectorAll("[data-smart-line-order-proposal]").forEach((body) => {
    if (Number(body.dataset.smartLineOrderProposal) !== Number(proposalId) || body.dataset.saving === "true") return;
    const rows = new Map([...body.children].map((row) => [row.dataset.smartLineOrderKey, row]));
    lineOrder.forEach((key) => { if (rows.has(key)) body.append(rows.get(key)); });
    smartNumberLineOrder(body);
  });
}

async function smartSaveLineOrder(body, previousOrder) {
  const lineOrder = smartLineOrderKeys(body);
  if (JSON.stringify(lineOrder) === JSON.stringify(previousOrder)) return;
  const message = body.closest("article")?.querySelector("[data-smart-line-order-message]");
  const proposalId = Number(body.dataset.smartLineOrderProposal);
  body.dataset.saving = "true";
  smartState.busy = "Saving line order";
  if (message) message.textContent = "Saving order…";
  smartNumberLineOrder(body);
  try {
    const result = await smartApi(`/api/scm/smart/proposals/${proposalId}/line-order`, {
      method: "PUT", body: { lineOrder, expectedLineOrder: previousOrder }
    });
    smartUpdateLineOrderState(proposalId, result.lineOrder);
    if (message) message.textContent = "Order saved.";
  } catch (error) {
    const rows = new Map([...body.children].map((row) => [row.dataset.smartLineOrderKey, row]));
    previousOrder.forEach((key) => { if (rows.has(key)) body.append(rows.get(key)); });
    smartNumberLineOrder(body);
    if (message) message.textContent = error.message;
  } finally {
    delete body.dataset.saving;
    if (smartState.busy === "Saving line order") smartState.busy = "";
  }
}

let smartDraggingLine = null;

function smartClearLineDrag() {
  smartScmApp.querySelectorAll(".smart-line-dragging, .smart-line-drop-before, .smart-line-drop-after")
    .forEach((row) => row.classList.remove("smart-line-dragging", "smart-line-drop-before", "smart-line-drop-after"));
  smartDraggingLine = null;
}

smartScmApp.addEventListener("dragstart", (event) => {
  const handle = event.target.closest("[data-smart-line-drag]");
  const row = handle?.closest("[data-smart-line-order-key]");
  if (!row || row.parentElement.dataset.saving === "true" || smartState.busy || !smartCanWrite()) { event.preventDefault(); return; }
  smartDraggingLine = row;
  row.classList.add("smart-line-dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", row.dataset.smartLineOrderKey);
});

smartScmApp.addEventListener("dragover", (event) => {
  const target = event.target.closest("[data-smart-line-order-key]");
  if (!smartDraggingLine || !target || target === smartDraggingLine || target.parentElement !== smartDraggingLine.parentElement) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  const bounds = target.getBoundingClientRect();
  const after = event.clientY > bounds.top + bounds.height / 2;
  smartScmApp.querySelectorAll(".smart-line-drop-before, .smart-line-drop-after")
    .forEach((row) => row.classList.remove("smart-line-drop-before", "smart-line-drop-after"));
  target.classList.add(after ? "smart-line-drop-after" : "smart-line-drop-before");
});

smartScmApp.addEventListener("drop", async (event) => {
  const row = smartDraggingLine;
  const target = event.target.closest("[data-smart-line-order-key]");
  if (!row || !target || row === target || row.parentElement !== target.parentElement) return;
  event.preventDefault();
  const body = row.parentElement;
  const previousOrder = smartLineOrderKeys(body);
  const bounds = target.getBoundingClientRect();
  body.insertBefore(row, event.clientY > bounds.top + bounds.height / 2 ? target.nextElementSibling : target);
  smartClearLineDrag();
  await smartSaveLineOrder(body, previousOrder);
});

smartScmApp.addEventListener("dragend", smartClearLineDrag);

smartScmApp.addEventListener("keydown", async (event) => {
  const handle = event.target.closest("[data-smart-line-drag]");
  if (!handle || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
  event.preventDefault();
  const row = handle.closest("[data-smart-line-order-key]");
  const body = row.parentElement;
  if (body.dataset.saving === "true" || smartState.busy || !smartCanWrite()) return;
  const neighbor = event.key === "ArrowUp" ? row.previousElementSibling : row.nextElementSibling;
  if (!neighbor) return;
  const previousOrder = smartLineOrderKeys(body);
  body.insertBefore(row, event.key === "ArrowUp" ? neighbor : neighbor.nextElementSibling);
  handle.focus({ preventScroll: true });
  await smartSaveLineOrder(body, previousOrder);
});
/* exported smartLineOrderEditable, smartLineOrderRows, smartLineOrderHelp, smartReceiveLineOrder */
