import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { query, withTransaction, closeDb } from "./src/db.js";
import { getSalesOrderPoAllocationOptions } from "./src/dispatch-repository.js";

const ref = "GOA-9948S1-9949S1";
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
try {
  const result = await withTransaction(async () => {
    await query("SET TRANSACTION READ ONLY");
    await query("SET LOCAL statement_timeout='20s'");
    const options = await getSalesOrderPoAllocationOptions(ref, { planDate: "2026-10-15" });
    const first = options.salesLines.find(line => line.targetLineKey.endsWith("::520096"));
    const second = options.salesLines.find(line => line.targetLineKey.endsWith("::520099"));
    assert.equal(first.id, -67318607752703);
    assert.equal(first.lineId, "5100029");
    assert.match(first.description, /^BLU 60 MM SLAB/);
    assert.equal(first.required.unit, "SQFT");
    assert.equal(first.required.salesQty, 947.73);
    assert.equal(second.id, -4131836072916);
    assert.equal(second.lineId, "5100032");
    assert.match(second.description, /^SIENASTONE/);
    assert.equal(second.required.unit, "PC");
    assert.equal(second.required.salesQty, 11);
    assert.notEqual(first.id, second.id);
    for (const salesLine of [first, second]) {
      for (const candidate of salesLine.poCandidates) {
        const poLine = options.poLines.find(line => String(line.id) === String(candidate.poLineId));
        assert.equal(poLine.required.unit, salesLine.required.unit);
      }
    }
    const stored = (await query(`SELECT l.* FROM sales_order_lines l
      JOIN sales_orders s ON s.netsuite_id=l.sales_order_id
      WHERE s.tranid=ANY($1::text[]) ORDER BY s.tranid,l.id`, [["SOA09948-S1", "SOA09949-S1"]])).rows;
    const links = (await query(`SELECT * FROM dispatch_so_po_allocations
      WHERE dispatch_target_ref=ANY($1::text[]) OR sales_order_ref=ANY($1::text[]) ORDER BY id`,
      [[ref, "SOA09948-S1", "SOA09949-S1"]])).rows;
    const s2 = await getSalesOrderPoAllocationOptions("SOA09948-S2", { planDate: "2026-10-15" });
    assert.deepEqual(s2.salesLines.map(line => [line.lineId, line.required.unit, line.required.salesQty]), [
      ["5100033", "EACH", 10], ["5104986", "PC", 135], ["5104987", "PC", 2], ["5104988", "PC", 22]
    ]);
    assert.equal(new Set(s2.salesLines.map(line => line.id)).size, 4);
    const retiredLinks = (await query(`SELECT id,status FROM dispatch_so_po_allocations
      WHERE dispatch_target_ref='GOA-9948-9949-9998' ORDER BY id`)).rows;
    assert.equal(retiredLinks.filter(link => link.status === "active").length, 0);
    const otherOrphans = (await query(`SELECT count(*)::int AS count FROM dispatch_so_po_allocations allocation
      WHERE allocation.status='active' AND EXISTS(SELECT 1 FROM dispatch_global_order_groups retired
        WHERE retired.active=false AND lower(retired.group_ref)=lower(allocation.dispatch_target_ref))`)).rows[0].count;
    assert.equal(otherOrphans, 0);
    return { record: ref, corrected: true, salesLines: [first, second].map(line => ({
      id: line.id, lineId: line.lineId, description: line.description,
      quantity: line.required.salesQty, unit: line.required.unit, candidates: line.poCandidates.length
    })), storedLinesHash: hash(stored), allocationHash: hash(links), allocationCount: links.length,
      s2Checked: true, s2DistinctLines: 4, retiredGroupActivePoLinks: 0, otherRetiredGroupActivePoLinks: otherOrphans };
  });
  const health = await fetch("http://127.0.0.1:3000/health", { signal: AbortSignal.timeout(15000) });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  console.log(JSON.stringify({ ...result, productionHealthy: true }));
} finally {
  await closeDb();
}
