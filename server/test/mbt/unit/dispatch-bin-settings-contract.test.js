import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [client, server] = await Promise.all([
  readFile(new URL("../../../public/dispatch-setup.js", import.meta.url), "utf8"),
  readFile(new URL("../../../src/server.js", import.meta.url), "utf8")
]);

test("P3-F10 Dispatch Trucks UI explicitly edits Flatbed/Bin capabilities on the shared fleet", () => {
  assert.match(client, /name=["']truckType["']/);
  assert.match(client, />Flatbed</);
  assert.match(client, />Bin</);
  assert.match(client, /name=["']binSlotCapacity["']/);
  for (const size of ["14YD", "20YD", "40YD"]) {
    assert.match(client, new RegExp(size));
  }
  assert.match(client, /supportedBinTypeCodes/);
  assert.match(client, /expectedRevision/);
  assert.match(client, /\/api\/dispatch\/setup\/trucks\/[^\s`"']+\/capabilities/);
});

test("P3-F10 typed capability command is a new guarded Dispatch setup seam", () => {
  assert.match(server, /put\(["']\/api\/dispatch\/setup\/trucks\/:id\/capabilities["']/i);
  assert.match(server, /requireDispatcher/);
  assert.match(server, /updateDispatchTruckCapabilities/);
  assert.match(server, /idempotency-key/i);
  assert.match(server, /no-store/i);
});
