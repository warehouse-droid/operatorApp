import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../../../src/server.js", import.meta.url), "utf8");

test("P3.11 HTTP wiring authorizes the live Dispatcher pilot before the dedicated BIN confirmation service", () => {
  assert.match(source, /import \{ confirmMbtBinDispatchPlan \} from "\.\/mbt\/bin-dispatch-service\.js";/u);
  assert.match(source, /import \{ authorizeMbtPhase3Capability \} from "\.\/mbt\/phase3-authorization\.js";/u);
  const routeStart = source.indexOf('app.post("/api/dispatch/plans/:id/confirm"');
  const routeEnd = source.indexOf('app.post("/api/dispatch/plans/:id/reopen"', routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  const route = source.slice(routeStart, routeEnd);
  assert.match(route, /binDispatchOrders\(planForConfirm\)/u);
  assert.match(route, /pilotAuthorized\s*=\s*operatorHasAnyRole\(req\.operator, \["admin", "dispatcher"\]\)/u);
  const authorization = route.indexOf("await authorizeMbtPhase3Capability");
  const dedicatedConfirmation = route.indexOf("await confirmMbtBinDispatchPlan");
  assert.ok(authorization >= 0 && dedicatedConfirmation > authorization);
  assert.match(route, /capability:\s*"binDispatch",\s*pilotAuthorized/u);
  assert.match(route, /environmentEnabled:\s*true,\s*databaseEnabled:\s*true,\s*pilotAuthorized:\s*true/u);
  assert.match(route, /:\s*await confirmDispatchPlan\(req\.params\.id/u);
});
