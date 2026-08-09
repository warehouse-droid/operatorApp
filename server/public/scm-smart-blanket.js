const smartBlanketSearchTimers = new Map();
let smartBlanketWorkspaceRequestSequence = 0;

function smartBlanketNumber(value, places = 2) {
  const amount = Number(value);
  return Number.isFinite(amount) ? smartNumber(amount, places) : "—";
}

function smartBlanketRows(workspace, key) {
  return Array.isArray(workspace?.[key]) ? workspace[key] : [];
}

function smartBlanketRef(order = {}) {
  return String(order.orderRef || order.poRef || order.tranid || order.sourcePoRef || "").trim();
}

function smartBlanketRemaining(order = {}) {
  const direct = order.remainingPallets ?? order.remaining_pallets ?? order.totalRemainingPallets;
  if (Number.isFinite(Number(direct))) return Number(direct);
  return (order.lines || []).reduce((sum, line) => sum + Number(
    line.remainingPallets ?? line.availablePallets ?? line.remaining_pallet_qty ?? 0
  ), 0);
}

function smartBlanketYardOptions(selectedLocationId) {
  return [
    { locationId: 1, name: "3445" },
    { locationId: 28, name: "2967" },
    { locationId: 15, name: "12441" },
    { locationId: 26, name: "150" }
  ].map((yard) => `<option value="${yard.locationId}" ${Number(selectedLocationId) === yard.locationId ? "selected" : ""}>${yard.name}</option>`).join("");
}

function smartBlanketOrderCard(order, { candidate = false } = {}) {
  const ref = smartBlanketRef(order);
  const remaining = smartBlanketRemaining(order);
  const releases = Number(order.releaseCount ?? order.release_count ?? 0);
  const canUnflag = order.canUnflag !== false && order.can_unflag !== false;
  const reason = order.unflagBlocker || order.unflag_blocker || "";
  return `<article class="smart-blanket-source ${candidate ? "candidate" : "active"}" data-blanket-source="${smartEscape(ref)}">
    <div class="smart-blanket-source-head"><div><strong>${smartEscape(ref || "PO")}</strong><span>${smartEscape(order.vendor || "Unknown vendor")}</span></div>${smartPill(candidate ? "available" : "blanket", candidate ? "Open PO" : "Blanket")}</div>
    <div class="smart-blanket-source-meta"><span>${smartDate(order.transactionDate || order.trandate || order.orderDate)}</span><span>${smartBlanketNumber(remaining)} PLT remaining</span>${candidate ? "" : `<span>${releases} release${releases === 1 ? "" : "s"}</span>`}</div>
    ${(order.lines || []).length ? `<div class="smart-blanket-source-items">${(order.lines || []).slice(0, 4).map((line) => `<span title="${smartEscape(line.description || line.itemDescription || "")}">${smartEscape(line.itemName || line.item_name || line.itemId)} · ${smartBlanketNumber(line.remainingPallets ?? line.availablePallets ?? 0)} PLT</span>`).join("")}${order.lines.length > 4 ? `<span>+${order.lines.length - 4} more</span>` : ""}</div>` : ""}
    ${smartCanWrite() ? `<button class="smart-button ${candidate ? "primary" : "danger"}" data-smart-action="${candidate ? "flag-blanket-po" : "unflag-blanket-po"}" data-po-ref="${smartEscape(ref)}" type="button" ${!candidate && !canUnflag ? "disabled" : ""}>${candidate ? "Flag as Blanket" : "Remove flag"}</button>` : ""}
    ${!candidate && reason ? `<small class="smart-blanket-blocker">${smartEscape(reason)}</small>` : ""}
  </article>`;
}

function smartBlanketProposalLineSourceRemaining(proposal = {}, line = {}, sourceOrder = {}, allProposals = []) {
  const compatibleLines = (sourceOrder.lines || []).filter((row) => Number(row.itemId) === Number(line.itemId)
    && Math.abs(Number(row.toPlt || 0) - Number(line.toPlt || 0)) < 0.000001);
  if (!compatibleLines.length) return undefined;
  const sourceLineIds = new Set(compatibleLines.map((row) => Number(row.sourceLineId)).filter(Number.isInteger));
  const physicalRemaining = compatibleLines.reduce((sum, row) => sum + Number(row.remainingPallets ?? row.availablePallets ?? 0), 0);
  const plannedElsewhere = allProposals.flatMap((candidate) => candidate.blanketAllocations || [])
    .filter((allocation) => allocation.status === "planned"
      && sourceLineIds.has(Number(allocation.sourceLineId))
      && Number(allocation.proposalLineId) !== Number(line.id))
    .reduce((sum, allocation) => sum + Number(allocation.plannedPallets || 0), 0);
  return Math.max(0, physicalRemaining - plannedElsewhere);
}

function smartBlanketProposalLine(proposal = {}, line = {}, sourceRemaining = undefined, editable = false) {
  const urgencyLevel = typeof smartLineUrgencyLevel === "function"
    ? smartLineUrgencyLevel(line)
    : String(line.urgencyLevel || (line.urgent ? "urgent" : "normal"));
  const urgencyLabel = typeof smartUrgencyLabel === "function"
    ? smartUrgencyLabel(urgencyLevel)
    : urgencyLevel.replaceAll("_", " ");
  const destinationAvailable = typeof smartProposalDestinationAvailablePallets === "function"
    ? smartProposalDestinationAvailablePallets(line)
    : line.reason?.destinationAvailablePallets;
  const destinationExpected = typeof smartProposalExpectedInventoryPallets === "function"
    ? smartProposalExpectedInventoryPallets(line)
    : line.reason?.destinationExpectedAvailablePallets;
  return `<tr class="smart-urgency-${smartEscape(urgencyLevel)}" data-smart-urgency="${smartEscape(urgencyLevel)}" data-smart-blanket-line="${smartEscape(line.id)}" aria-label="${smartEscape(line.itemName || line.itemId)}. ${smartEscape(urgencyLabel)} urgency.">
    <td><strong>${smartEscape(line.itemName || line.itemId)}</strong><span class="smart-sr-only">${smartEscape(urgencyLabel)} urgency.</span></td>
    <td>${editable ? `<select class="smart-line-destination-select" data-smart-blanket-destination data-smart-focus-key="blanket-proposal:${smartEscape(proposal.id)}:line:${smartEscape(line.id)}:destination" aria-label="Blanket line destination yard">${smartBlanketYardOptions(line.destinationLocationId || proposal.destinationLocationId)}</select>` : `<strong>${smartEscape(line.destinationName || proposal.destinationName || "—")}</strong>`}</td>
    <td class="numeric">${smartBlanketNumber(line.requiredPallets)} PLT</td>
    <td>${editable ? `<div class="smart-line-quantity smart-blanket-line-quantity"><input data-smart-blanket-pallets data-smart-focus-key="blanket-proposal:${smartEscape(proposal.id)}:line:${smartEscape(line.id)}:pallets" type="number" min="1" step="1" value="${smartEscape(Math.max(1, Math.round(Number(line.proposedPallets) || 1)))}" /><span>PLT</span><button class="smart-button" data-smart-action="save-blanket-proposal-line" data-proposal-id="${smartEscape(proposal.id)}" data-line-id="${smartEscape(line.id)}" type="button">Save</button><button class="smart-button" data-smart-action="split-blanket-proposal-line" data-proposal-id="${smartEscape(proposal.id)}" data-line-id="${smartEscape(line.id)}" data-current-pallets="${smartEscape(line.proposedPallets)}" type="button">Split to load</button><button class="smart-button danger" data-smart-action="remove-blanket-proposal-line" data-proposal-id="${smartEscape(proposal.id)}" data-line-id="${smartEscape(line.id)}" type="button">Remove</button></div>` : `<strong>${smartBlanketNumber(line.proposedPallets, 0)} PLT</strong>`}</td>
    <td class="numeric">${smartBlanketNumber(line.salesQuantity, 3)} ${smartEscape(line.unit || "")}</td>
    <td class="numeric">${smartBlanketNumber(line.lineWeightLbs, 0)} lb</td>
    <td><div class="smart-availability-summary smart-availability-inline smart-blanket-availability">
      <span><small>Source available</small><strong>${sourceRemaining === undefined ? "—" : `${smartBlanketNumber(sourceRemaining)} PLT`}</strong></span>
      <span><small>${smartEscape(line.destinationName || proposal.destinationName || "Destination")} available</small><strong>${destinationAvailable === null || destinationAvailable === undefined ? "—" : `${smartBlanketNumber(destinationAvailable)} PLT`}</strong></span>
      <span><small>Expected</small><strong>${destinationExpected === null || destinationExpected === undefined ? "—" : `${smartBlanketNumber(destinationExpected)} PLT`}</strong></span>
    </div></td>
  </tr>`;
}

function smartBlanketPhysicalPalletLine(proposal = {}, line = {}, editable = false) {
  const quantity = Number(line.quantity ?? line.salesQuantity ?? 0);
  const automaticQuantity = Number(line.automaticQuantity ?? quantity);
  const unit = line.unit || "EACH";
  const itemWeight = Number(line.itemWeightLbs || 0);
  return `<tr class="smart-physical-pallet-line" data-smart-physical-pallet-line="${smartEscape(line.id)}">
    <td><strong>${smartEscape(line.itemName || "PALLET")}</strong><div class="smart-help">Official ancillary PALLET item</div></td>
    <td><strong>${smartEscape(line.destinationName || "—")}</strong></td>
    <td class="numeric">${smartBlanketNumber(automaticQuantity, 2)} ${smartEscape(unit)}<div class="smart-help">Automatic from material PLT</div></td>
    <td>${editable ? `<div class="smart-line-quantity smart-blanket-line-quantity"><input data-smart-pallet-quantity data-smart-focus-key="blanket-proposal:${smartEscape(proposal.id)}:pallet-destination:${smartEscape(line.destinationLocationId)}:quantity" type="number" min="0" step="0.01" value="${smartEscape(quantity)}" aria-label="Official PALLET quantity for ${smartEscape(line.destinationName || "destination")}" /><span>${smartEscape(unit)}</span><button class="smart-button" data-smart-action="save-blanket-pallet-line" data-proposal-id="${smartEscape(proposal.id)}" data-destination-location-id="${smartEscape(line.destinationLocationId)}" type="button">Save</button>${line.overridden ? `<button class="smart-button" data-smart-action="reset-blanket-pallet-line" data-proposal-id="${smartEscape(proposal.id)}" data-destination-location-id="${smartEscape(line.destinationLocationId)}" type="button">Reset auto</button>` : ""}</div>` : `<strong>${smartBlanketNumber(quantity, 2)} ${smartEscape(unit)}</strong><div class="smart-help">${line.overridden ? "Manual override" : "Automatic"}</div>`}</td>
    <td class="numeric">${smartBlanketNumber(quantity, 2)} ${smartEscape(unit)}</td>
    <td class="numeric">${itemWeight > 0 ? `${smartBlanketNumber(line.lineWeightLbs, 0)} lb` : "—"}</td>
    <td><span class="smart-help">Packaging weight included in this load; it does not add material PLT.</span></td>
  </tr>`;
}

function smartBlanketProposalCard(proposal = {}, sourceOrdersByRef = new Map(), allProposals = []) {
  const sourceRef = proposal.blanketSourcePoRef || proposal.blanket_source_po_ref || proposal.sourcePoRef || proposal.source_po_ref || proposal.sourceRef || "—";
  const sourceOrder = sourceOrdersByRef.get(String(sourceRef).toLowerCase()) || {};
  const urgencyLevel = typeof smartProposalUrgencyLevel === "function"
    ? smartProposalUrgencyLevel(proposal)
    : String(proposal.urgencyLevel || (proposal.urgent ? "urgent" : "normal"));
  const urgencyLabel = typeof smartUrgencyLabel === "function"
    ? smartUrgencyLabel(urgencyLevel)
    : urgencyLevel.replaceAll("_", " ");
  const overCapacity = Number(proposal.utilization) > 1.000001;
  const allocations = proposal.blanketAllocations || [];
  const editable = smartCanWrite() && String(proposal.status) === "held"
    && allocations.length > 0 && allocations.every((row) => row.status === "planned");
  const reservable = editable;
  const route = typeof smartProposalRoute === "function"
    ? smartProposalRoute(proposal)
    : [proposal.vendor || proposal.sourceName || "Vendor", proposal.destinationName].filter(Boolean).join(" → ");
  return `<article class="smart-proposal smart-blanket-proposal" data-blanket-proposal="${smartEscape(proposal.id)}" data-smart-urgency="${smartEscape(urgencyLevel)}">
    <div class="smart-proposal-head">
      <div class="smart-proposal-identity"><strong class="smart-proposal-type">BLANKET</strong><div class="smart-proposal-badges">${smartPill(proposal.status || "held")}${urgencyLevel !== "normal" ? smartPill("attention", urgencyLabel) : ""}${overCapacity ? smartPill("attention", "Over capacity · manual") : ""}</div></div>
      <div class="smart-proposal-route"><strong>${smartEscape(route || sourceRef)}</strong><span>#${smartEscape(proposal.id)} · exact oldest-source allocation</span></div>
      <div class="smart-proposal-metric"><strong>${smartBlanketNumber(proposal.totalPallets, 0)} PLT</strong><span>Pallets</span></div>
      <div class="smart-proposal-metric"><strong>${smartBlanketNumber(proposal.totalWeightLbs, 0)} lb</strong><span>${smartPercent(proposal.utilization, 0)} truck</span></div>
      <div class="smart-proposal-metric"><strong>${smartEscape(sourceRef)}</strong><span>Source PO</span></div>
      <div class="smart-actions">${reservable ? `<button class="smart-button primary" data-smart-action="confirm-blanket-proposal" data-proposal-id="${smartEscape(proposal.id)}" type="button">Confirm release</button>` : ""}</div>
    </div>
    <div class="smart-proposal-lines smart-table-wrap smart-proposal-lines-compact smart-blanket-proposal-lines"><table class="smart-table"><thead><tr><th>Item</th><th>Destination</th><th class="numeric">Required</th><th>Proposed</th><th class="numeric">Sales qty</th><th class="numeric">Weight</th><th>Availability</th></tr></thead><tbody>${(proposal.lines || []).map((line) => smartBlanketProposalLine(proposal, line, smartBlanketProposalLineSourceRemaining(proposal, line, sourceOrder, allProposals), editable)).join("")}${(proposal.physicalPalletLines || []).map((line) => smartBlanketPhysicalPalletLine(proposal, line, editable)).join("")}</tbody></table></div>
  </article>`;
}

function smartBlanketReleaseRow(release = {}, sourceOrdersByRef = new Map()) {
  const ref = release.splitPoRef || release.split_po_ref || release.reservationRef || `#${release.id}`;
  const status = release.status || release.releaseStatus || "reserved";
  const allocations = release.allocations || [];
  const destinations = [...new Set(allocations.map((line) => line.destinationName).filter(Boolean))].join(" → ")
    || (release.routeStops || release.route_stops || []).map((stop) => stop.name || stop.destinationName).filter(Boolean).join(" → ")
    || release.destinationName || "—";
  const totalPallets = release.totalPallets ?? release.reservedPallets ?? allocations.reduce((sum, line) => sum + Number(
    line.plannedPallets ?? line.reservedPallets ?? line.releasedPallets ?? line.heldPallets ?? line.cancelledPallets ?? 0
  ), 0);
  const sourceRef = release.sourcePoRef || release.source_po_ref || "";
  const source = sourceOrdersByRef.get(String(sourceRef).toLowerCase()) || {};
  return `<tr><td><strong>${smartEscape(ref)}</strong><span class="smart-help">Source ${smartEscape(sourceRef || "—")}</span></td><td>${smartPill(status)}</td><td>${smartEscape(release.vendor || release.sourceName || source.vendor || source.pickupPoint || "—")}</td><td>${smartEscape(destinations)}</td><td class="numeric">${smartBlanketNumber(totalPallets)} PLT</td><td>${smartDate(release.finalizedAt || release.updatedAt || release.reservedAt || release.createdAt, true)}</td></tr>`;
}

function smartBlanketSortedProposals(proposals = []) {
  const urgencyOrder = new Map([["normal", 0], ["urgent", 1], ["super_urgent", 2], ["ultimate_urgent", 3]]);
  const yardOrder = new Map([["3445", 0], ["12441", 1], ["2967", 2], ["150", 3]]);
  const level = (proposal) => typeof smartProposalUrgencyLevel === "function"
    ? smartProposalUrgencyLevel(proposal)
    : String(proposal.urgencyLevel || (proposal.urgent ? "urgent" : "normal"));
  const destinationRank = (proposal) => {
    const names = (proposal.routeStops || []).map((stop) => String(stop.name || stop.destinationName || ""));
    if (!names.length) names.push(String(proposal.destinationName || ""));
    return Math.min(...names.map((name) => yardOrder.get(name) ?? yardOrder.size));
  };
  return [...proposals].sort((left, right) => (urgencyOrder.get(level(right)) || 0) - (urgencyOrder.get(level(left)) || 0)
    || destinationRank(left) - destinationRank(right)
    || Number(left.id) - Number(right.id));
}

function smartBlanketSidebarTab() {
  return smartState.blanketSidebarTab === "normal" ? "normal" : "blanket";
}

function smartBlanketSidebarTabButton({ tab, label, count, panelId }) {
  const selected = smartBlanketSidebarTab() === tab;
  const tabId = tab === "blanket" ? "smartBlanketPoTab" : "smartNormalPoTab";
  const countLabel = tab === "normal" ? `showing ${count}` : `${count} active`;
  return `<button id="${tabId}" class="${selected ? "active" : ""}" data-smart-action="set-blanket-sidebar-tab" data-smart-blanket-sidebar-tab="${tab}" type="button" role="tab" aria-selected="${selected ? "true" : "false"}" aria-controls="${panelId}" aria-label="${smartEscape(`${label}, ${countLabel}`)}" tabindex="${selected ? "0" : "-1"}"><span>${smartEscape(label)}</span><strong aria-hidden="true">${smartEscape(count)}</strong></button>`;
}

function smartBlanketOrders() {
  const workspace = smartState.blanketWorkspace || {};
  const sources = smartBlanketRows(workspace, "blanketOrders");
  const candidates = smartBlanketRows(workspace, "candidates");
  const proposals = smartBlanketSortedProposals(smartBlanketRows(workspace, "proposals"));
  const releases = smartBlanketRows(workspace, "releases");
  const latestRun = workspace.latestRun || workspace.plan || null;
  const sidebarTab = smartBlanketSidebarTab();
  const sourceOrdersByRef = new Map(sources.map((source) => [smartBlanketRef(source).toLowerCase(), source]));
  return `<section class="smart-section smart-blanket-section">
    <div class="smart-section-head"><div><h2>Blanket orders</h2><p>Reserve current Smart SCM demand from open blanket balances. Sources are consumed oldest first; regular vendor PO proposals remain paused while blanket quantity is available, but TO planning remains active.</p></div><div class="smart-actions">${smartCanWrite() ? `<button class="smart-button primary" data-smart-action="build-blanket-plan" type="button">Calculate releases</button>` : ""}<button class="smart-button" data-smart-action="refresh-blanket-workspace" type="button">Refresh</button></div></div>
    <div class="smart-blanket-workspace">
      <aside class="smart-blanket-sidebar" aria-label="Purchase order pools">
        <div class="smart-blanket-sidebar-tabs" role="tablist" aria-label="Purchase order type">
          ${smartBlanketSidebarTabButton({ tab: "blanket", label: "Blanket PO", count: sources.length, panelId: "smartBlanketPoPanel" })}
          ${smartBlanketSidebarTabButton({ tab: "normal", label: "Normal PO", count: candidates.length, panelId: "smartNormalPoPanel" })}
        </div>
        <section id="smartBlanketPoPanel" class="smart-blanket-sidebar-panel" role="tabpanel" aria-labelledby="smartBlanketPoTab" ${sidebarTab === "blanket" ? "" : "hidden"}>
          <div class="smart-blanket-sidebar-head"><div><strong>Current blanket orders</strong><span>${sources.length} active source${sources.length === 1 ? "" : "s"}</span></div></div>
          <div class="smart-blanket-source-list">${sources.map((source) => smartBlanketOrderCard(source)).join("") || `<div class="smart-empty smart-empty-compact">No open PO is flagged as a blanket source.</div>`}</div>
        </section>
        <section id="smartNormalPoPanel" class="smart-blanket-sidebar-panel normal" role="tabpanel" aria-labelledby="smartNormalPoTab" ${sidebarTab === "normal" ? "" : "hidden"}>
          <div class="smart-blanket-sidebar-head"><div><strong>Normal purchase orders</strong><span>Showing ${candidates.length} open source${candidates.length === 1 ? "" : "s"}</span></div></div>
          <div class="smart-blanket-search"><label><span>Find an open source PO</span><input id="smartBlanketSearch" type="search" value="${smartEscape(smartState.blanketSearch || "")}" placeholder="PO ref, vendor, or item" autocomplete="off" /></label><small>Completed POs and existing split children are excluded.</small></div>
          <div class="smart-blanket-source-list candidates">${candidates.map((source) => smartBlanketOrderCard(source, { candidate: true })).join("") || `<div class="smart-empty smart-empty-compact">${smartState.blanketSearch ? "No open source PO matches this search." : "No eligible normal PO is available."}</div>`}</div>
        </section>
      </aside>
      <div class="smart-blanket-results">
        <div class="smart-blanket-results-head"><div><strong>Pooled release proposals</strong><span>${latestRun ? `Run #${smartEscape(latestRun.id)} · ${smartDate(latestRun.completedAt || latestRun.createdAt, true)}` : "Calculate after flagging source POs"}</span></div><div><strong>${proposals.length}</strong><span>load${proposals.length === 1 ? "" : "s"}</span></div></div>
        ${typeof smartUrgencyLegend === "function" ? smartUrgencyLegend() : ""}
        ${workspace.warning ? `<div class="smart-notice warn">${smartEscape(workspace.warning)}</div>` : ""}
        <div class="smart-blanket-proposals">${proposals.map((proposal) => smartBlanketProposalCard(proposal, sourceOrdersByRef, proposals)).join("") || `<div class="smart-empty">No blanket release is currently required. Refresh inventory or calculate again after demand changes.</div>`}</div>
        <section class="smart-blanket-history"><div class="smart-blanket-results-head"><div><strong>Blanket release history</strong><span>Reservations, finalized local splits, holds, and cancellations</span></div><strong>${releases.length}</strong></div><div class="smart-table-wrap"><table class="smart-table"><thead><tr><th>Split / reservation</th><th>Status</th><th>Vendor</th><th>Destinations</th><th class="numeric">PLT</th><th>Updated</th></tr></thead><tbody>${releases.map((release) => smartBlanketReleaseRow(release, sourceOrdersByRef)).join("") || `<tr><td colspan="6" class="smart-empty">No blanket release history yet.</td></tr>`}</tbody></table></div></section>
      </div>
    </div>
  </section>`;
}

async function smartLoadBlanketWorkspace({ quiet = false } = {}) {
  const requestSequence = ++smartBlanketWorkspaceRequestSequence;
  if (!quiet) {
    smartState.busy = "Loading blanket orders";
    smartRender();
  }
  const params = new URLSearchParams({ search: smartState.blanketSearch || "", limit: "200" });
  try {
    const workspace = await smartApi(`/api/scm/smart/blanket-orders?${params}`);
    if (requestSequence === smartBlanketWorkspaceRequestSequence) smartState.blanketWorkspace = workspace;
  } catch (error) {
    if (requestSequence === smartBlanketWorkspaceRequestSequence) throw error;
  } finally {
    if (requestSequence === smartBlanketWorkspaceRequestSequence) {
      if (!quiet || smartState.busy === "Loading blanket orders") smartState.busy = "";
      smartRender();
    }
  }
  return smartState.blanketWorkspace;
}

smartScmApp.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-smart-action]");
  if (!button || smartState.busy) return;
  const action = button.dataset.smartAction;
  if (!["set-blanket-sidebar-tab", "refresh-blanket-workspace", "build-blanket-plan", "flag-blanket-po", "unflag-blanket-po", "save-blanket-proposal-line", "split-blanket-proposal-line", "remove-blanket-proposal-line", "save-blanket-pallet-line", "reset-blanket-pallet-line", "confirm-blanket-proposal"].includes(action)) return;
  try {
    if (action === "set-blanket-sidebar-tab") {
      const selectedTab = button.dataset.smartBlanketSidebarTab;
      if (!["blanket", "normal"].includes(selectedTab)) return;
      smartState.blanketSidebarTab = selectedTab;
      smartRender();
      requestAnimationFrame(() => document.querySelector(`[data-smart-blanket-sidebar-tab="${selectedTab}"]`)?.focus());
      return;
    }
    if (action === "refresh-blanket-workspace") {
      await smartLoadBlanketWorkspace();
      if (typeof smartRefreshPlanningExclusions === "function") await smartRefreshPlanningExclusions();
      return;
    }
    if (action === "build-blanket-plan") {
      await smartWork("Calculating blanket releases", () => smartApi("/api/scm/smart/blanket-plans", { method: "POST", body: {} }), "Blanket release proposals recalculated");
      await smartLoadBlanketWorkspace({ quiet: true });
      if (typeof smartRefreshPlanningExclusions === "function") await smartRefreshPlanningExclusions();
      return;
    }
    if (["flag-blanket-po", "unflag-blanket-po"].includes(action)) {
      const poRef = button.dataset.poRef;
      const isBlanket = action === "flag-blanket-po";
      if (!isBlanket && !confirm(`Remove ${poRef} from the blanket pool? This is allowed only when it has no pending or active release.`)) return;
      await smartWork(isBlanket ? "Adding blanket source" : "Removing blanket source", () => smartApi(`/api/scm/purchase-orders/${encodeURIComponent(poRef)}/blanket`, { method: "PUT", body: { isBlanket } }), isBlanket ? `${poRef} added to the blanket pool` : `${poRef} removed from the blanket pool`);
      await smartLoadBlanketWorkspace({ quiet: true });
      if (typeof smartRefreshPlanningExclusions === "function") await smartRefreshPlanningExclusions();
      return;
    }
    if (action === "save-blanket-proposal-line") {
      const row = button.closest("[data-smart-blanket-line]");
      const proposalId = Number(button.dataset.proposalId);
      const lineId = Number(button.dataset.lineId);
      const proposedPallets = Number(row?.querySelector("[data-smart-blanket-pallets]")?.value);
      const destinationLocationId = Number(row?.querySelector("[data-smart-blanket-destination]")?.value);
      if (!Number.isInteger(proposedPallets) || proposedPallets <= 0) throw new Error("Blanket release quantity must be a positive whole number of pallets.");
      if (!Number.isInteger(destinationLocationId) || destinationLocationId <= 0) throw new Error("Select a valid destination yard.");
      await smartWork("Saving Blanket release line", () => smartApi(`/api/scm/smart/blanket-proposals/${proposalId}/lines/${lineId}`, {
        method: "PATCH",
        body: { proposedPallets, destinationLocationId }
      }), "Blanket release line saved with exact source allocation");
      await smartLoadBlanketWorkspace({ quiet: true });
      if (typeof smartRefreshPlanningExclusions === "function") await smartRefreshPlanningExclusions();
      return;
    }
    if (action === "split-blanket-proposal-line") {
      const proposalId = Number(button.dataset.proposalId);
      const lineId = Number(button.dataset.lineId);
      const currentPallets = Number(button.dataset.currentPallets);
      if (!confirm(`Move this entire ${smartBlanketNumber(currentPallets, 0)}-PLT item line into its own held Blanket load?`)) return;
      await smartWork("Moving Blanket proposal line", () => smartApi(`/api/scm/smart/blanket-proposals/${proposalId}/lines/${lineId}/split`, {
        method: "POST",
        body: {}
      }), "Blanket item line moved into a separate held load");
      await smartLoadBlanketWorkspace({ quiet: true });
      if (typeof smartRefreshPlanningExclusions === "function") await smartRefreshPlanningExclusions();
      return;
    }
    if (action === "remove-blanket-proposal-line") {
      const proposalId = Number(button.dataset.proposalId);
      const lineId = Number(button.dataset.lineId);
      if (!confirm("Remove this item line and release its planned Blanket source quantity?")) return;
      await smartWork("Removing Blanket proposal line", () => smartApi(`/api/scm/smart/blanket-proposals/${proposalId}/lines/${lineId}`, {
        method: "DELETE"
      }), "Blanket item line removed and source quantity released");
      await smartLoadBlanketWorkspace({ quiet: true });
      if (typeof smartRefreshPlanningExclusions === "function") await smartRefreshPlanningExclusions();
      return;
    }
    if (action === "save-blanket-pallet-line" || action === "reset-blanket-pallet-line") {
      const row = button.closest("[data-smart-physical-pallet-line]");
      const proposalId = Number(button.dataset.proposalId);
      const destinationLocationId = Number(button.dataset.destinationLocationId);
      const reset = action === "reset-blanket-pallet-line";
      const rawQuantity = row?.querySelector("[data-smart-pallet-quantity]")?.value?.trim() ?? "";
      if (!reset && rawQuantity === "") throw new Error("Enter a PALLET quantity, or use Reset auto.");
      const quantity = Number(rawQuantity);
      if (!reset && (!Number.isFinite(quantity) || quantity < 0)) throw new Error("PALLET quantity must be zero or greater.");
      await smartWork(reset ? "Resetting Blanket PALLET quantity" : "Saving Blanket PALLET quantity", () => smartApi(`/api/scm/smart/proposals/${proposalId}/pallets/${destinationLocationId}`, {
        method: "PATCH",
        body: reset ? { reset: true } : { quantity }
      }), reset ? "Blanket PALLET quantity returned to Automatic" : "Blanket PALLET quantity override saved");
      await smartLoadBlanketWorkspace({ quiet: true });
      return;
    }
    if (action === "confirm-blanket-proposal") {
      if (!confirm("Reserve this load from its blanket source and send it to Vendor Replies? Source quantities will be locked until the vendor decision is finalized or cancelled.")) return;
      const proposalId = Number(button.dataset.proposalId);
      await smartWork("Reserving blanket quantities", () => smartApi(`/api/scm/smart/blanket-proposals/${proposalId}/confirm`, { method: "POST", body: {} }), `Blanket proposal #${proposalId} moved to Vendor Replies`);
      await smartLoadBlanketWorkspace({ quiet: true });
      if (typeof smartRefreshPlanningExclusions === "function") await smartRefreshPlanningExclusions();
      if (typeof smartReloadVendorLoads === "function") await smartReloadVendorLoads();
      smartState.tab = "vendors";
      smartRender();
      setTimeout(() => document.querySelector(`[data-vendor-load="${proposalId}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
    }
  } catch (error) {
    smartState.busy = "";
    smartState.error = error.message;
    smartRender();
  }
});

smartScmApp.addEventListener("keydown", (event) => {
  const currentTab = event.target.closest("[data-smart-blanket-sidebar-tab]");
  if (!currentTab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = [...smartScmApp.querySelectorAll("[data-smart-blanket-sidebar-tab]")];
  const currentIndex = tabs.indexOf(currentTab);
  if (currentIndex < 0 || !tabs.length) return;
  event.preventDefault();
  let nextIndex = currentIndex;
  if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = tabs.length - 1;
  else nextIndex = (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  tabs[nextIndex]?.click();
});

smartScmApp.addEventListener("input", (event) => {
  if (event.target.id !== "smartBlanketSearch") return;
  smartState.blanketSearch = event.target.value;
  clearTimeout(smartBlanketSearchTimers.get("source"));
  smartBlanketSearchTimers.set("source", setTimeout(async () => {
    try {
      await smartLoadBlanketWorkspace({ quiet: true });
    } catch (error) {
      smartState.error = error.message;
      smartRender();
    }
  }, 300));
});
