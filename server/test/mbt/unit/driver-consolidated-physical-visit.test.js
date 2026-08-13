import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  driverPhysicalVisitExecutionJobs,
  driverPhysicalVisitJobIds,
  driverPhysicalVisitOrderRefs
} from "../../../src/driver-physical-visit.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverSource = fs.readFileSync(path.resolve(here, "../../../src/server.js"), "utf8");
const driverSource = fs.readFileSync(path.resolve(here, "../../../public/driver.js"), "utf8");

function consolidatedFixture() {
  const jobIds = ["plan:truck:load:drop-a", "plan:truck:load:drop-b"];
  const routeJobs = [
    {
      jobId: jobIds[0],
      stopId: "drop-a",
      stopType: "dropoff",
      planId: 41,
      loadId: "load-1",
      orderRefs: ["SO-A"],
      lineRowIds: ["line-a"],
      destinationLocationId: 15,
      physicalVisitJobIds: jobIds
    },
    {
      jobId: jobIds[1],
      stopId: "drop-b",
      stopType: "dropoff",
      planId: 41,
      loadId: "load-1",
      orderRefs: ["SO-B"],
      lineRowIds: ["line-b"],
      destinationLocationId: 15,
      physicalVisitJobIds: jobIds
    }
  ];
  const actionableJob = {
    ...routeJobs[0],
    startedAt: "2026-08-11T12:00:00.000Z",
    physicalVisitStopIds: ["drop-a", "drop-b"],
    consolidatedPhysicalVisit: true,
    detailOrderRefs: ["SO-A", "SO-B"],
    orders: [
      { orderRef: "SO-A", items: [{ sku: "ITEM-A" }] },
      { orderRef: "SO-B", items: [{ sku: "ITEM-B" }] }
    ]
  };
  return { jobIds, routeJobs, actionableJob };
}

test("a consolidated visit resolves every logical job without merging its durable identity", () => {
  const { jobIds, routeJobs, actionableJob } = consolidatedFixture();
  assert.deepEqual(driverPhysicalVisitJobIds(actionableJob), jobIds);
  assert.deepEqual(driverPhysicalVisitOrderRefs(actionableJob, routeJobs), ["SO-A", "SO-B"]);

  const jobs = driverPhysicalVisitExecutionJobs(actionableJob, routeJobs);
  assert.deepEqual(jobs.map((job) => job.jobId), jobIds);
  assert.deepEqual(jobs.map((job) => job.stopId), ["drop-a", "drop-b"]);
  assert.deepEqual(jobs.map((job) => job.orderRefs), [["SO-A"], ["SO-B"]]);
  assert.deepEqual(jobs.map((job) => job.lineRowIds), [["line-a"], ["line-b"]]);
  assert.ok(jobs.every((job) => job.orders.length === 2));
  assert.ok(jobs.every((job) => job.startedAt === actionableJob.startedAt));
});

test("a missing or cross-load visit member fails closed instead of partially completing", () => {
  const { routeJobs, actionableJob } = consolidatedFixture();
  assert.throws(
    () => driverPhysicalVisitExecutionJobs(actionableJob, routeJobs.slice(0, 1)),
    (error) => error.code === "DRIVER_PHYSICAL_VISIT_CHANGED" && error.status === 409
  );

  const inconsistent = structuredClone(routeJobs);
  inconsistent[1].loadId = "another-load";
  assert.throws(
    () => driverPhysicalVisitExecutionJobs(actionableJob, inconsistent),
    (error) => error.code === "DRIVER_PHYSICAL_VISIT_INVALID" && error.status === 409
  );
});

test("ordinary Driver jobs remain a one-record execution", () => {
  const ordinary = {
    jobId: "ordinary-job",
    stopId: "ordinary-stop",
    stopType: "dropoff",
    planId: 41,
    loadId: "load-2",
    orderRefs: ["SO-C"]
  };
  assert.deepEqual(driverPhysicalVisitJobIds(ordinary), [ordinary.jobId]);
  assert.deepEqual(driverPhysicalVisitExecutionJobs(ordinary, []), [ordinary]);
  assert.deepEqual(driverPhysicalVisitOrderRefs(ordinary, []), ["SO-C"]);
});

test("server start and completion apply the whole physical visit inside transactions", () => {
  const startSection = serverSource.slice(
    serverSource.indexOf("async function startDriverPhysicalVisitJobs"),
    serverSource.indexOf("function mergeDriverPhysicalVisitDependencyUpdates")
  );
  assert.match(startSection, /driverPhysicalVisitExecutionJobs\(job, routeJobs\)/);
  assert.match(startSection, /withTransaction\(async \(\) => \{[\s\S]*for \(const visitJob of jobs\)[\s\S]*startDriverJob/);
  assert.match(startSection, /status = 'complete'[\s\S]*completedByJobId\.has\(visitJob\.jobId\)[\s\S]*continue/,
    "Starting a remaining visit member must preserve any peer completed by an older client.");

  const completionSection = serverSource.slice(
    serverSource.indexOf("async function completeDriverJobOperationalEffects"),
    serverSource.indexOf("function driverRequestClientVersion")
  );
  assert.match(completionSection, /for \(const visitJob of physicalVisitJobs\)[\s\S]*recordDriverJobPhotos/);
  assert.ok(
    completionSection.indexOf("existingCompletedRecord")
      < completionSection.indexOf("recordDriverJobPhotos"),
    "Existing completed peer evidence must be skipped before shared photos are recorded."
  );
  assert.match(completionSection, /transferOrderRefs: visitJob\.orderRefs/);
  assert.match(completionSection, /salesOrderRefs: visitJob\.orderRefs/);
  assert.match(completionSection, /completeDispatchCustomOrders\([\s\S]*visitJob\.orderRefs/);
});

test("the offline ledger projects one event across every physical-visit member", () => {
  assert.match(
    driverSource,
    /details: \{[\s\S]*physicalVisitJobIds: driverPhysicalVisitJobIds\(manifestJob \|\| job\)/
  );
  const projectionSection = driverSource.slice(
    driverSource.indexOf("function projectOfflineRoute"),
    driverSource.indexOf("async function restoreDraftPhotos")
  );
  assert.match(projectionSection, /driverEventPhysicalVisitJobIds\(event, manifest\)/);
  assert.match(projectionSection, /for \(const visitJob of physicalVisitJobs\)[\s\S]*visitJob\.status = "in_progress"/);
  assert.match(projectionSection, /for \(const visitJob of physicalVisitJobs\)[\s\S]*visitJob\.status = "completed"/);

  const helperSection = driverSource.slice(
    driverSource.indexOf("function driverPhysicalVisitJobIds"),
    driverSource.indexOf("function localCompletionBridge")
  );
  const buildProjection = new Function(
    "manifestJobFor",
    "dvirEventNeedsReconciliation",
    "dutyEventNeedsReconciliation",
    "elapsedSeconds",
    "t",
    "jobIsComplete",
    `${helperSection}\n${projectionSection}\nreturn projectOfflineRoute;`
  );
  const projectOfflineRoute = buildProjection(
    (jobId, manifest) => (manifest?.jobs || []).find((job) => String(job.jobId) === String(jobId)) || null,
    () => false,
    () => false,
    () => 0,
    (_key, fallback) => fallback,
    (job) => ["complete", "completed", "done"].includes(String(job?.status || "").toLowerCase())
  );
  const manifest = {
    manifestId: "manifest-one-click",
    complete: true,
    generatedAt: "2026-08-11T11:00:00.000Z",
    jobs: [
      { jobId: "drop-a", status: "pending", physicalVisitJobIds: ["drop-a", "drop-b"] },
      { jobId: "drop-b", status: "pending", physicalVisitJobIds: ["drop-a", "drop-b"] },
      { jobId: "next-stop", status: "pending", physicalVisitJobIds: ["next-stop"] }
    ]
  };
  const projection = projectOfflineRoute(manifest, [{
    eventType: "job_completed",
    jobId: "drop-a",
    status: "pending",
    occurredAt: "2026-08-11T12:05:00.000Z",
    details: { physicalVisitJobIds: ["drop-a", "drop-b"] }
  }]);
  assert.deepEqual(projection.jobs.map((job) => job.status), ["completed", "completed", "pending"]);
  assert.equal(projection.currentJob.jobId, "next-stop");
});
