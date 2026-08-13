// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("server startup repairs today’s V2 summary marker before listening", async () => {
  const source = await readFile(new URL("../../../src/server.js", import.meta.url), "utf8");
  const startOffset = source.indexOf("export async function startServer()");
  const endOffset = source.indexOf("if (process.argv[1]", startOffset);
  assert.notEqual(startOffset, -1, "startServer must remain exported.");
  assert.notEqual(endOffset, -1, "startServer boundary must remain detectable.");
  const startup = source.slice(startOffset, endOffset);
  const repairOffset = startup.indexOf("await repairDispatchV2SummaryMarkers()");
  const listenOffset = startup.indexOf("app.listen(");
  assert.notEqual(repairOffset, -1, "Startup must invoke the bounded V2 summary-marker repair.");
  assert.ok(repairOffset < listenOffset, "The repair must complete before the server accepts requests.");
  assert.match(startup, /dispatchV2SummaryRepair\.repaired > 0/u);
  assert.match(startup, /Repaired .* Dispatch V2 summary marker/u);
});
