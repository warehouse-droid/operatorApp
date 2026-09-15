import assert from "node:assert/strict";
import test, { after } from "node:test";
import fc from "fast-check";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { confirmCustomerPickupLine, confirmCustomerPickupLines, recordCustomerPickupLoad } from "../../../src/delivery-repository.js";
import { seedOperatorPickup } from "../../support/operator-ui-enhancements-fixture.mjs";

after(closeDb);

async function fixture(options, run) {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => run(await seedOperatorPickup(options)));
  } finally {
    await rollback.rollback();
  }
}

async function lineState(f) {
  const result = await query("SELECT packed_piece_qty, packed_sales_qty, loaded_qty, confirmed, confirmed_at FROM sales_order_lines WHERE id=$1", [f.lineId]);
  const row = result.rows[0];
  return { packed: Number(row.packed_piece_qty), sales: Number(row.packed_sales_qty), loaded: Number(row.loaded_qty), confirmed: row.confirmed, at: row.confirmed_at };
}

function confirm(f, pieces, quantityMode = "absolute") {
  return confirmCustomerPickupLine(f.orderId, f.lineId, { pieces, quantityMode }, f.operator.id);
}

test("pickup absolute confirmation replaces totals, clears zero, and loads exactly the saved total", async () => {
  await fixture({}, async (f) => {
    for (const value of [5, 5, 7, 3]) {
      await confirm(f, value);
      assert.equal((await lineState(f)).packed, value);
    }
    await confirm(f, 0);
    assert.deepEqual(await lineState(f), { packed: 0, sales: 0, loaded: 0, confirmed: false, at: null });
    await confirm(f, 7);
    await recordCustomerPickupLoad(f.orderId, f.operator.id, { photoDataUrls: ["data:image/png;base64,dGVzdA=="] });
    assert.deepEqual(await lineState(f), { packed: 0, sales: 0, loaded: 7, confirmed: false, at: null });
    await confirm(f, 20);
    assert.equal((await lineState(f)).packed, 13);
  });
});

test("pickup page confirmation preserves totals and reports invalid modes without mutating failed lines", async () => {
  await fixture({}, async (f) => {
    await confirm(f, 5);
    const request = [{ lineId: f.lineId, values: { pieces: 5, quantityMode: "absolute" } }];
    const result = await confirmCustomerPickupLines(f.orderId, [...request, ...request], f.operator.id);
    assert.equal(result.confirmed, 1);
    assert.equal((await lineState(f)).packed, 5);
    await assert.rejects(confirm(f, 7, "invalid"), (error) => error.status === 400);
    assert.equal((await lineState(f)).packed, 5);
  });
});

test("pickup legacy confirmation remains additive", async () => {
  await fixture({}, async (f) => {
    await confirmCustomerPickupLine(f.orderId, f.lineId, { pieces: 5 }, f.operator.id);
    await confirmCustomerPickupLine(f.orderId, f.lineId, { pieces: 2 }, f.operator.id);
    assert.equal((await lineState(f)).packed, 7);
  });
});

test("pickup invalid modes reject the entire batch before any quantity changes", async () => {
  await fixture({}, async (f) => {
    await confirm(f, 5);
    for (const quantityMode of ["", null, false, {}, "ABSOLUTE"]) {
      await assert.rejects(confirm(f, 7, quantityMode), (error) => error.status === 400);
    }
    await assert.rejects(confirmCustomerPickupLines(f.orderId, [
      { lineId: f.lineId, values: { pieces: 7, quantityMode: "absolute" } },
      { lineId: "missing-line", values: { pieces: 1, quantityMode: "bad" } }
    ], f.operator.id), (error) => error.status === 400);
    assert.equal((await lineState(f)).packed, 5);
  });
});

test("pickup absolute pallet, layer and section adjustments preserve their units", async () => {
  for (const [key, column, conversion] of [["pallets", "pallet", "plt"], ["layers", "layer", "lyr"], ["sections", "section", "sec"]]) {
    await fixture({}, async (f) => {
      await query(`UPDATE sales_order_lines SET piece_qty=0, to_pcs=0, ${column}_qty=5, to_${conversion}=4 WHERE id=$1`, [f.lineId]);
      for (const value of [1, 2, 2, 0]) {
        await confirmCustomerPickupLine(f.orderId, f.lineId, { [key]: value, quantityMode: "absolute" }, f.operator.id);
        const result = await query(`SELECT packed_${column}_qty AS packed, confirmed FROM sales_order_lines WHERE id=$1`, [f.lineId]);
        assert.equal(Number(result.rows[0].packed), value);
        assert.equal(result.rows[0].confirmed, value > 0);
      }
    });
  }
});

test("pickup absolute quantities are repeatable and bounded across physical and sales units", async () => {
  for (const conversion of [0, 1, 2]) {
    await fixture({ quantity: 40, loaded: 4, conversion }, async (f) => {
      await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 60 }), async (value) => {
        const values = { pieces: value, salesQty: conversion ? 0 : value, quantityMode: "absolute" };
        const expected = Math.min(36 / (conversion || 1), value);
        for (let repeat = 0; repeat < 2; repeat += 1) {
          await confirmCustomerPickupLine(f.orderId, f.lineId, values, f.operator.id);
          const state = await lineState(f);
          assert.equal(conversion ? state.packed : state.sales, expected);
          assert.equal(state.confirmed, expected > 0);
          assert.equal(state.loaded, 4);
        }
      }), { numRuns: 15, seed: 20260911 });
    });
  }
});
