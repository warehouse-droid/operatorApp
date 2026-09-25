import assert from "node:assert/strict";
import { query, withTransaction, closeDb } from "../src/db.js";
import { getOrderDependencyOptions } from "../src/order-dependency-repository.js";
import { previewScmDependencyMutation } from "../src/scm-dependency-preview-service.js";

try {
  await withTransaction(async () => {
    await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const options = await getOrderDependencyOptions({ dispatchTargetRef: "SOA08838", transferOrderRef: "TOB01102" });
    const material = options.matchingLines.find(line => String(line.itemId) === "1356");
    const pallet = options.matchingLines.find(line => String(line.itemId) === "1784");
    assert.ok(material, "The live material selection changed; inspect current orders");
    const command = { action: "link_to", targetRef: "SOA08838", targetSignature: options.targetSignature,
      payload: { transferOrderRef: "TOB01102", mode: "direct_to_customer",
        allocations: [{ targetLineKey: material.targetLineKey, quantities: { salesQty: 52.25 } }] } };
    const materialPreview = await previewScmDependencyMutation(command);
    let palletPreview = null;
    if (pallet) {
      command.payload.allocations.push({ targetLineKey: pallet.targetLineKey, quantities: { salesQty: 1 } });
      palletPreview = await previewScmDependencyMutation(command);
    }
    const expected = process.argv.includes("--expect-allowed");
    if (expected) {
      assert.equal(materialPreview.allowed, true, JSON.stringify(materialPreview.blockers));
      assert.equal(palletPreview?.allowed, false, "Existing packed pallet must remain protected");
    }
    console.log(JSON.stringify({ salesOrder: "SOA08838", transferOrder: "TOB01102", materialQuantity: 52.25,
      materialAllowed: materialPreview.allowed, materialBlockers: materialPreview.blockers,
      withPackedPalletAllowed: palletPreview?.allowed, withPackedPalletBlockers: palletPreview?.blockers,
      readOnly: true }));
  }, { rollback: true });
} finally {await closeDb();}
