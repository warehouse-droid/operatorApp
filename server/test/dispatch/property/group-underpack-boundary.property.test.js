import assert from "node:assert/strict";
import test, { after } from "node:test";
import fc from "fast-check";
import { query, withTransaction, closeDb } from "../../../src/db.js";
import { confirmDeliveryLine, getDeliveryOrder, recordDeliveryLoad } from "../../../src/delivery-repository.js";
import { packingOrder } from "../../support/group-underpack-fixture.mjs";

after(closeDb);
test("property: confirmation and loading conserve rounded whole-package quantities at both tolerance boundaries", async () => {
  await withTransaction(async () => {
    const actor = "packing-boundary-property";
    await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active) VALUES($1,$1,'Packing test','test','test','operator',ARRAY['operator'],true)", [actor]);
    const values = fc.record({ count: fc.integer({ min: 1, max: 20 }), conversionTicks: fc.integer({ min: 800, max: 25000 }),
      deltaTicks: fc.constantFrom(-100, -4, 0, 4, 100) });
    await fc.assert(fc.asyncProperty(values, async ({ count, conversionTicks, deltaTicks }) => {
      const quantity = (count * conversionTicks + deltaTicks) / 1000;
      const order = await packingOrder({ quantity, conversion: conversionTicks / 1000, layers: 0, packed: 0 });
      await confirmDeliveryLine(order.id, order.lineId, { layers: count }, actor);
      assert.equal(Number((await getDeliveryOrder(order.id)).lines[0].packed_layer_qty), count);
      const result = await recordDeliveryLoad(order.id, actor, { photoDataUrls: ["data:image/png;base64,dGVzdDE=", "data:image/png;base64,dGVzdDI="] });
      assert.equal(result.remainingLines, 0);
      assert.equal(Number((await getDeliveryOrder(order.id)).lines[0].loaded_qty), quantity);
    }), { seed: 20260915, numRuns: 80, examples: [
      [{ count: 1, conversionTicks: 1000, deltaTicks: 100 }],
      [{ count: 2, conversionTicks: 1000, deltaTicks: -100 }],
      [{ count: 1, conversionTicks: 800, deltaTicks: -100 }]
    ] });
  }, { rollback: true });
});
