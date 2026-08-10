// @ts-check

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

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
    apiKey: "test-secret-key",
    database: {
      async query(_sql, values) {
        assert.deepEqual(values, ["3445"]);
        return { rowCount: 1, rows: [YARD] };
      }
    },
    async transport(url, options) {
      requests.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            status: "OK",
            routes: [{
              summary: "ON-401 E",
              legs: [
                { distance: { value: 12_500 }, duration: { value: 1_000 } },
                { distance: { value: 18_500 }, duration: { value: 1_500 } }
              ]
            }]
          };
        }
      };
    }
  });

  const result = await adapter.resolveDistance({
    originYardCode: "3445",
    serviceAddressText: "100 Queen Street West, Toronto, ON"
  });

  assert.equal(result.provider, "google_directions_v1");
  assert.equal(result.providerMetres, 31_000);
  assert.match(result.routeHash, /^[0-9a-f]{64}$/u);
  assert.equal(result.originSnapshot.kind, "yard");
  assert.equal(result.originSnapshot.yardCode, "3445");
  assert.equal(result.destinationSnapshot.addressText, "100 Queen Street West, Toronto, ON");
  assert.deepEqual(result.routeSnapshot.legMetres, [12_500, 18_500]);
  assert.equal(requests.length, 1);
  const requested = new URL(requests[0].url);
  assert.equal(requested.searchParams.get("avoid"), "tolls");
  assert.equal(requested.searchParams.get("mode"), "driving");
  assert.equal(requested.searchParams.get("key"), "test-secret-key");
  assert.doesNotMatch(JSON.stringify(result), /test-secret-key/u);
});

test("server pricing also accepts explicit origin and destination addresses for local MBBS calculation", async () => {
  let databaseReads = 0;
  const adapter = createFrontdeskPricingAdapter({
    apiKey: "test-secret-key",
    database: { async query() { databaseReads += 1; return { rowCount: 0, rows: [] }; } },
    async transport() {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            status: "OK",
            routes: [{ summary: "Local route", legs: [{ distance: { value: 75_001 }, duration: { value: 4_000 } }] }]
          };
        }
      };
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
  const adapter = createFrontdeskPricingAdapter({ apiKey: "" });
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
  assert.match(source, /createMbtRouter\(\{\s*frontdeskPricing:\s*createFrontdeskPricingAdapter\(\{\s*apiKey:\s*config\.googleMapsApiKey/u);
  assert.doesNotMatch(source, /app\.use\("\/api\/mbt", requireOperator, createMbtRouter\(\)\)/u);
});
