import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const service = await readFile(
  new URL("../../../src/mbt/dispatch-truck-capability-repository.js", import.meta.url),
  "utf8"
);

test("P3-F10 hardening: a Flatbed capability save preserves its established default base-yard text", () => {
  assert.doesNotMatch(service, /baseYard:\s*type\s*===\s*["']bin["']\s*\?\s*baseYard\s*:\s*["']["']/);
  assert.match(service, /baseYard,\s*\n\s*binSlotCapacity/);
});
