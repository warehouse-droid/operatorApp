import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { scmCumulativeProgressObserved } from "../../../src/netsuite.js";

test("recognizes the short SuiteQL progress alias used by current PO refreshes", () => {
  assert.equal(scmCumulativeProgressObserved({ progress_raw: "0" }), true);
  assert.equal(scmCumulativeProgressObserved({ progress_raw: "1678.56" }), true);
  assert.equal(scmCumulativeProgressObserved({ progress_raw: null }), false);
});

test("recognizes legacy and NetSuite-truncated progress aliases", () => {
  assert.equal(scmCumulativeProgressObserved({ progress_: "12" }), true);
  assert.equal(scmCumulativeProgressObserved({ cumulative_progress_raw: "12" }), true);
  assert.equal(scmCumulativeProgressObserved({ cumulative_progress_: "12" }), true);
  assert.equal(scmCumulativeProgressObserved({}), false);
});

test("the reconciliation SuiteQL projection uses the short progress alias", async () => {
  const source = await readFile(new URL("../../../src/netsuite.js", import.meta.url), "utf8");
  assert.match(source, /tl\.quantityshiprecv AS progress_raw/);
});
