import assert from "node:assert/strict";
import fs from "node:fs";

const publicUrl = new URL("../public/", import.meta.url);
const readPublic = (name) => fs.readFileSync(new URL(name, publicUrl), "utf8");

const core = readPublic("scm-smart.js");
const blanket = readPublic("scm-smart-blanket.js");
const blanketCss = readPublic("scm-smart-blanket.css");
const exclusions = readPublic("scm-smart-exclusions.js");
const exclusionsCss = readPublic("scm-smart-exclusions.css");
const proposalEditor = fs.readFileSync(new URL("smart-scm-proposal-editor.js", import.meta.url), "utf8");
const blanketRepository = fs.readFileSync(new URL("smart-scm-blanket-repository.js", import.meta.url), "utf8");
const vendor = readPublic("scm-smart-vendor.js");
const vendorCss = readPublic("scm-smart-vendor.css");
const sidebar = readPublic("app-sidebar.js");
const html = readPublic("scm-smart.html");

assert.match(core, /\["blankets",\s*"Blanket order"\]/,
  "Smart SCM must expose the Blanket order tab.");
assert.match(blanket, /smart-blanket-workspace/);
assert.match(blanket, /smart-blanket-sidebar/);
assert.match(core, /blanketSidebarTab: "blanket"/,
  "The Blanket sidebar must default to the current Blanket PO pool.");
assert.match(blanket, /role="tablist" aria-label="Purchase order type"/);
assert.match(blanket, /data-smart-blanket-sidebar-tab="\$\{tab\}"[^>]*role="tab"[^>]*aria-selected=/,
  "Blanket and Normal PO controls must expose accessible tab state.");
assert.match(blanket, /id="smartBlanketPoPanel"[^>]*role="tabpanel"[^>]*aria-labelledby="smartBlanketPoTab"/);
assert.match(blanket, /id="smartNormalPoPanel"[^>]*role="tabpanel"[^>]*aria-labelledby="smartNormalPoTab"/);
assert.match(blanket, /set-blanket-sidebar-tab/);
assert.match(blanket, /smartState\.blanketSidebarTab = selectedTab/);
assert.match(blanket, /\["ArrowLeft", "ArrowRight", "Home", "End"\]/,
  "The sidebar tabs must support standard keyboard navigation.");
assert.match(blanket, /Find an open source PO/);
assert.match(blanket, /flag-blanket-po/);
assert.match(blanket, /data-smart-action="confirm-blanket-proposal"/);
assert.match(blanket, /Source available/);
assert.match(blanket, /smartBlanketProposalLineSourceRemaining/,
  "Proposal rows must resolve their source-line balance from Blanket allocations.");
assert.match(blanket, /smart-proposal-lines-compact/,
  "Blanket releases must always use the compact proposal table.");
assert.match(blanket, /smart-urgency-\$\{smartEscape\(urgencyLevel\)\}/,
  "Blanket proposal lines must use the same urgency background classes as PO\/TO proposals.");
assert.match(blanket, /data-smart-blanket-destination/);
assert.match(blanket, /data-smart-blanket-pallets[^>]*step="1"/);
assert.match(blanket, /data-smart-action="save-blanket-proposal-line"/);
assert.match(blanket, /overCapacity \? smartPill\("attention", "Over capacity · manual"\)/,
  "A manually overloaded Blanket release must remain visibly flagged.");
const blanketLineRenderer = blanket.slice(
  blanket.indexOf("function smartBlanketProposalLine("),
  blanket.indexOf("function smartBlanketProposalCard(")
);
assert.doesNotMatch(blanketLineRenderer, /itemDescription|item_description/,
  "Compact Blanket proposal rows must not render item descriptions.");
assert.match(blanket, /smartBlanketWorkspaceRequestSequence/,
  "Overlapping Blanket searches must ignore stale responses.");
assert.match(blanket, /smartState\.tab = "vendors"/,
  "Confirmed Blanket proposals must move directly into Vendor Replies.");
assert.match(blanket, /typeof smartReloadVendorLoads === "function"/);
assert.match(blanketCss, /grid-template-columns: minmax\(285px, 330px\) minmax\(0, 1fr\)/);
assert.match(blanketCss, /min-height: max\(620px, calc\(100dvh/,
  "The desktop Blanket workspace must use the available viewport height.");
assert.match(blanketCss, /\.smart-blanket-sidebar\s*\{[\s\S]*?grid-template-rows: auto minmax\(0, 1fr\)/,
  "The active Blanket sidebar tab must fill the available workspace height.");
assert.match(blanketCss, /\.smart-blanket-sidebar-tabs\s*\{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
assert.match(blanketCss, /\.smart-blanket-sidebar-panel\s*\{[\s\S]*?min-height: 0/);
assert.match(blanketCss, /\.smart-blanket-sidebar-panel\[hidden\]\s*\{\s*display: none;/,
  "Inactive PO pools must not consume sidebar space.");
assert.match(blanketCss, /\.smart-blanket-source-list\s*\{[\s\S]*?min-height: 0;[\s\S]*?max-height: none;[\s\S]*?overflow: auto;/,
  "Blanket source lists must scroll within uncapped flexible tracks.");
assert.match(blanketCss, /@media \(max-width: 1000px\)[\s\S]*grid-template-columns: 1fr/,
  "The two-pane workspace must collapse for small screens.");
assert.match(blanketCss, /@media \(max-width: 1000px\)[\s\S]*min-height: 0;[\s\S]*grid-template-rows: auto auto/,
  "Stacked Blanket layouts must reset desktop viewport sizing.");

assert.match(exclusions, /Automatic — Blanket balance/);
assert.match(exclusions, /Blanket PO covered/);
assert.match(exclusions, /Vendor PO planning paused/);
assert.match(exclusions, /TO remains available/);
assert.match(exclusions, /combinedActiveCount/);
assert.match(exclusionsCss, /smart-planning-exclusion-row-automatic/);
assert.match(proposalEditor, /proposal\.proposal_origin === "blanket"[\s\S]*must be edited from the Blanket order tab/,
  "The generic PO\/TO editor must reject Blanket lines.");
assert.match(blanketRepository, /DELETE FROM scm_smart_blanket_allocations[\s\S]*status = 'planned'/);
assert.match(blanketRepository, /INSERT INTO scm_smart_blanket_allocations/);
assert.match(blanketRepository, /UPDATE scm_smart_proposal_lines/,
  "Blanket line edits must update both proposal data and exact source allocations transactionally.");

assert.match(vendor, /data-vendor-kind="\$\{isBlanket \? "blanket_po" : "regular_po"\}"/);
assert.match(vendor, /Show source balance/);
assert.match(vendor, /Blanket alternatives require a whole-pallet quantity/);
assert.match(vendor, /workflowStatus === "split_pending"[\s\S]*return "hold"/,
  "A reopened held Blanket remainder must default safely to Hold.");
assert.match(vendor, /This workflow now contains only the held remainder/);
assert.match(vendor, /smartVendorPendingPallets/);
assert.match(vendor, /smartVendorPoPreviewModal/);
assert.match(vendor, /data-smart-action="close-vendor-po-preview"/);
assert.match(vendor, /event\.key !== "Escape"/);
assert.match(vendorCss, /\.smart-vendor-pdf-modal\s*\{/);
assert.match(vendorCss, /z-index: 4600/);

assert.match(core, /data-smart-action="dismiss-smart-notice"/);
assert.match(core, /smartScheduleNoticeDismissal/);
assert.match(core, /}, 10000\);/,
  "Success and error notices must auto-dismiss after ten seconds.");
assert.match(sidebar, /scmWriteOnly: true/);
assert.match(sidebar, /roles\.has\("admin"\) \|\| roles\.has\("scm"\) \|\| roles\.has\("scm_staff"\)/,
  "PO history navigation must follow the server's SCM write roles.");
assert.match(sidebar, /!item\.scmWriteOnly \|\| canManageScmPurchaseOrders\(\)/);

for (const version of [
  "scm-smart.css?v=20260801-blanket-ui-v2",
  "scm-smart-vendor.css?v=20260801-vendor-email-location-v3",
  "scm-smart-blanket.css?v=20260801-blanket-sidebar-tabs-v4",
  "scm-smart-exclusions.css?v=20260801-planning-pauses-v3",
  "app-sidebar.js?v=20260801-netsuite-po-role-v1",
  "scm-smart.js?v=20260801-focus-preservation-v1",
  "scm-smart-blanket.js?v=20260801-manual-over-capacity-v1",
  "scm-smart-proposals.js?v=20260801-manual-over-capacity-v1",
  "scm-smart-exclusions.js?v=20260801-po-only-pauses-v1",
  "scm-smart-vendor.js?v=20260801-manual-over-capacity-v1"
]) assert.equal(html.includes(version), true, `Smart SCM must load cache-busted asset ${version}.`);

console.log(JSON.stringify({
  ok: true,
  twoPaneBlanketWorkspace: true,
  staleSearchProtection: true,
  automaticBlanketPauses: true,
  compactEditableBlanketProposals: true,
  tallerBlanketSidebar: true,
  vendorHandoff: true,
  partialHoldSafety: true,
  inAppPoPreview: true,
  roleAwareHistoryNavigation: true,
  noticesAutoDismiss: true
}));
