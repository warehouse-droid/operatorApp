import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync(new URL("../../../src/server.js", import.meta.url), "utf8");
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}
function locationCheck(distanceMeters, failedLookup = false) {
  const context = vm.createContext({
    samsaraLocationForDriverJob: async () => {
      if (failedLookup) throw new Error("GPS unavailable");
      return {latitude: distanceMeters / 6371000 * 180 / Math.PI, longitude: 0, plate: "TEST"};
    },
    expectedPointForDriverJob: async () => ({latitude: 0, longitude: 0, address: "Fixture stop"})
  });
  vm.runInContext(section("function coordinateDistanceMeters(", "function truckLocationChanged("), context);
  vm.runInContext(section("function validCoordinate(", "async function geocodeStopAddress("), context);
  vm.runInContext(section("async function checkDriverJobLocation(", "async function startDriverPhysicalVisitJobs("), context);
  return context.checkDriverJobLocation({truckPlate: "TEST", address: "Fixture stop"});
}

for (const distance of [0, 500, 750, 999.9]) {
  test(`driver GPS accepts a stop ${distance} metres away within the requested 1 km radius`, async () => {
    const result = await locationCheck(distance);
    assert.equal(result.status, "ok");
    assert.equal(result.thresholdMeters, 1000);
  });
}
for (const distance of [1000.1, 1001, 1500]) {
  test(`driver GPS keeps an explicit warning at ${distance} metres`, async () => {
    const result = await locationCheck(distance);
    assert.equal(result.status, "warning");
    assert.equal(result.thresholdMeters, 1000);
  });
}
test("the wider radius does not turn a failed GPS lookup into approval", async () => {
  assert.equal((await locationCheck(0, true)).status, "unavailable");
});
