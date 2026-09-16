import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { operatorRequestPath, operatorRouteId } from "../../../src/operator-yard-route.js";

test("the reported VRMA colon is decoded only after the order segment is selected", () => {
  const original = "/api/delivery/orders/VRMA%3ARP-UNI-AYR-3445-0914-1/lines/confirm-page?locationId=1";
  const path = operatorRequestPath(original);
  assert.equal(path, original.split("?")[0]);
  assert.equal(operatorRouteId(path.split("/")[4]), "VRMA:RP-UNI-AYR-3445-0914-1");
});

test("numeric, negative, UUID and literal percent identifiers preserve one decoding boundary", () => {
  for (const id of ["123", "-123", "CO-EXAMPLE", "6e114f14-782b-4d17-9ddc-07b1c45f50cf", "VRMA:RP%3A%2F", "VRMA:RP/a?b#c+é"]) {
    assert.equal(operatorRouteId(encodeURIComponent(id)), id);
  }
  assert.equal(operatorRequestPath("/api/delivery/orders/123/?locationId=1"), "/api/delivery/orders/123");
  assert.equal(operatorRequestPath("/api/delivery/orders/123"), "/api/delivery/orders/123");
  assert.equal(operatorRequestPath(""), "");
});

test("malformed percent encoding has a controlled HTTP 400 outcome", () => {
  for (const id of ["%", "%G0", "%C0%AF", "%E0%A4"]) {
    assert.throws(() => operatorRouteId(id), error => error.status === 400 && /encoding/i.test(error.message));
  }
});

test("property: URL boundaries remain raw and every encoded identifier round-trips once", () => {
  fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 80 }), fc.constantFrom(":", "/", "?", "#", "%3A", "%2F", "+", "é"), (text, marker) => {
    const id = `VRMA:${text}${marker}`, encoded = encodeURIComponent(id);
    const path = operatorRequestPath(`/api/delivery/orders/${encoded}/lines/confirm-page?locationId=1`);
    assert.equal(path.split("/").length, 7);
    assert.equal(path.split("/")[4], encoded);
    assert.equal(operatorRouteId(path.split("/")[4]), id);
  }), { seed: 20260915, numRuns: 300 });
});
