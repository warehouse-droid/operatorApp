import { query } from "../../src/db.js";
import { seed, sourceCo, command } from "./co-direct-to-fixture.mjs";
import { executeScmDependencyCommand, scmDependencyPayloadHash } from "../../src/scm-dependency-command-service.js";

export async function referenceCo() {
  const f = await seed();
  f.co = await sourceCo(f);
  for (let i = 3; i <= 7; i += 1) {
    await query(`INSERT INTO local_co_order_lines (co_id,line_id,item_id,item_name,sku,item_type,
      quantity,piece_qty,to_pcs,unit,packed_piece_qty,confirmed_at)
      VALUES ($1,$2,$2,'Packed wall','WALL','InvtPart',10,10,1,'PC',10,now())`, [f.co.id, i]);
  }
  const c = await command(f);
  c.payload.allocations.push({ salesLineId: f.palletId, quantities: { salesQty: 1 } });
  c.payloadHash = scmDependencyPayloadHash(c);
  await executeScmDependencyCommand(c);
  return f;
}
