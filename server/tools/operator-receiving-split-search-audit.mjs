// Read-only comparison of deployed and prepared receiving authorization for all split POs.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";
import { pool, query, withTransaction, closeDb } from "../src/db.js";

pool.options.options = "-c jit=off -c default_transaction_read_only=on -c statement_timeout=20000";
const { getReceivingOrder: deployedDetail } = await import("../src/receiving-repository.js");
const { listReceivingOrders, getReceivingOrder } = await import("../src/receiving-repository-candidate.js");
const { assertOperatorOrderYard: deployedGuard } = await import("../src/operator-yard-authorization.js");
writeFileSync("src/operator-yard-authorization-candidate.js", readFileSync("candidate/operator-yard-authorization.js", "utf8")
  .replace('"./receiving-repository.js"', '"./receiving-repository-candidate.js"'));
const { assertOperatorOrderYard: preparedGuard } = await import("../src/operator-yard-authorization-candidate.js");
const { netSuiteClosedOrderFamilySql } = await import("../src/netsuite-closed-order-policy.js");
function uiFilters(file) {
const ui = readFileSync(file, "utf8");
const parts = [ui.match(/^const PICKABLE_ITEM_TYPES = .*;$/m)?.[0]];
for (const name of ["qty", "isPickableLine", "receivingRemainingSalesQty", "hasReceivingRemainingQty"]) {
  const start = ui.indexOf(`function ${name}(`);
  if (start < 0) { throw new Error(`Missing deployed UI function: ${name}`); }
  const end = ui.indexOf("\n}", start) + 2;
  parts.push(ui.slice(start, end));
}
if (parts.some(part => !part)) { throw new Error("Could not load deployed item filters"); }
const context = vm.createContext({});
vm.runInContext(`${parts.join("\n")}\nthis.visible = lines => lines.filter(line => isPickableLine(line) && hasReceivingRemainingQty(line));`, context);
return context;
}
const context = uiFilters("public/operator-candidate.js");
const deployedContext = uiFilters("public/operator.js");

async function lookup(guard, id, yard, orderType = "purchase_order") {
  try {
    const record = await guard({ role: "operator", operatorYardLocationIds: [yard] }, String(id), { receiving: true, orderType });
    return { status: 200, id: String(record.netsuite_id), ref: record.tranid, type: record.order_type,
      yard: Number(record.destination_location_id), lines: record.lines.length };
  } catch (error) { return { status: error.status || 500, error: error.message }; }
}

function receivingEligible(row, supportedYard) {
  const eligible = row.split_status === "active" && row.netsuite_active === true && !row.closed
        && /Pending Receipt|Partially Received/i.test(row.status_text || "") && supportedYard;
  return eligible;
}
async function authorizationChecks(row, yard, supportedYard) {
  const checks = supportedYard && row.header_exists ? {
        deployed: await lookup(deployedGuard, row.split_po_id, yard),
        prepared: await lookup(preparedGuard, row.split_po_id, yard),
        preparedUntyped: await lookup(preparedGuard, row.split_po_id, yard, ""),
        foreignYard: await lookup(preparedGuard, row.split_po_id, [1, 28, 15, 26].find(value => value !== yard))
      } : {};
  return checks;
}
function recordProblems(eligible, found, checks, visible) {
  if (!eligible) { return []; }
  const problems = [];
  if (!found) { problems.push("search_missing"); }
  if (checks.prepared?.status !== 200) { problems.push("prepared_detail_failed"); }
  if (checks.preparedUntyped?.status !== 200) { problems.push("prepared_untyped_detail_failed"); }
  if (checks.foreignYard?.status !== 403) { problems.push("foreign_yard_not_denied"); }
  if (visible.length === 0) { problems.push("empty_receiving_lines"); }
  return problems;
}
function allocationFacts(row, rawLines) {
  const allocationLines = rawLines.filter(line => String(line.purchase_order_id) === String(row.split_po_id) && line.netsuite_active);
      const fullyAllocated = allocationLines.length > 0 && allocationLines.every(line => Number(line.allocated_sales_qty) >= Number(line.quantity));
      const overallocated = allocationLines.filter(line => Number(line.allocated_sales_qty) > Number(line.quantity) + 0.000001);
  return { allocationLines, fullyAllocated, overallocated };
}
function visibleLines(detail, filters) {
  return filters.visible(detail?.lines || []);
}
function lineDetails(detail) {
  return detail?.lines?.map(line => ({ item: line.sku || line.item_name, itemType: line.item_type,
          quantity: Number(line.quantity), received: Number(line.netsuite_received_qty || 0),
          active: line.netsuite_active, unit: line.unit })) || [];
}
async function checkRecord(row, rawLines) {
      const detail = await getReceivingOrder(row.split_po_id, { includeNetSuiteClosed: true });
      const yard = Number(detail?.destination_location_id || row.destination_location_id);
      const supportedYard = [1, 28, 15, 26].includes(yard);
      const search = await listReceivingOrders({ orderType: "purchase_order", search: row.split_po_ref,
        ...(supportedYard ? { destinationLocationId: yard } : {}) });
      const found = search.find(order => String(order.netsuite_id) === String(row.split_po_id));
      const eligible = receivingEligible(row, supportedYard);
      const visible = visibleLines(detail, context);
      const { allocationLines, fullyAllocated, overallocated } = allocationFacts(row, rawLines);
      const checks = await authorizationChecks(row, yard, supportedYard);
      const problems = recordProblems(eligible, found, checks, visible);
      const previous = await deployedDetail(row.split_po_id, { includeNetSuiteClosed: true });
      return { ...row, yard, yardLabel: detail?.destination_location || row.destination_location,
        eligible, searchFound: Boolean(found), searchMatches: search.map(order => ({ id: String(order.netsuite_id), ref: order.tranid, lines: order.line_count })),
        detailLines: (detail?.lines || []).length, visibleLines: visible.length,
        deployedVisibleLines: visibleLines(previous, deployedContext).length,
        fullyAllocated, allocationLines, overallocated,
        lines: lineDetails(detail), ...checks, problems };

}

try {
  const result = await withTransaction(async () => {
    await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const rows = (await query(`SELECT s.id AS split_id,s.split_po_id,s.split_po_ref,s.source_po_ref,s.status AS split_status,
      p.netsuite_id IS NOT NULL AS header_exists,p.netsuite_active,p.receipt_status,p.status_text,
      p.destination_location_id,p.destination_location,${netSuiteClosedOrderFamilySql("p", "PO")} AS closed
      FROM dispatch_scm_po_splits s LEFT JOIN purchase_orders p ON p.netsuite_id=s.split_po_id
      ORDER BY s.id`)).rows;
    const rawLines = (await query(`SELECT l.purchase_order_id,l.item_name,l.quantity,l.unit,l.netsuite_active,
      COALESCE(a.allocated_sales_qty,0) AS allocated_sales_qty,COALESCE(a.sales_refs,'{}'::text[]) AS sales_refs
      FROM purchase_order_lines l LEFT JOIN LATERAL (
        SELECT sum(allocated_sales_qty) AS allocated_sales_qty,array_agg(DISTINCT sales_order_ref) AS sales_refs
        FROM dispatch_so_po_allocations WHERE po_line_id=l.id AND status='active'
      ) a ON true WHERE l.purchase_order_id=ANY($1::bigint[]) ORDER BY l.purchase_order_id,l.line_id`,
    [rows.map(row => row.split_po_id)])).rows;
    const checked = [];
    for (const [index, row] of rows.entries()) {
      checked.push(await checkRecord(row, rawLines));
      if ((index + 1) % 20 === 0 || index + 1 === rows.length) {
        console.log(JSON.stringify({ checked: index + 1, total: rows.length }));
      }
    }
    const eligible = checked.filter(row => row.eligible);
    const summary = {
      total: checked.length, active: checked.filter(row => row.split_status === "active").length,
      cancelled: checked.filter(row => row.split_status === "cancelled").length,
      receivingEligible: eligible.length,
      searchable: eligible.filter(row => row.searchFound).length,
      deployedDetailFailures: eligible.filter(row => row.deployed?.status !== 200).length,
      preparedDetailPasses: eligible.filter(row => row.prepared?.status === 200 && row.preparedUntyped?.status === 200).length,
      foreignYardDenied: eligible.filter(row => row.foreignYard?.status === 403).length,
      withVisibleLines: eligible.filter(row => row.visibleLines > 0).length,
      emptyDetails: eligible.filter(row => row.visibleLines === 0).map(row => row.split_po_ref),
      emptyBecauseFullyAllocated: eligible.filter(row => row.visibleLines === 0 && row.fullyAllocated).length,
      restoredAllocatedOrders: eligible.filter(row => row.deployedVisibleLines === 0 && row.visibleLines > 0).map(row => row.split_po_ref),
      overallocated: eligible.filter(row => row.overallocated.length).map(row => row.split_po_ref),
      otherExceptions: checked.filter(row => row.problems.length)
        .map(row => ({ ref: row.split_po_ref, problems: row.problems }))
    };
    return { mode: "read-only, repeatable-read; no deployment or receipts", capturedAt: new Date().toISOString(),
      deployedGuardSha256: createHash("sha256").update(readFileSync("src/operator-yard-authorization.js")).digest("hex"),
      preparedGuardSha256: createHash("sha256").update(readFileSync("src/operator-yard-authorization-candidate.js")).digest("hex"),
      preparedReceivingSha256: createHash("sha256").update(readFileSync("src/receiving-repository-candidate.js")).digest("hex"),
      preparedUiSha256: createHash("sha256").update(readFileSync("public/operator-candidate.js")).digest("hex"),
      summary, rows: checked };
  }, { rollback: true });
  writeFileSync("test-artifacts/operator-receiving-identity/all-split-po-search.json", JSON.stringify(result, null, 2));
  const report = ["# All split PO receiving search audit", "", `Captured: ${result.capturedAt}`, "",
    "Read-only comparison against one database snapshot. The prepared correction was loaded in a separate process; production was not deployed or changed.", "",
    `- ${result.summary.total} split records: ${result.summary.active} active and ${result.summary.cancelled} cancelled.`,
    `- ${result.summary.receivingEligible} eligible for receiving; ${result.summary.searchable} found in search.`,
    `- Prepared detail checks: ${result.summary.preparedDetailPasses}/${result.summary.receivingEligible} pass with and without the PO type; foreign-yard denials: ${result.summary.foreignYardDenied}.`,
    `- ${result.summary.withVisibleLines} have visible receiving lines; ${result.summary.emptyDetails.length} remain empty.`,
    `- Previously empty allocated orders restored: ${result.summary.restoredAllocatedOrders.join(", ") || "none"}.`,
    `- Separate allocation inconsistencies (allocated above current line quantity): ${result.summary.overallocated.join(", ") || "none"}.`, "",
    "| Split reference | Source PO | Yard | Split status | In search | Prepared detail | Visible lines | Note |",
    "|---|---|---|---|---|---|---:|---|",
    ...result.rows.map(row => `| ${row.split_po_ref.replaceAll("|", "\\|")} | ${row.source_po_ref} | ${row.yardLabel || "—"} | ${row.split_status} | ${row.searchFound ? "yes" : "no"} | ${row.prepared?.status || "—"} | ${row.visibleLines} | ${row.problems.join(", ") || (row.overallocated.length ? "Allocation exceeds quantity" : row.eligible && row.fullyAllocated ? "Fully allocated to SOs" : !row.eligible ? row.status_text || "Not receiving eligible" : "Pass")} |`), ""];
  writeFileSync("test-artifacts/operator-receiving-identity/all-split-po-search.md", report.join("\n"));
  console.log(JSON.stringify(result.summary, null, 2));
} finally { await closeDb(); }
