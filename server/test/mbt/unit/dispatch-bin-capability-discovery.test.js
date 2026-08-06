import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routerSource = await readFile(
  new URL("../../../src/mbt/router.js", import.meta.url),
  "utf8"
);

test("P3 compatibility: Dispatch capability discovery applies the specific environment and caller pilot gates", () => {
  const start = routerSource.indexOf('router.get("/status"');
  const end = routerSource.indexOf('router.get("/config"', start);
  assert.ok(start >= 0 && end > start, "The authenticated MBT status route must exist.");
  const route = routerSource.slice(start, end);
  assert.match(route, /normalizedRoles\(requestOperator\(req\)\)/u);
  assert.match(
    route,
    /authorizePhase3Capability\(\{\s*capability:\s*"binDispatch",\s*pilotAuthorized\s*\}\)/u,
    "Discovery must use the same Phase 3 authorizer as BIN operational routes."
  );
  assert.match(route, /error\?\.code\s*!==\s*"MBT_CAPABILITY_DISABLED"/u);
  assert.match(route, /operational:\s*Object\.values\(capabilities\)\.some/u);
});
