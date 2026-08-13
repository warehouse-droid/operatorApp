// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** @typedef {{ path?: string, statementMap: Record<string, { start: { line: number }, end: { line: number } }>, s: Record<string, number> }} FileCoverage */

const reportDirectory = path.resolve(process.argv[2] || "test-artifacts/stock-request-coverage");
const [coverageText, summaryText] = await Promise.all([
  readFile(path.join(reportDirectory, "coverage-final.json"), "utf8"),
  readFile(path.join(reportDirectory, "coverage-summary.json"), "utf8")
]);
/** @type {Record<string, FileCoverage>} */
const coverageDocument = JSON.parse(coverageText);
const summary = JSON.parse(summaryText);

assert.equal(summary.total.lines.pct, 100, "Stock-request line coverage must remain 100%.");
assert.equal(summary.total.statements.pct, 100, "Stock-request statement coverage must remain 100%.");
assert(summary.total.functions.pct >= 98, `Stock-request function coverage ${summary.total.functions.pct}% is below 98%.`);
assert(summary.total.branches.pct >= 75, `Stock-request branch coverage ${summary.total.branches.pct}% is below 75%.`);

/** @type {Array<{ path: string, probes: Array<[string, string]> }>} */
const targets = [
  {
    path: path.resolve("src/stock-request-domain.js"),
    probes: [
      ["yard authorization", "normalizeStockRequestYardId(value, \"destination yard\")"],
      ["exact conversion arithmetic", "sum + (value * (conversions[key] || 0))"],
      ["reservation subtraction", "live - (Number.isFinite(reserved)"],
      ["pending TO own-reservation exclusion", "(Number.isFinite(reserved) ? reserved : 0) - (Number.isFinite(own) ? own : 0)"],
      ["exact backorder gap", "Math.max(0, normalizedRequested - requestableAvailable)"],
      ["route isolation", "const key = `${sourceLocationId}:${destinationLocationId}`"],
      ["per-SKU PALLET ceiling", "Math.ceil(item.salesQty / item.toPlt)"],
      ["terminal Sales bucket", "statuses.every((status) => TERMINAL_LINE_STATUSES.has(status))"],
      ["unsafe revision lifecycle", "stockTransferQuantityRevisionBlock(order = {})"],
      ["duplicate marker recovery", "STOCK_REQUEST_DUPLICATE_REMOTE_MARKER"]
    ]
  },
  {
    path: path.resolve("src/stock-request-policy.js"),
    probes: [
      ["fail-closed Admin gate", "allowOverAvailability: row?.enabled === true"],
      ["gate revision evidence", "revision: row ? Number(row.revision) : null"]
    ]
  },
  {
    path: path.resolve("src/stock-request-repository.js"),
    probes: [
      ["gated cached request availability", "await assertCachedAvailability(normalized, { allowOverAvailability })"],
      ["SCM line backorder allowance", "await assertCachedAvailability([normalized], { allowOverAvailability: true })"],
      ["inventory pair serialization", "pg_advisory_xact_lock"],
      ["refreshed conversion availability", "await conversionAvailabilitySnapshot(locked.rows)"],
      ["audited conversion backorder", "backorderSalesQty: backorder.backorderQuantity"],
      ["conversion reservation", "INSERT INTO sales_stock_transfer_reservations"],
      ["failed confirmation takeover", "![\"complete\", \"attention\"].includes(transfer.confirmationStatus)"],
      ["ticket invalidation", "print_job_id = NULL, confirmation_status"],
      ["own reservation revision allowance", "ownReservations: await currentTransferReservationTotals(transfer.id)"],
      ["webhook lifecycle projection", "projectedWebhookTransferStatus(canonical = {}, payload = {})"],
      ["closed terminal projection", "if (/\\bclosed\\b/i.test(`${status} ${statusText}`))"],
      ["pre-confirm local rejection", "const isPristineLocalTransfer = transfer.status === \"pending_local\""],
      ["terminal reservation release", "projected === \"received\" ? \"executed\" : \"released\""]
    ]
  },
  {
    path: path.resolve("src/stock-request-service.js"),
    probes: [
      ["four-yard OAuth projection", "canonicalStockRequestInventoryRows(rows, yards, id)"],
      ["stable remote marker recovery", "recoverRemoteTransfer(transfer, locations, findRemoteByMarker"],
      ["completed confirmation replay", "idempotentReplay: true"],
      ["OAuth inventory fetch", "const rows = await fetchBalances("],
      ["selected-line refresh", "if (itemIds.length) await refreshAvailability(itemIds)"],
      ["dual-printer gate", "if (!printer?.transferOrderReady)"],
      ["canonical TO hydration", "await saveInboundLines(remoteId"],
      ["live-write gate", "if (!liveExecutionEnabled)"],
      ["immutable reprint generation", "const claim = await claimPrint(transfer.id"],
      ["revision live refresh", "await refreshAvailability(current.lines.map"],
      ["remote revision safety", "const block = stockTransferQuantityRevisionBlock(remote)"],
      ["remote revision update", "await updateRemote("
      ]
    ]
  }
];

/** @param {FileCoverage} fileCoverage @param {number} line */
function statementHitForLine(fileCoverage, line) {
  const candidates = Object.entries(fileCoverage.statementMap)
    .filter(([, location]) => location.start.line <= line && location.end.line >= line)
    .sort((left, right) => {
      const leftSpan = left[1].end.line - left[1].start.line;
      const rightSpan = right[1].end.line - right[1].start.line;
      return leftSpan - rightSpan;
    });
  assert(candidates.length, `No instrumented statement contains changed line ${line}.`);
  const [candidate] = candidates;
  assert(candidate);
  return Number(fileCoverage.s[candidate[0]] || 0);
}

let executed = 0;
let total = 0;
for (const target of targets) {
  const source = await readFile(target.path, "utf8");
  const fileCoverage = Object.values(coverageDocument).find((entry) =>
    path.resolve(String(entry?.path || "")) === target.path
  );
  assert(fileCoverage, `${path.basename(target.path)} coverage was not recorded.`);
  for (const [label, needle] of target.probes) {
    total += 1;
    const offset = source.indexOf(needle);
    assert.notEqual(offset, -1, `${label}: coverage probe source was not found.`);
    const line = source.slice(0, offset).split("\n").length;
    assert(statementHitForLine(fileCoverage, line) > 0, `${label} was not executed (line ${line}).`);
    executed += 1;
  }
}

console.log(`Stock-request critical changed-line probes: ${executed}/${total} executed; total lines/statements 100%.`);
