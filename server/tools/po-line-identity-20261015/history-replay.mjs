// Replay retained evidence against the mounted baseline or candidate. The
// fixture has technical identities/quantities, with personal data excluded.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import readline from "node:readline";
import { compileFunction } from "node:vm";
import { query, withTransaction, closeDb } from "../../src/db.js";
import { getSalesOrderPoAllocationOptions, createSalesOrderPoAllocation,
  createSalesOrderPoAllocations, cancelSalesOrderPoAllocation } from "../../src/dispatch-repository.js";
import { resolveDispatchSalesTarget } from "../../src/dispatch-order-target-repository.js";
import { deactivateDispatchGlobalOrderDefinitions } from "../../src/dispatch-delivery-group-repository.js";
import { compactDispatchOrderCard } from "../../src/dispatch-planner-optimization.js";
import { compareDispatchReplayProjections } from "../../src/dispatch-planner-replay.js";
import { validateDispatchPickupVisits } from "../../src/dispatch-pickup-visits.js";

assert.equal(process.env.MBT_TEST_ISOLATED, "1");
assert.equal((await query("SELECT current_database() AS name")).rows[0].name, "mbt_test");
const mode = process.env.PO_IDENTITY_MODE;
assert.ok(["history-baseline", "history-candidate"].includes(mode));
const digest = value => crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const sourceFiles = ["src/dispatch-order-target-repository.js", "src/dispatch-delivery-group-repository.js",
  "public/dispatch.js", "public/dispatch.html", "public/mbt-planning.html"];
const sourceHashes = Object.fromEntries(sourceFiles.map(file => [file, digest(fs.readFileSync(file, "utf8"))]));
const fixture = "/evidence/history-fixture.jsonl";
const fixtureHash = crypto.createHash("sha256");
for await (const chunk of fs.createReadStream(fixture)) fixtureHash.update(chunk);
const fixtureSha256 = fixtureHash.digest("hex");
const report = { mode, sourceHashes, fixtureSha256, startedAt: new Date().toISOString(),
  assumptions: [
    "Historical request bodies and complete point-in-time NetSuite source versions are not retained.",
    "Allocation commands are reconstructed from persisted allocation rows and link receipt outcomes.",
    "The pre-link model makes captured source headers/lines eligible and PO receipts zero; captured quantities, conversions and UOMs are not enlarged or rewritten.",
    "Historical group/split definitions are temporarily active during reconstruction, then explicitly retired.",
    "Material batch payloads are reconstructed; original service-fee selections and SCM orchestration requests cannot be retransmitted exactly.",
    "Archived recovery drafts may already violate rules; baseline violations are reported separately from regressions."
  ], states: [], allocations: [], receipts: [], derivedTargets: [], gaps: [] };

// Compile the real browser functions once. The only supplied boundaries are
// catalog/assignment state, configured yard codes and the retirement feed.
function browserPlannerFactory() {
  const source = fs.readFileSync("public/dispatch.js", "utf8");
  const helpers = ["normalizeOrder", "canonicalDispatchOrderType", "splitParentOrderId", "flattenDispatchGroupMembers",
    "isAggregateDispatchCoGroup", "groupedOrderDependencies", "groupedOrderDependencyLabels", "activeTransitPickupLocations",
    "dispatchRelationshipPickupLocations", "uniqueDispatchLocationLabels", "normalizedPickupLocation", "dispatchLocationHierarchyRoot",
    "effectiveOrderPalletQuantity", "specialOrderPalletItemQuantity", "normalizePoDropoffs", "applyPlannedAssignments", "orderById",
    "isOperationalDispatchItem", "itemHasQuantity", "tooltipItemsForOrder", "poRouteProjectionForOrder", "routeItemsForOrder",
    "positiveBalance", "isOwnYardCode", "retainedDirectPickupManifest", "groupPickupSourceItems", "directPickupEntriesForLocation",
    "directPickupItemsForLocation", "poPickupEntriesForLocation", "poPickupItemsForLocation", "directPickupAllocatedForItem",
    "spreadDirectPickupAllocation", "itemForPickupLocation", "requiredPickupLocations", "sameDispatchLocation", "isMbbsSpecialLinkLine",
    "replenishmentDependencyComplete"];
  const functions = helpers.map(name => {
    const start = new RegExp(`^(?:async )?function ${name}\\(`, "mu").exec(source);
    assert.ok(start, `Missing actual browser function ${name}`);
    const end = /^\}/mu.exec(source.slice(start.index));
    assert.ok(end);
    return source.slice(start.index, start.index + end.index + 1);
  }).join("\n");
  return compileFunction(`return function makePlanner(initial) {
    let orders=[], orderCatalog=[], assignedOrderEvidenceById=new Map();
    let plannedAssignmentRefs=new Set(), plannedAssignmentsByRef=new Map();
    const HUBS={};
    const isAuthoritativelyRetiredOrderRef=()=>false;
    const withoutAuthoritativelyRetiredOrders=entries=>entries;
    const ownYardForLocation=location=>["3445","2967","12441","150","195"]
      .includes(String(location).split(/\\s*:\\s*/u)[0].trim());
    ${functions}
    orders=initial.map(normalizeOrder); orderCatalog=[...orders];
    return { normalizeOrder, requiredPickupLocations,
      refresh:()=>applyPlannedAssignments([]), orders:()=>orders };
  }`, [], { filename: "history-actual-browser-functions.js" })();
}
const makePlanner = browserPlannerFactory();
const normLocations = values => [...new Set(values.map(value => String(value).split(/\s*:\s*/u)[0].trim().toLowerCase()))].sort();
function orderOutcome(api, order) {
  return { ref: order.id, type: order.type, pallets: Number(order.pallets || 0),
    pickups: normLocations(api.requiredPickupLocations(order)),
    source: String(order.sourceYard || ""),
    children: (order.childOrderDetails || []).map(child => [child.id, child.sourceYard || "", Number(child.pallets || 0)]),
    cargo: digest(order.items || []) };
}
function frontendReplay(orders, compact) {
  const input = orders.map(order => compact ? compactDispatchOrderCard(order) : structuredClone(order));
  const api = makePlanner(input);
  api.refresh();
  const first = api.orders().map(order => orderOutcome(api, order));
  // Older saved boards can contain duplicate root IDs. The existing refresh
  // merges them by ID, keeping the final entry, so compare cargo by the same
  // identity rather than accidentally comparing shifted array positions.
  const inputById = new Map(input.map(order => [order.id, order]));
  for (const order of api.orders()) {
    assert.deepEqual(order.items || [], inputById.get(order.id).items || [], "Assignment refresh changed item identity, UOM or quantity");
  }
  api.refresh();
  const second = api.orders().map(order => orderOutcome(api, order));
  assert.deepEqual(second, first, "Repeated assignment refresh changed routing or cargo");
  return { outcomes: first, orders: api.orders() };
}
const tables = { salesHeader: [], salesLine: [], purchaseHeader: [], purchaseLine: [] };
const definitions = new Map(), allocations = [], receipts = [], linkedVariants = new Map();
let capture, end;
const hasPo = order => Boolean(order.poPickupManifest?.length || order.poAllocations?.length
  || (order.items || []).some(item => ["poAllocatedPallets", "poAllocatedLayers", "poAllocatedSections",
    "poAllocatedPieces", "poAllocatedSalesQty"].some(key => Number(item[key] || 0) > 0))
  || (order.childOrderDetails || []).some(hasPo));
function targetShape(order) {
  return { id: order.id, type: order.type, originalOrderId: order.originalOrderId || "",
    sourceYard: order.sourceYard, pickupLocations: order.pickupLocations, pallets: order.pallets,
    childOrders: order.childOrders || [], childOrderDetails: (order.childOrderDetails || []).map(targetShape),
    items: order.items || [] };
}
try {
  for await (const line of readline.createInterface({ input: fs.createReadStream(fixture), crlfDelay: Infinity })) {
    const entry = JSON.parse(line);
    if (entry.kind === "capture") capture = entry;
    else if (entry.kind === "end") end = entry;
    else if (entry.kind === "definition") definitions.set(entry.ref, entry);
    else if (entry.kind === "allocation") allocations.push(entry.row);
    else if (entry.kind === "receipt") receipts.push(entry);
    else if (tables[entry.kind]) tables[entry.kind].push(entry.row);
    else if (entry.kind === "state") {
      const plan = { id: entry.planId, planDate: entry.planDate, orders: entry.orders,
        trucks: entry.trucks, summary: entry.summary };
      const full = frontendReplay(entry.orders, false), compact = frontendReplay(entry.orders, true);
      const rawConflicts = validateDispatchPickupVisits(plan);
      const refreshedConflicts = validateDispatchPickupVisits({ ...plan, orders: full.orders });
      const projection = compareDispatchReplayProjections(plan);
      report.states.push({ key: entry.key, planDate: entry.planDate, rejectedRecovery: entry.rejectedRecovery,
        orderCount: entry.orders.length, poOrders: entry.orders.filter(hasPo).length,
        duplicateRootIds: entry.orders.length - new Set(entry.orders.map(order => order.id)).size,
        projection, rawRules: { count: rawConflicts.length, digest: digest(rawConflicts),
          codes: rawConflicts.map(conflict => conflict.code) },
        refreshedRules: { count: refreshedConflicts.length, digest: digest(refreshedConflicts),
          codes: refreshedConflicts.map(conflict => conflict.code) },
        full: full.outcomes, compact: compact.outcomes,
        // This distinguishes legitimate configured pickups from generated
        // child placeholders when reviewing baseline/candidate differences.
        input: entry.orders.map(order => ({ ref: order.id, source: order.sourceYard || "", pallets: Number(order.pallets || 0),
          childRefs: order.childOrders || [], childSources: (order.childOrderDetails || []).map(child => [child.id, child.sourceYard || ""]),
          catalogHydrated: order.catalogHydrated })) });
      for (const order of entry.orders) if (hasPo(order) && String(order.type).toUpperCase() === "SO"
        && (order.childOrders?.length || order.originalOrderId)) {
        const shape = targetShape(order);
        linkedVariants.set(digest(shape), { shape, state: entry.key, planDate: entry.planDate });
      }
      if (report.states.length % 50 === 0) console.log(JSON.stringify({ states: report.states.length, mode }));
    }
  }
  assert.ok(capture?.readOnly && end?.complete, "Incomplete read-only fixture");
  report.capture = capture;
  report.captureCounts = end.counts;

  // Whitelisted tables and identifiers; values always use parameters. Insert
  // only exported technical fields, with explicit pre-link eligibility changes.
  async function insertRows(table, rows) {
    assert.ok(["sales_orders", "sales_order_lines", "purchase_orders", "purchase_order_lines"].includes(table));
    const groups = new Map();
    for (const row of rows) {
      const columns = Object.keys(row).sort();
      assert.ok(columns.every(column => /^[a-z_]+$/u.test(column)));
      const key = columns.join(",");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    for (const [columns, values] of groups) await query(
      `INSERT INTO ${table}(${columns}) SELECT ${columns} FROM jsonb_populate_recordset(NULL::${table},$1::jsonb)`,
      [JSON.stringify(values)]);
  }
  const planId = (await query("INSERT INTO dispatch_plans(plan_date,status) VALUES ('2026-10-15','draft') RETURNING id")).rows[0].id;
  await insertRows("sales_orders", tables.salesHeader.map(row => ({ ...row, customer: "Historical replay customer",
    status: "B", status_text: "Sales Order : Pending Fulfillment", netsuite_active: true,
    sales_order_type: "Delivery", operator_status: "open", local_yard_order_status: "Open", fulfillment_status: "not_fulfilled" })));
  await insertRows("sales_order_lines", tables.salesLine.map(row => ({ ...row, netsuite_active: true })));
  await insertRows("purchase_orders", tables.purchaseHeader.map(row => ({ ...row,
    status: "B", status_text: "Purchase Order : Pending Receipt", netsuite_active: true })));
  await insertRows("purchase_order_lines", tables.purchaseLine.map(row => ({ ...row, netsuite_active: true,
    netsuite_received_qty: 0, netsuite_received_baseline_qty: 0,
    received_pallet_qty: 0, received_layer_qty: 0, received_section_qty: 0, received_piece_qty: 0 })));
  async function saveDefinition(definition, order = definition.order) {
    if (definition.definitionType === "group") await query(`INSERT INTO dispatch_global_order_groups
      (group_ref,order_type,source_plan_id,source_plan_date,full_order,card,active)
      VALUES($1,'SO',$2,$3,$4::jsonb,$4::jsonb,$5)
      ON CONFLICT(group_ref) DO UPDATE SET full_order=excluded.full_order,card=excluded.card,active=excluded.active`,
    [definition.ref, planId, definition.sourcePlanDate || "2026-10-15", JSON.stringify(order), definition.active]);
    else await query(`INSERT INTO dispatch_global_order_splits
      (split_ref,order_type,parent_order_ref,definition_kind,source_plan_id,source_plan_date,full_order,card,active)
      VALUES($1,'SO',$2,$3,$4,$5,$6::jsonb,$6::jsonb,$7)
      ON CONFLICT(split_ref) DO UPDATE SET full_order=excluded.full_order,card=excluded.card,active=excluded.active`,
    [definition.ref, definition.parentRef, definition.definitionKind || "split", planId,
      definition.sourcePlanDate || "2026-10-15", JSON.stringify(order), definition.active]);
  }
  for (const definition of definitions.values()) await saveDefinition(definition);
  const salesLineById = new Map(tables.salesLine.map(row => [String(row.id), row]));
  const purchaseLineById = new Map(tables.purchaseLine.map(row => [String(row.id), row]));
  const errorResult = error => ({ status: "unreconstructable", code: error.code || "", message: error.message });
  const rowQuantities = row => ({ pallets: Number(row.allocated_pallet_qty || 0), layers: Number(row.allocated_layer_qty || 0),
    sections: Number(row.allocated_section_qty || 0), pieces: Number(row.allocated_piece_qty || 0), salesQty: Number(row.allocated_sales_qty || 0) });
  async function activate(ref) {
    const definition = definitions.get(ref);
    if (definition) await saveDefinition({ ...definition, active: true });
  }
  async function selectLine(row) {
    const ref = row.dispatch_target_ref || row.sales_order_ref;
    await activate(ref);
    const resolved = await resolveDispatchSalesTarget({ dispatchTargetRef: ref });
    const exact = resolved.lines.find(line => line.targetLineKey === row.dispatch_target_line_key);
    const line = exact || resolved.lines.find(line => String(line.salesLineId) === String(row.sales_line_id));
    if (!line) throw new Error("Original target line is absent from the retained source version");
    return { ref, resolved, line, translatedKey: !exact };
  }
  for (const row of allocations) {
    const result = { id: String(row.id), targetRef: row.dispatch_target_ref || row.sales_order_ref,
      kind: row.dispatch_target_kind || "normal", originalStatus: row.status };
    try {
      Object.assign(result, await withTransaction(async () => {
        const expected = salesLineById.get(String(row.sales_line_id)), poLine = purchaseLineById.get(String(row.po_line_id));
        if (!expected || !poLine) throw new Error("Original sales or PO row is no longer retained");
        const { ref, resolved, line, translatedKey } = await selectLine(row);
        const options = await getSalesOrderPoAllocationOptions(ref);
        const option = options.salesLines.find(candidate => candidate.targetLineKey === line.targetLineKey);
        if (!option) throw new Error("Original sales line is no longer an eligible material line");
        const command = { dispatchTargetRef: ref, targetLineKey: line.targetLineKey, targetSignature: resolved.signature,
          salesLineId: row.sales_line_id, poLineId: row.po_line_id, poRef: row.po_order_ref, quantities: rowQuantities(row) };
        const linked = await createSalesOrderPoAllocation(command);
        assert.equal(Number(linked.salesLineId), Number(line.salesLineId));
        const originalQuantities = [row.allocated_pallet_qty, row.allocated_layer_qty, row.allocated_section_qty,
          row.allocated_piece_qty, row.allocated_sales_qty].map(Number);
        const currentRuleQuantities = Number(expected.item_id) === 2055
          ? [0, 0, 0, 0, originalQuantities[4]] : originalQuantities;
        const actualQuantities = [linked.pallets, linked.layers, linked.sections, linked.pieces, linked.salesQty].map(Number);
        assert.deepEqual(actualQuantities, currentRuleQuantities,
          "Replayed allocation changed quantities");
        const identity = { originalSalesLineId: Number(row.sales_line_id), actualSalesLineId: Number(linked.salesLineId),
          originalUnit: expected.unit || "", actualUnit: option.required.unit || "",
          originalDescription: expected.item_description || "", actualDescription: option.description || "",
          originalTargetKey: row.dispatch_target_line_key, actualTargetKey: line.targetLineKey, translatedKey,
          quantity: rowQuantities(row), actualQuantities,
          historicalSpecialPhysicalNormalization: JSON.stringify(originalQuantities) !== JSON.stringify(currentRuleQuantities) };
        await cancelSalesOrderPoAllocation(linked.id, { cancelledBy: "historical-replay" });
        const cancelled = (await query("SELECT * FROM dispatch_so_po_allocations WHERE id=$1", [linked.id])).rows[0];
        assert.equal(cancelled.status, "cancelled");
        assert.equal(Number(cancelled.allocated_sales_qty), Number(row.allocated_sales_qty));
        const second = await createSalesOrderPoAllocation(command);
        await deactivateDispatchGlobalOrderDefinitions([ref]);
        const retired = (await query("SELECT * FROM dispatch_so_po_allocations WHERE id=$1", [second.id])).rows[0];
        await deactivateDispatchGlobalOrderDefinitions([ref]);
        const secondRetirement = (await query("SELECT * FROM dispatch_so_po_allocations WHERE id=$1", [second.id])).rows[0];
        assert.deepEqual(secondRetirement, retired, "Repeated retirement changed allocation history");
        const activeSalesQty = Number((await query(`SELECT COALESCE(SUM(allocated_sales_qty),0) AS qty
          FROM dispatch_so_po_allocations WHERE status='active' AND po_line_id=$1`, [row.po_line_id])).rows[0].qty);
        return { status: "replayed", identity, cancelledExplicitly: true, retirementStatus: retired.status,
          activeSalesQtyAfterRetirement: activeSalesQty, knownDerivedDefinition: definitions.has(ref) };
      }, { rollback: true }));
    } catch (error) {
      if (error.code === "ERR_ASSERTION") throw error;
      Object.assign(result, errorResult(error));
    }
    report.allocations.push(result);
  }
  const allocationById = new Map(allocations.map(row => [String(row.id), row]));
  for (const receipt of receipts) {
    const result = { requestId: receipt.requestId, action: receipt.action, allocationId: receipt.allocationId,
      allocationIds: receipt.allocations.map(row => String(row.id)), originalStatus: receipt.status };
    try {
      Object.assign(result, await withTransaction(async () => {
        if (receipt.action === "unlink_po") {
          const original = allocationById.get(String(receipt.allocationId));
          if (!original) throw new Error("The unlinked allocation row is no longer retained");
          // Replay an unlink from the exact saved active allocation. Recreating
          // it first would unnecessarily depend on today's source quantities.
          const fields = Object.keys(original).filter(key => !["id", "created_at", "updated_at", "cancelled_at"].includes(key));
          const row = { ...original, status: "active" };
          const inserted = (await query(`INSERT INTO dispatch_so_po_allocations(${fields.join(",")})
            SELECT ${fields.join(",")} FROM jsonb_populate_record(NULL::dispatch_so_po_allocations,$1::jsonb) RETURNING id`,
          [JSON.stringify(row)])).rows[0];
          await cancelSalesOrderPoAllocation(inserted.id, { cancelledBy: "receipt-replay" });
          assert.equal((await query("SELECT status FROM dispatch_so_po_allocations WHERE id=$1", [inserted.id])).rows[0].status, "cancelled");
          return { status: "replayed", count: 1 };
        }
        if (!receipt.allocations.length) throw new Error("Link outcome has no retained material allocations");
        const refs = new Set(receipt.allocations.map(row => row.dispatchTargetRef || row.salesOrderRef));
        const poRefs = new Set(receipt.allocations.map(row => row.poOrderRef));
        if (refs.size !== 1 || poRefs.size !== 1) throw new Error("Receipt cannot be reconstructed as one material batch");
        const ref = [...refs][0];
        await activate(ref);
        // A retained receipt can precede split materialization. The persisted
        // allocation records the later child-row remap, while the receipt and
        // global split still retain the original parent identity. Restore that
        // lookup context only when all three identities agree; quantities and
        // line rows remain exactly as captured.
        const preMaterialization = receipt.allocations.every(row => {
          const current = allocationById.get(String(row.id));
          const oldKey = String(row.targetLineKey || "").split("::");
          const newKey = String(current?.dispatch_target_line_key || "").split("::");
          return row.dispatchTargetKind === "split" && row.salesOrderRef !== ref
            && current?.sales_order_ref === ref && current?.dispatch_target_ref === ref
            && oldKey[0] === ref && oldKey[1] === row.salesOrderRef
            && newKey[0] === ref && newKey[1] === ref && oldKey[2] === newKey[2]
            && String(current.po_line_id) === String(row.poLineId)
            && salesLineById.has(String(row.salesLineId));
        });
        let originalParentContext = false;
        if (preMaterialization) {
          originalParentContext = (await query(`UPDATE sales_orders SET tranid='history-before-materialization-' || netsuite_id
            WHERE tranid=$1 RETURNING netsuite_id`, [ref])).rowCount > 0;
        }
        const resolved = await resolveDispatchSalesTarget({ dispatchTargetRef: ref });
        const rows = receipt.allocations.map(row => {
          const line = resolved.lines.find(candidate => candidate.targetLineKey === row.targetLineKey)
            || resolved.lines.find(candidate => String(candidate.salesLineId) === String(row.salesLineId));
          if (!line) throw new Error("Receipt's original target line is not retained");
          return { targetLineKey: line.targetLineKey, salesLineId: row.salesLineId, poLineId: row.poLineId,
            quantities: { pallets: row.pallets, layers: row.layers, sections: row.sections, pieces: row.pieces, salesQty: row.salesQty } };
        });
        const linked = await createSalesOrderPoAllocations({ dispatchTargetRef: ref, poRef: [...poRefs][0],
          targetSignature: resolved.signature, lines: rows });
        assert.equal(linked.length, rows.length);
        if (originalParentContext) assert.deepEqual(linked.map(row => Number(row.salesLineId)),
          receipt.allocations.map(row => Number(row.salesLineId)), "Original parent line identity was not reconstructed");
        return { status: "replayed", count: linked.length, originalParentContext, lines: linked.map(row => ({ salesLineId: Number(row.salesLineId),
          targetLineKey: row.targetLineKey, poLineId: Number(row.poLineId), salesQty: Number(row.salesQty),
          pallets: Number(row.pallets), layers: Number(row.layers), sections: Number(row.sections), pieces: Number(row.pieces) })) };
      }, { rollback: true }));
    } catch (error) {
      if (error.code === "ERR_ASSERTION") throw error;
      Object.assign(result, errorResult(error));
    }
    report.receipts.push(result);
  }
  for (const [hash, variant] of linkedVariants) {
    const result = { hash, targetRef: variant.shape.id, sourceState: variant.state };
    try {
      Object.assign(result, await withTransaction(async () => {
        const shape = variant.shape;
        const definition = definitions.get(shape.id) || { ref: shape.id,
          definitionType: shape.childOrders.length ? "group" : "split", parentRef: shape.originalOrderId,
          definitionKind: "split", sourcePlanDate: variant.planDate };
        await saveDefinition({ ...definition, active: true }, shape);
        const resolved = await resolveDispatchSalesTarget({ dispatchTargetRef: shape.id });
        return { status: "replayed", lines: resolved.lines.map(line => ({ salesLineId: line.salesLineId,
          lineId: line.lineId, targetLineKey: line.targetLineKey, itemId: line.itemId, unit: line.unit,
          quantity: line.quantity, description: line.description })) };
      }, { rollback: true }));
    } catch (error) {
      if (error.code === "ERR_ASSERTION") throw error;
      Object.assign(result, errorResult(error));
    }
    report.derivedTargets.push(result);
  }
  report.retirementDataset = await withTransaction(async () => {
    for (const row of allocations) {
      const fields = Object.keys(row);
      await query(`INSERT INTO dispatch_so_po_allocations(${fields.join(",")})
        SELECT ${fields.join(",")} FROM jsonb_populate_record(NULL::dispatch_so_po_allocations,$1::jsonb)`,
      [JSON.stringify(row)]);
    }
    const before = (await query("SELECT * FROM dispatch_so_po_allocations ORDER BY id")).rows;
    const targets = [...new Set(allocations.map(row => row.dispatch_target_ref || row.sales_order_ref))]
      .filter(ref => definitions.has(ref));
    await deactivateDispatchGlobalOrderDefinitions(targets);
    const after = (await query("SELECT * FROM dispatch_so_po_allocations ORDER BY id")).rows;
    const immutable = row => Object.fromEntries(Object.entries(row)
      .filter(([key]) => !["status", "cancelled_by", "cancelled_at", "updated_at"].includes(key)));
    assert.deepEqual(after.map(immutable), before.map(immutable), "Retirement changed allocation history or quantities");
    return { count: before.length, retiredTargets: targets, before: before.map(row => ({ id: String(row.id),
      targetRef: row.dispatch_target_ref || row.sales_order_ref, status: row.status })),
    after: after.map(row => ({ id: String(row.id), status: row.status, cancelledBy: row.cancelled_by })) };
  }, { rollback: true });
  assert.equal(Number((await query("SELECT COUNT(*) AS count FROM dispatch_so_po_allocations")).rows[0].count), 0,
    "A replay operation escaped rollback");
  report.finishedAt = new Date().toISOString();
  report.complete = true;
  fs.writeFileSync(`/evidence/${mode}.json`, JSON.stringify(report) + "\n");
  console.log(JSON.stringify({ complete: true, states: report.states.length,
    allocations: report.allocations.length, allocationReplayed: report.allocations.filter(row => row.status === "replayed").length,
    receipts: report.receipts.length, receiptReplayed: report.receipts.filter(row => row.status === "replayed").length,
    derivedTargets: report.derivedTargets.length }));
} finally {
  await closeDb();
}
