// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import { actualArrivalServiceInternals } from "../../../src/dispatch-actual-arrival-service.js";

const {
  buildPhysicalVisits,
  nextTorontoElevenPm,
  samePhysicalPlace
} = actualArrivalServiceInternals;

test("physical route reconstruction groups logical jobs and follows completion chronology", () => {
  const records = [{
    id: 3,
    job_id: "VISIT-B-2",
    plan_id: 44,
    driver_login: "sety",
    load_id: "LOAD-1",
    load_name: "Load 1",
    stop_id: "STOP-B-2",
    stop_type: "dropoff",
    order_refs: ["SO-B2"],
    truck_plate: "CE94489",
    started_at: "2026-08-17T12:18:00.000Z",
    completed_at: "2026-08-17T14:19:00.000Z",
    job_details: {
      dropAddress: "200 Destination Road",
      physicalVisitJobIds: ["VISIT-B-1", "VISIT-B-2"]
    }
  }, {
    id: 1,
    job_id: "VISIT-A",
    plan_id: 44,
    driver_login: "sety",
    load_id: "LOAD-1",
    load_name: "Load 1",
    stop_id: "STOP-A",
    stop_type: "pickup",
    order_refs: ["PO-A"],
    truck_plate: "CE94489",
    started_at: "2026-08-17T11:30:00.000Z",
    completed_at: "2026-08-17T12:18:00.000Z",
    job_details: {
      address: "100 Origin Road",
      physicalVisitJobIds: ["VISIT-A"]
    }
  }, {
    id: 2,
    job_id: "VISIT-B-1",
    plan_id: 44,
    driver_login: "sety",
    load_id: "LOAD-1",
    load_name: "Load 1",
    stop_id: "STOP-B-1",
    stop_type: "dropoff",
    order_refs: ["SO-B1"],
    truck_plate: "CE94489",
    started_at: "2026-08-17T12:18:00.000Z",
    completed_at: "2026-08-17T14:18:00.000Z",
    job_details: {
      dropAddress: "200 Destination Road",
      physicalVisitJobIds: ["VISIT-B-1", "VISIT-B-2"]
    }
  }];

  const visits = buildPhysicalVisits(records);
  assert.equal(visits.length, 2);
  assert.deepEqual(visits[0].jobIds, ["VISIT-A"]);
  assert.deepEqual(visits[1].jobIds, ["VISIT-B-1", "VISIT-B-2"]);
  assert.deepEqual(visits[1].orderRefs, ["SO-B1", "SO-B2"]);
  assert.equal(visits[1].completedAt, "2026-08-17T14:19:00.000Z");
});

test("same-site stops are recognized by normalized address or coordinates", () => {
  assert.equal(samePhysicalPlace(
    { destinationAddress: "2967 Kennedy Road, Toronto, ON" },
    { destinationAddress: "2967 KENNEDY ROAD TORONTO ON" },
    null,
    null
  ), true);
  assert.equal(samePhysicalPlace(
    { destinationAddress: "Origin" },
    { destinationAddress: "Destination" },
    { latitude: 43.8, longitude: -79.3 },
    { latitude: 43.8001, longitude: -79.3001 }
  ), true);
  assert.equal(samePhysicalPlace(
    { destinationAddress: "Origin" },
    { destinationAddress: "Destination" },
    { latitude: 43.8, longitude: -79.3 },
    { latitude: 43.81, longitude: -79.31 }
  ), false);
});

test("the retry clock resolves 11 PM Toronto across summer, winter, and the next-day boundary", () => {
  assert.equal(
    nextTorontoElevenPm(new Date("2026-08-17T20:00:00.000Z")),
    "2026-08-18T03:00:00.000Z"
  );
  assert.equal(
    nextTorontoElevenPm(new Date("2026-08-18T03:30:00.000Z")),
    "2026-08-19T03:00:00.000Z"
  );
  assert.equal(
    nextTorontoElevenPm(new Date("2026-01-10T15:00:00.000Z")),
    "2026-01-11T04:00:00.000Z"
  );
});
