// @ts-check

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { parse } from "espree";

import { createFrontdeskPricingAdapter } from "../../../src/mbt/frontdesk-pricing-adapter.js";

const YARD = {
  yard_id: "00000000-0000-4000-8000-000000003445",
  yard_code: "3445",
  display_name: "3445",
  address_line_1: "3445 Kennedy Road",
  address_line_2: "",
  city: "Toronto",
  region: "ON",
  postal_code: "",
  country_code: "CA",
  latitude: "43.8204306",
  longitude: "-79.3053423",
  revision: "2"
};

test("server pricing resolves and hashes a toll-free Google route without retaining the API key", async () => {
  const requests = [];
  const adapter = createFrontdeskPricingAdapter({
    database: {
      async query(_sql, values) {
        assert.deepEqual(values, ["3445"]);
        return { rowCount: 1, rows: [YARD] };
      }
    },
    async routeEstimator(input) {
      requests.push(input);
      return {
        source: "google_routes_v2",
        distanceMeters: 31_000,
        legDistanceMeters: [12_500, 18_500],
        rawLegMinutes: [17, 25],
        fallbackReason: ""
      };
    }
  });

  const result = await adapter.resolveDistance({
    originYardCode: "3445",
    serviceAddressText: "100 Queen Street West, Toronto, ON"
  });

  assert.equal(result.provider, "google_routes_v2");
  assert.equal(result.providerMetres, 31_000);
  assert.match(result.routeHash, /^[0-9a-f]{64}$/u);
  assert.equal(result.originSnapshot.kind, "yard");
  assert.equal(result.originSnapshot.yardCode, "3445");
  assert.equal(result.destinationSnapshot.addressText, "100 Queen Street West, Toronto, ON");
  assert.deepEqual(result.routeSnapshot.legMetres, [12_500, 18_500]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].allowTolls, false);
  assert.equal(requests[0].reason, "frontdesk_distance");
  assert.doesNotMatch(JSON.stringify(result), /secret/u);
});

test("server pricing also accepts explicit origin and destination addresses for local MBBS calculation", async () => {
  let databaseReads = 0;
  const adapter = createFrontdeskPricingAdapter({
    database: { async query() { databaseReads += 1; return { rowCount: 0, rows: [] }; } },
    async routeEstimator() {
      return { source: "google_routes_v2", distanceMeters: 75_001, legDistanceMeters: [75_001], rawLegMinutes: [67] };
    }
  });
  const result = await adapter.resolveDistance({
    originAddressText: "Vendor yard, Vaughan, ON",
    destinationAddressText: "2967 Kennedy Road, Toronto, ON"
  });
  assert.equal(result.providerMetres, 75_001);
  assert.equal(result.originSnapshot.kind, "address");
  assert.equal(databaseReads, 0);
});

test("server pricing fails closed without route authority and exposes the Ontario HST policy", async () => {
  const adapter = createFrontdeskPricingAdapter({});
  await assert.rejects(
    () => adapter.resolveDistance({ originYardCode: "3445", serviceAddressText: "Toronto" }),
    (error) => error?.code === "MBT_FRONTDESK_DISTANCE_UNAVAILABLE" && error?.status === 503
  );
  assert.deepEqual(await adapter.resolveTaxPolicy({}), {
    code: "CA-ON-HST",
    basisPoints: 1_300,
    label: "Ontario HST 13%"
  });
});

test("the production MBT router is wired to the server-owned pricing adapter", () => {
  const source = fs.readFileSync(new URL("../../../src/server.js", import.meta.url), "utf8");
  assert.match(source, /import \{ createFrontdeskPricingAdapter \} from "\.\/mbt\/frontdesk-pricing-adapter\.js";/u);
  // Router dependencies can be added before pricing. Inspect the actual option,
  // rather than requiring frontdeskPricing to be the first object property.
  const pending = [parse(source, { ecmaVersion: "latest", sourceType: "module", range: true })];
  const calls = [];
  while (pending.length) {
    const node = pending.pop();
    if (node.type === "CallExpression" && node.callee?.name === "createMbtRouter") calls.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) pending.push(...value.filter(item => item && typeof item === "object"));
      else if (value && typeof value === "object") pending.push(value);
    }
  }
  assert.equal(calls.length, 1);
  const options = calls[0].arguments[0];
  assert.equal(options.type, "ObjectExpression");
  const pricing = options.properties.find(property => property.key?.name === "frontdeskPricing")?.value;
  assert.equal(pricing?.type, "CallExpression");
  assert.equal(pricing.callee.name, "createFrontdeskPricingAdapter");
  const estimator = pricing.arguments[0].properties.find(property => property.key?.name === "routeEstimator")?.value;
  assert.ok(estimator, "Pricing must receive the server-owned route estimator");
  assert.match(source.slice(...estimator.range), /googleMapsGateway\.estimateRoute/u);
  assert.doesNotMatch(source, /app\.use\("\/api\/mbt", requireOperator, createMbtRouter\(\)\)/u);
});
