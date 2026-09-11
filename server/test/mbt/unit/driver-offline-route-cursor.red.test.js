import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const driverSource = fs.readFileSync(new URL("../../../public/driver.js", import.meta.url), "utf8");

function offlineProjector() {
  const helperSection = driverSource.slice(
    driverSource.indexOf("function driverPhysicalVisitJobIds"),
    driverSource.indexOf("function localCompletionBridge")
  );
  const projectionSection = driverSource.slice(
    driverSource.indexOf("function projectOfflineRoute"),
    driverSource.indexOf("async function restoreDraftPhotos")
  );
  assert.ok(projectionSection.includes("latestCompletedIndex"), "offline projection must encode a monotonic route cursor");
  return new Function(
    "manifestJobFor",
    "dvirEventNeedsReconciliation",
    "dutyEventNeedsReconciliation",
    "elapsedSeconds",
    "t",
    "jobIsComplete",
    `${helperSection}\n${projectionSection}\nreturn projectOfflineRoute;`
  )(
    (jobId, manifest) => (manifest?.jobs || []).find((job) => String(job.jobId) === String(jobId)) || null,
    () => false,
    () => false,
    () => 0,
    (_key, fallback) => fallback,
    (job) => ["complete", "completed", "done"].includes(String(job?.status || "").toLowerCase())
  );
}

test("offline projection sticks to a later active job and never returns to an older pending gap", () => {
  const projectOfflineRoute = offlineProjector();
  const jobs = [
    { jobId: "old-gap", status: "pending" },
    { jobId: "current", status: "in_progress", startedAt: "2026-09-08T15:10:00.000Z" },
    { jobId: "future", status: "pending" }
  ];
  const active = projectOfflineRoute({ jobs, generatedAt: "2026-09-08T15:11:00.000Z" }, []);
  assert.equal(active.currentJob?.jobId, "current");

  jobs[1] = { ...jobs[1], status: "complete", completedAt: "2026-09-08T15:20:00.000Z" };
  const advanced = projectOfflineRoute({ jobs, generatedAt: "2026-09-08T15:21:00.000Z" }, []);
  assert.equal(advanced.currentJob?.jobId, "future");
  assert.equal(advanced.jobs[0].status, "pending", "passed work remains a Dispatch exception, not fake evidence");
});
