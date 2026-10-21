// Run through `docker exec -i ... node --input-type=module` from /app.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { query, closeDb, withTransaction } from "./src/db.js";
import { getSalesOrderPoAllocationOptions } from "./src/dispatch-repository.js";

try {
  const result = await withTransaction(async () => {
    await query("SET TRANSACTION READ ONLY");
    await query("SET LOCAL statement_timeout='15s'");
    const lifecycle = (await query(`SELECT group_ref AS ref, active FROM dispatch_global_order_groups
      WHERE group_ref LIKE 'GOB-122477-122479%'
      UNION SELECT split_ref AS ref, active FROM dispatch_global_order_splits
      WHERE split_ref LIKE 'GOB-122477-122479%' ORDER BY ref`)).rows;
    const options = [];
    for (const target of lifecycle.filter(row => row.active)) {
      options.push(await getSalesOrderPoAllocationOptions(target.ref, { planDate: "2026-10-20" }));
    }
    const sales = options.flatMap(option => option.salesLines).filter(line => Number(line.itemId) === 1784);
    const purchase = [...new Map(options.flatMap(option => option.poLines)
      .filter(line => Number(line.itemId) === 1784 && line.poRef === "LOINC-039852")
      .map(line => [line.id, line])).values()];
    return {
      readOnly: true, checkedAt: new Date().toISOString(), lifecycle,
      activePalletLinks: (await query(`SELECT id,dispatch_target_ref,po_order_ref,allocated_sales_qty,status
        FROM dispatch_so_po_allocations WHERE po_line_id=532843 AND status='active'`)).rows,
      sales: sales.map(line => ({
        sourceOrderRef: line.sourceOrderRef, lineId: line.lineId, available: line.available.salesQty,
        allocated: line.allocated.salesQty, unit: line.required.unit,
        matchingPoLineIds: line.poCandidates.filter(candidate => candidate.poRef === "LOINC-039852").map(candidate => candidate.poLineId)
      })),
      purchase: purchase.map(line => ({
        poRef: line.poRef, originalPoRef: line.originalPoRef, id: line.id, lineId: line.lineId,
        available: line.available.salesQty, allocated: line.allocated.salesQty, unit: line.required.unit
      }))
    };
  });
  const source = readFileSync("/app/src/dispatch-repository.js", "utf8");
  const health = await fetch("http://127.0.0.1:3000/health");
  console.log(JSON.stringify({
    ...result, health: health.status,
    sourceHash: createHash("sha256").update(source).digest("hex"),
    capacityErrorsClassified: (source.match(/status: 400, code: "DISPATCH_PO_LINK_QUANTITY_EXCEEDED"/gu) || []).length
  }, null, 2));
} finally {
  await closeDb();
}
