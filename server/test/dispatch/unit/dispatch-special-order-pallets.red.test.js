import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  dispatchOrderPalletQuantity,
  specialOrderPalletItemQuantity
} from "../../../src/dispatch-special-order-pallets.js";

const specialLine = { itemId: 2055, itemName: "MBBS-Special Order", quantity: 1440 };
const deliveryCharge = { itemId: 1987, itemName: "Delivery Charge", quantity: 1 };

test("MBBS-Special PLT POS uses the official PALLET item quantity", () => {
  const items = [specialLine, { itemId: 1784, itemName: "PALLET", quantity: 24 }, deliveryCharge];
  assert.equal(specialOrderPalletItemQuantity(items), 24);
  assert.equal(dispatchOrderPalletQuantity({
    items,
    reportedPallets: 0,
    fallbackSalesQuantity: 1465
  }), 24);
});

test("the official PALLET line remains authoritative at zero and supports split quantities", () => {
  assert.equal(specialOrderPalletItemQuantity([
    { ...specialLine, quantity: 1320 },
    { itemName: "PALLET", quantity: 22 },
    deliveryCharge
  ]), 22);
  assert.equal(dispatchOrderPalletQuantity({
    items: [specialLine, { itemName: "PALLET", quantity: 0 }],
    fallbackSalesQuantity: 1440
  }), 0);
});

test("ordinary and VRMA orders retain their existing pallet rules", () => {
  assert.equal(dispatchOrderPalletQuantity({
    items: [{ itemId: 5000, itemName: "Ordinary", quantity: 1465 }],
    fallbackSalesQuantity: 1465
  }), 14);
  assert.equal(dispatchOrderPalletQuantity({
    items: [specialLine, { itemName: "PALLET", quantity: 24 }],
    reportedPallets: 3,
    fallbackSalesQuantity: 1465,
    preserveReportedPallets: true
  }), 3);
});

test("Dispatch normalizes split cards, saves new splits, and defaults a unique compatible PO line", () => {
  const source = readFileSync(new URL("../../../public/dispatch.js", import.meta.url), "utf8");
  assert.match(source, /pallets:\s*effectiveOrderPalletQuantity\(order, items, groupMembers\.childOrderDetails\)/u);
  assert.match(source, /const specialPallets = specialOrderPalletItemQuantity\(items\);[\s\S]*?const pallets = specialPallets \?\?/u);
  assert.match(source, /if \(localPlanDirty \|\| saveQueued \|\| saveInFlight\) await saveCurrentPlanNow\(\);[\s\S]*?await loadPoAllocationOptions\(actionOrderId\);/u);
  assert.match(source, /const selected = exactCandidates\.length === 1 \? exactCandidates\[0\] : \(candidates\.length === 1 \? candidates\[0\] : null\);/u);
  assert.doesNotMatch(source, /!line\.isSpecial && candidates\.length === 1/u);
});
