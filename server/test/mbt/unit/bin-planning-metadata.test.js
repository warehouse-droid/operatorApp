import assert from "node:assert/strict";
import test from "node:test";
import { binBoardRouteEstimate, binBoardTravelFields, validateBinBoardStopTimings, validateBinBoardLaneOrder } from "../../../src/mbt/bin-planning-metadata.js";
import { validateBinBoard } from "../../../src/mbt/bin-planning-board.js";

const estimate = { source: "google", routeSignature: "route", routeEstimateId: "id", travelTimePercent: 0,
  rawDriveMinutes: 10, driveMinutes: 10, stayMinutes: 0, totalMinutes: 10, legMinutes: [10], rawLegMinutes: [10],
  allowTolls: false, routePath: [{ lat: 43, lng: -79 }, { lat: 44, lng: -79 }], stopCoordinates: [] };
const rejects = operation => assert.throws(operation, e => e.status === 400 && e.code === "MBT_BIN_BOARD_INVALID");
test("route metadata retains valid estimates and rejects malformed durations and geometry", () => {
  assert.equal(binBoardRouteEstimate(undefined), null); assert.equal(binBoardRouteEstimate(null), null);
  assert.deepEqual(binBoardRouteEstimate({ ...estimate, ignored: "field" }), estimate);
  for (const change of [{ source: "other" }, { routeSignature: 1 }, { routeEstimateId: "x".repeat(101) },
    { travelTimePercent: Infinity }, { travelTimePercent: 1001 }, { driveMinutes: -1 }, { totalMinutes: 1441 },
    { legMinutes: {} }, { rawLegMinutes: Array(201).fill(1) }, { legMinutes: [-1] },
    { routePath: null }, { routePath: Array(5001).fill({ lat: 43, lng: -79 }) },
    { routePath: [null] }, { routePath: [{ lat: 91, lng: 0 }] }, { routePath: [{ lat: 0, lng: 181 }] },
    { stopCoordinates: Array(26).fill({ lat: 43, lng: -79 }) }]) { rejects(() => binBoardRouteEstimate({ ...estimate, ...change })); }
});
test("approach, lane order, starting yards and stop sequences are bounded", () => {
  assert.deepEqual(binBoardTravelFields({}), { handoffTravelMinutes: 0, handoffTravelFrom: "", handoffTravelTo: "", routeEstimate: null, truckStartYard: null });
  for (const load of [{ handoffTravelMinutes: -1 }, { handoffTravelFrom: {} }, { handoffTravelTo: "x".repeat(2001) }, { truckStartYard: 123 }]) {
    rejects(() => binBoardTravelFields(load));
  }
  for (const order of [null, {}, ["driver", "driver"], [""], [1], ["x".repeat(201)], Array(1001).fill("driver")]) { rejects(() => validateBinBoardLaneOrder(order)); }
  validateBinBoardLaneOrder(undefined); validateBinBoardLaneOrder([]); validateBinBoardLaneOrder(["driver", "unassigned"]);
  for (const rows of [Array(101).fill({ sequence: 1, arrival: 0, depart: 1 }), [{ sequence: 0, arrival: 0, depart: 1 }],
    [{ sequence: 1, arrival: 0, depart: 1 }, { sequence: 1, arrival: 1, depart: 2 }]]) { rejects(() => validateBinBoardStopTimings(rows)); }
  const load = { id: "a", truckId: "1", driverId: "1", startMode: "auto", driverSequence: 1, visits: [], truckStartYard: "12441" };
  rejects(() => validateBinBoard({ trucks: [] }, [load, { ...load, id: "b", truckStartYard: "3445" }]));
});
