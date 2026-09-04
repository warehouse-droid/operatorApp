import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { planJobsForDriver } from "../../../src/driver-repository.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const driverSource = fs.readFileSync(path.resolve(here, "../../../public/driver.js"), "utf8");
const serviceWorkerSource = fs.readFileSync(path.resolve(here, "../../../public/driver-service-worker.js"), "utf8");
const repositorySource = fs.readFileSync(path.resolve(here, "../../../src/driver-repository.js"), "utf8");
const serverSource = fs.readFileSync(path.resolve(here, "../../../src/server.js"), "utf8");

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `Missing ${endMarker}`);
  return source.slice(start, end);
}

function fixture() {
  return {
    id: 91,
    planDate: "2026-09-03",
    ownYards: [{ code: "3445", address: "3445 Kennedy Road, Toronto, ON" }],
    orders: [{
      id: "SO-A",
      type: "SO",
      pickupLocations: ["3445"],
      address: "55 Customer Road, Milton",
      items: [{ lineRowId: "A", pallets: 3 }]
    }, {
      id: "SO-B",
      type: "SO",
      pickupLocations: ["3445"],
      address: "55 Customer Road, Milton",
      items: [{ lineRowId: "B", pallets: 2 }]
    }],
    trucks: [{
      id: "T",
      plate: "T",
      driver: "Driver",
      driverLogin: "driver",
      base: "3445",
      loads: [{
        id: "L",
        name: "Load 1",
        stops: [
          { id: "P-A", type: "pick", location: "3445", orderId: "SO-A", orderRefs: ["SO-A"] },
          { id: "D-A", type: "drop", orderId: "SO-A", orderRefs: ["SO-A"] },
          { id: "P-B", type: "pick", location: "3445", orderId: "SO-B", orderRefs: ["SO-B"] },
          { id: "D-B", type: "drop", orderId: "SO-B", orderRefs: ["SO-B"] }
        ]
      }]
    }]
  };
}

test("RP-07 repeat pickups create independent Driver jobs and scoped manifests", () => {
  const jobs = planJobsForDriver(fixture(), "driver");
  const pickups = jobs.filter((job) => job.stopType === "pickup");
  assert.equal(pickups.length, 2);
  assert.notEqual(pickups[0].jobId, pickups[1].jobId);
  assert.deepEqual(pickups.map((job) => job.stopId), ["P-A", "P-B"]);
  assert.deepEqual(pickups.map((job) => job.orderRefs), [["SO-A"], ["SO-B"]]);
  assert.ok(pickups.every((job) => job.physicalVisitJobIds.length === 1));
});

test("RP-07 Driver PWA keeps safe automatic plan refresh with no readiness handshake", () => {
  assert.match(driverSource, /dispatch\.plan\.saved/);
  assert.match(driverSource, /function shouldDeferIncomingManifest/);
  assert.match(driverSource, /saveManifestAtomic\([\s\S]*\{ complete: true, activate \}/);
  assert.match(driverSource, /if \(activeRest \|\| photoInteractionActive\(\)\)[\s\S]*onlineRouteRevalidationQueued = true/);
  assert.match(driverSource, /queueLiveRefresh\(\)/);
  assert.doesNotMatch(driverSource, /pickup.?visit.?readiness|revisit.?readiness/iu);
  assert.match(serviceWorkerSource, /driver\.js/);
});

test("RP-02 active inter-stop travel persists its exact destination stop", () => {
  const builder = sourceBetween(repositorySource, "function buildInterStopTravelJob", "function buildReturnJob");
  const details = sourceBetween(repositorySource, "function driverJobRecordDetails", "export async function startDriverJob");
  assert.match(builder, /fromStopId:\s*previousStop\.id/);
  assert.match(builder, /toStopId:\s*stop\.id/);
  assert.match(details, /fromStopId:\s*job\.fromStopId/);
  assert.match(details, /toStopId:\s*job\.toStopId/);
});

test("RP-05 online Driver start and completion serialize with plan mutations", () => {
  const start = sourceBetween(serverSource, "async function startDriverPhysicalVisitJobs", "async function startDriverPhysicalVisitOperationalEffects");
  const complete = sourceBetween(serverSource, "export async function completeDriverJobOperationalEffects", "function driverRequestClientVersion");
  assert.match(start, /DISPATCH_FLEET_PLANNING_LOCK/);
  assert.match(start, /pg_advisory_xact_lock/);
  assert.match(complete, /DISPATCH_FLEET_PLANNING_LOCK/);
  assert.match(complete, /pg_advisory_xact_lock/);
});
