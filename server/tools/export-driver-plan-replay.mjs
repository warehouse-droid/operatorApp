// Read-only incident export. Run from the server directory; redirect stdout to
// ignored, private test artifacts. No credentials, sessions, or photos exported.
import { query, withTransaction, closeDb } from "../src/db.js";

const date = process.argv[2] || "2026-09-11";
if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) { throw new Error("A YYYY-MM-DD plan date is required"); }
try {
  const result = await withTransaction(async () => {
    await query("SET TRANSACTION READ ONLY");
    const { rows } = await query(`
      SELECT p.id, p.plan_date::text AS "planDate", p.status, p.revision,
             s.orders, s.trucks, s.summary
        FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
       WHERE p.plan_date = $1::date AND p.status = 'confirmed'`, [date]);
    if (rows.length !== 1) { throw new Error("Expected exactly one confirmed plan"); }
    const vendors = await query("SELECT vendor, yard, address, active FROM dispatch_vendor_yards WHERE active = true");
    return { readOnly: true, exportedAt: new Date().toISOString(), plan: rows[0], vendorYards: vendors.rows };
  }, { rollback: true });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally { await closeDb(); }
