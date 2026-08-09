import { closeDb, query, withTransaction } from "./db.js";
import { writeAudit } from "./auth-repository.js";
import {
  fetchPurchaseOrderDetailsFromNetSuite,
  fetchPurchaseOrderReferenceFromNetSuite,
  fetchTransferOrderByIdFromNetSuite,
  fetchTransferOrderDetailsFromNetSuite
} from "./netsuite.js";
import {
  markMissingInboundOrderLines,
  markMissingOutboundOrderLines,
  upsertInboundTransferOrderLines,
  upsertInboundTransferOrders,
  upsertOutboundTransferOrderLines,
  upsertOutboundTransferOrders,
  upsertPurchaseOrderLines,
  upsertPurchaseOrders
} from "./order-sync-repository.js";
import { syncSmartScmInventory } from "./smart-scm-sync-service.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const runArgument = args.find((argument) => argument.startsWith("--run="));
const requestedRunId = runArgument ? Number(runArgument.slice("--run=".length)) : null;

async function selectedRunId() {
  if (Number.isSafeInteger(requestedRunId) && requestedRunId > 0) return requestedRunId;
  const result = await query(
    `SELECT id FROM scm_smart_planning_runs
      WHERE status = 'ready'
      ORDER BY id DESC LIMIT 1`
  );
  const id = Number(result.rows[0]?.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("No ready Smart SCM planning run was found.");
  return id;
}

async function refreshBlanketPurchaseOrder(row) {
  const orderId = Number(row.netsuite_id);
  const header = await fetchPurchaseOrderReferenceFromNetSuite(orderId);
  if (!header) throw new Error(`${row.tranid} was not found in NetSuite during exact blanket refresh.`);
  const lines = await fetchPurchaseOrderDetailsFromNetSuite(orderId, Number(row.destination_location_id) || null);
  await withTransaction(async () => {
    await upsertPurchaseOrders([header]);
    await upsertPurchaseOrderLines(orderId, lines);
    await markMissingInboundOrderLines(orderId, lines.map((line) => line.line_id));
    const preserved = await query(
      "SELECT is_blanket_po FROM purchase_orders WHERE netsuite_id = $1 FOR SHARE",
      [orderId]
    );
    if (preserved.rows[0]?.is_blanket_po !== true) {
      throw new Error(`${row.tranid} lost its local blanket flag during refresh.`);
    }
  });
  return { id: orderId, ref: header.tranid || row.tranid, lines: lines.length };
}

async function refreshLinkedTransferOrder(row) {
  const orderId = Number(row.netsuite_transfer_order_id);
  const header = await fetchTransferOrderByIdFromNetSuite(orderId);
  if (!header) throw new Error(`${row.netsuite_transfer_order_ref} was not found in NetSuite during exact TO refresh.`);
  const sourceLocationId = Number(header.source_location_id || row.from_location_id) || null;
  const destinationLocationId = Number(header.destination_location_id || row.to_location_id) || null;
  const outbound = await fetchTransferOrderDetailsFromNetSuite(orderId, sourceLocationId, { direction: "source" });
  const receiving = await fetchTransferOrderDetailsFromNetSuite(orderId, destinationLocationId, { direction: "destination" });
  await withTransaction(async () => {
    await upsertOutboundTransferOrders([header]);
    await upsertInboundTransferOrders([header]);
    await upsertOutboundTransferOrderLines(orderId, outbound);
    await upsertInboundTransferOrderLines(orderId, receiving);
    await markMissingOutboundOrderLines(orderId, outbound.map((line) => line.line_id));
    await markMissingInboundOrderLines(orderId, receiving.map((line) => line.line_id));
  });
  return {
    id: orderId,
    ref: header.tranid || row.netsuite_transfer_order_ref,
    outboundLines: outbound.length,
    receivingLines: receiving.length
  };
}

try {
  const runId = await selectedRunId();
  const blankets = await query(
    `SELECT netsuite_id, tranid, destination_location_id
       FROM purchase_orders
      WHERE is_blanket_po = true
        AND netsuite_active = true
      ORDER BY netsuite_id`
  );
  const linkedTransfers = await query(
    `SELECT DISTINCT proposal.netsuite_transfer_order_id,
            proposal.netsuite_transfer_order_ref,
            transfer.from_location_id,
            transfer.to_location_id
       FROM scm_smart_proposals proposal
       LEFT JOIN transfer_orders transfer
         ON transfer.netsuite_id = proposal.netsuite_transfer_order_id
      WHERE proposal.run_id = $1
        AND proposal.netsuite_transfer_order_id IS NOT NULL
        AND COALESCE(proposal.proposal_origin, 'inventory') <> 'blanket'
      ORDER BY proposal.netsuite_transfer_order_id`,
    [runId]
  );
  if (!apply) {
    console.log(JSON.stringify({
      applied: false,
      runId,
      plannedInventoryRefresh: true,
      blanketPurchaseOrders: blankets.rows,
      linkedTransferOrders: linkedTransfers.rows
    }, null, 2));
  } else {
    const inventory = await syncSmartScmInventory({
      fullCatalog: false,
      operatorId: null,
      triggerSource: "authoritative_urgency_repair"
    });
    const refreshedBlankets = [];
    for (const row of blankets.rows) refreshedBlankets.push(await refreshBlanketPurchaseOrder(row));
    const refreshedTransfers = [];
    for (const row of linkedTransfers.rows) refreshedTransfers.push(await refreshLinkedTransferOrder(row));
    const result = {
      applied: true,
      runId,
      inventory: {
        items: inventory.items,
        balances: inventory.balances,
        snapshotRunId: inventory.snapshotRunId,
        syncedAt: inventory.syncedAt
      },
      blanketPurchaseOrders: refreshedBlankets,
      linkedTransferOrders: refreshedTransfers
    };
    await writeAudit({
      actorType: "system",
      source: "repair",
      action: "smart_scm.authoritative_inputs.refreshed",
      details: result
    });
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
} finally {
  await closeDb();
}
