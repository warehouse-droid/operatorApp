import { closeDb, query, withTransaction } from "./db.js";
import { writeAudit } from "./auth-repository.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const values = args.filter((arg) => arg !== "--apply");
const orderRef = String(values.shift() || "").trim();
const skus = values.map((value) => String(value).trim()).filter(Boolean);

if (!orderRef) {
  console.error("Usage: npm run repair:po-received-baseline -- <PO-ref> [SKU ...] [--apply]");
  process.exitCode = 1;
} else {
  try {
    const result = await withTransaction(async () => {
      const order = await query(
        `SELECT netsuite_id, tranid, dispatch_ref
           FROM purchase_orders
          WHERE lower(tranid) = lower($1)
             OR lower(COALESCE(dispatch_ref, '')) = lower($1)
          ORDER BY CASE WHEN lower(tranid) = lower($1) THEN 0 ELSE 1 END
          LIMIT 1`,
        [orderRef]
      );
      if (!order.rowCount) throw new Error(`Purchase order ${orderRef} was not found.`);

      const selectedOrder = order.rows[0];
      const lines = await query(
        `WITH active_split AS (
           SELECT split_line.source_line_id,
                  SUM(COALESCE(split_line.sales_qty, 0)) AS split_sales_qty
             FROM dispatch_scm_po_split_lines split_line
             JOIN dispatch_scm_po_splits split ON split.id = split_line.split_id
            WHERE split.status = 'active'
            GROUP BY split_line.source_line_id
         ),
         earliest_audit AS (
           SELECT DISTINCT ON ((details->'line'->>'line_id')::numeric)
                  (details->'line'->>'line_id')::numeric AS line_id,
                  ABS(COALESCE(NULLIF(details->'line'->>'netsuite_received_qty', '')::numeric, 0)) AS received_qty
             FROM delivery_audit_log
            WHERE action = 'netsuite.receiving_line.discover'
              AND COALESCE(details->'line'->>'line_id', '') ~ '^-?[0-9]+([.][0-9]+)?$'
            ORDER BY (details->'line'->>'line_id')::numeric, created_at, id
         )
         SELECT line.id,
                line.line_id,
                COALESCE(NULLIF(line.sku, ''), line.item_name) AS sku,
                line.quantity,
                line.netsuite_received_qty,
                line.netsuite_received_baseline_qty,
                COALESCE(split.split_sales_qty, 0) AS active_split_sales_qty,
                audit.received_qty AS audited_first_received_qty,
                COALESCE(
                  audit.received_qty,
                  GREATEST(COALESCE(line.netsuite_received_qty, 0) - COALESCE(split.split_sales_qty, 0), 0)
                ) AS proposed_baseline_qty
           FROM purchase_order_lines line
           LEFT JOIN active_split split ON split.source_line_id = line.id
           LEFT JOIN earliest_audit audit ON audit.line_id = line.line_id
          WHERE line.purchase_order_id = $1
            AND ($2::text[] = '{}'::text[] OR COALESCE(NULLIF(line.sku, ''), line.item_name) = ANY($2::text[]))
          ORDER BY line.line_id NULLS LAST, line.id`,
        [selectedOrder.netsuite_id, skus]
      );
      if (!lines.rowCount) throw new Error(`No matching lines were found on ${selectedOrder.tranid}.`);

      if (apply) {
        for (const line of lines.rows) {
          await query(
            `UPDATE purchase_order_lines
                SET netsuite_received_baseline_qty = $2,
                    synced_at = now()
              WHERE id = $1`,
            [line.id, line.proposed_baseline_qty]
          );
        }
        await writeAudit({
          actorType: "system",
          source: "repair",
          action: "purchase_order.received_baseline.repaired",
          orderId: selectedOrder.netsuite_id,
          details: {
            orderRef: selectedOrder.tranid,
            requestedRef: orderRef,
            lines: lines.rows.map((line) => ({
              lineId: line.line_id,
              sku: line.sku,
              before: line.netsuite_received_baseline_qty,
              after: line.proposed_baseline_qty,
              latestNetSuiteReceived: line.netsuite_received_qty,
              activeSplitSalesQty: line.active_split_sales_qty,
              usedAuditHistory: line.audited_first_received_qty !== null
            }))
          }
        });
      }

      return {
        order: selectedOrder.tranid,
        applied: apply,
        lines: lines.rows.map((line) => ({
          lineId: line.line_id,
          sku: line.sku,
          quantity: line.quantity,
          latestNetSuiteReceived: line.netsuite_received_qty,
          currentBaseline: line.netsuite_received_baseline_qty,
          activeSplitSalesQty: line.active_split_sales_qty,
          auditedFirstReceived: line.audited_first_received_qty,
          proposedBaseline: line.proposed_baseline_qty,
          operationalOpenAfterRepair: Math.max(Number(line.quantity || 0) - Number(line.proposed_baseline_qty || 0) - Number(line.active_split_sales_qty || 0), 0)
        }))
      };
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
