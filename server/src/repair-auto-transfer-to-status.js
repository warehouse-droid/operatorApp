import { closeDb, query } from "./db.js";
import { writeDispatchAudit } from "./dispatch-audit-repository.js";
import {
  fetchTransferOrderByIdFromNetSuite,
  fetchTransferOrderDetailsFromNetSuite,
  resolveNetSuiteTransferLocations,
  updateTransferOrderStatusInNetSuite
} from "./netsuite.js";
import {
  upsertInboundTransferOrderLines,
  upsertInboundTransferOrders,
  upsertOutboundTransferOrderLines,
  upsertOutboundTransferOrders
} from "./order-sync-repository.js";

const ref = String(process.argv[2] || "").trim();
if (!ref) throw new Error("Usage: npm run repair:auto-transfer-to-status -- TOB00025");

try {
  const local = await query(
    `SELECT t.*, p.id AS proposal_id
       FROM transfer_orders t
       LEFT JOIN scm_transfer_dependency_proposals p ON p.netsuite_transfer_order_id = t.netsuite_id
      WHERE upper(t.tranid) = upper($1)
      ORDER BY p.id DESC NULLS LAST
      LIMIT 1`,
    [ref]
  );
  if (!local.rowCount) throw new Error(`${ref} was not found in the local transfer_orders table.`);
  const row = local.rows[0];
  const locations = await resolveNetSuiteTransferLocations({
    sourceLocationId: row.from_location_id,
    sourceLocation: row.from_location,
    destinationLocationId: row.to_location_id,
    destinationLocation: row.to_location
  });
  const beforeStatus = String(row.status_text || row.status || "");
  await updateTransferOrderStatusInNetSuite(row.netsuite_id, { intercompany: locations.intercompany, statusId: "B" });
  const order = await fetchTransferOrderByIdFromNetSuite(row.netsuite_id);
  if (!order || !(String(order.status || "").toUpperCase() === "B" || /pending fulfillment/i.test(String(order.status_text || "")))) {
    throw new Error(`${ref} remains ${order?.status_text || order?.status || "unknown"} after the NetSuite status update.`);
  }
  const outbound = await fetchTransferOrderDetailsFromNetSuite(row.netsuite_id, Number(order.source_location_id), { direction: "source" });
  const receiving = await fetchTransferOrderDetailsFromNetSuite(row.netsuite_id, Number(order.destination_location_id), { direction: "destination" });
  const canonical = {
    ...order,
    source_location_id: row.from_location_id,
    source_location: row.from_location,
    outbound_location_id: row.from_location_id,
    outbound_location: row.from_location,
    destination_location_id: row.to_location_id,
    destination_location: row.to_location,
    order_location_id: row.to_location_id,
    order_location: row.to_location,
    customer_id: row.to_location_id,
    customer: `Transfer to ${row.to_location}`
  };
  await upsertOutboundTransferOrders([canonical]);
  await upsertOutboundTransferOrderLines(row.netsuite_id, outbound.map((line) => ({
    ...line, location_id: row.from_location_id, location: row.from_location
  })));
  await upsertInboundTransferOrders([canonical]);
  await upsertInboundTransferOrderLines(row.netsuite_id, receiving.map((line) => ({
    ...line, location_id: row.to_location_id, location: row.to_location
  })));
  if (row.proposal_id) {
    await query(
      `UPDATE scm_transfer_dependency_proposals
          SET creation_status = 'created', creation_error = null, updated_at = now()
        WHERE id = $1`,
      [row.proposal_id]
    );
  }
  await query(
    `UPDATE order_dependencies
        SET status = CASE WHEN status = 'attention' THEN 'active' ELSE status END,
            attention_reason = CASE WHEN status = 'attention' THEN null ELSE attention_reason END,
            updated_at = now()
      WHERE transfer_order_id = $1
        AND attention_reason ILIKE '%instead of Pending Fulfillment%'`,
    [row.netsuite_id]
  );
  await writeDispatchAudit({
    action: "scm.transfer_dependency.to_status_repaired",
    source: "scm",
    entityType: "transfer_order",
    entityId: String(row.netsuite_id),
    orderId: ref,
    details: { beforeStatus, afterStatus: order.status_text || order.status, intercompany: locations.intercompany }
  });
  const verified = await query(
    `SELECT status, status_text, fulfillment_status, receiving_status, netsuite_active
       FROM transfer_orders
      WHERE netsuite_id = $1`,
    [row.netsuite_id]
  );
  console.log(JSON.stringify({
    ref,
    id: row.netsuite_id,
    beforeStatus,
    afterStatus: order.status_text || order.status,
    localHeader: verified.rows[0] || null,
    outboundLines: outbound.length,
    receivingLines: receiving.length
  }, null, 2));
} finally {
  await closeDb();
}
