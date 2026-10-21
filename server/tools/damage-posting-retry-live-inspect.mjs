// Read-only snapshot. The caller stores stdout privately; no stock writes.
import {query,pool} from '/app/src/db.js';
import {damageNetSuite} from '/app/src/inventory-damage-netsuite.js';
import {withOperatorNetSuitePriority} from '/app/src/operator-netsuite-request-pool.js';
try {
  const reports=(await query(`SELECT r.*,m.location_id,m.month,m.transfer_id,m.transfer_ref,m.external_id,
    COALESCE((SELECT jsonb_agg(p.photo_reference ORDER BY p.position) FROM inventory_damage_photos p WHERE p.report_id=r.id),'[]') AS photos
    FROM inventory_damage_reports r JOIN inventory_damage_months m ON m.id=r.month_id
    WHERE m.location_id=1 AND m.month IN ('2026-09','2026-10') ORDER BY r.created_at`)).rows;
  const events=(await query(`SELECT e.* FROM inventory_damage_events e JOIN inventory_damage_reports r ON r.id=e.report_id
    JOIN inventory_damage_months m ON m.id=r.month_id WHERE m.location_id=1 AND m.month IN ('2026-09','2026-10') ORDER BY e.id`)).rows;
  const records=await withOperatorNetSuitePriority(()=>Promise.all(['998187','1031838'].map(id=>damageNetSuite.get(id))));
  console.log(JSON.stringify({checkedAt:new Date().toISOString(),stockWrites:0,reports,events,records},null,2));
} finally {await pool.end();}
