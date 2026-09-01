import readline from "node:readline";

import { beginRollbackContext, closeDb, query } from "./db.js";
import { startDriverJob } from "./driver-repository.js";
import { completeDriverJobOperationalEffects } from "./server.js";

function check(condition, message, details = {}) {
  if (condition) return;
  const error = new Error(message);
  error.details = details;
  throw error;
}

function integer(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

async function readCorpus() {
  const entries = [];
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const sourceLine of lines) {
    const line = sourceLine.trim();
    if (!line) continue;
    entries.push(JSON.parse(line));
  }
  return entries;
}

function incrementCount(map, key, amount = 1) {
  map.set(key, (map.get(key) || 0) + amount);
}

function sortedCounts(map) {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

const corpus = await readCorpus();
const expectedCount = integer(process.env.DRIVER_REPLAY_EXPECTED_COUNT, corpus.length);
const fromDate = String(process.env.DRIVER_REPLAY_FROM_DATE || "").trim();
const toDate = String(process.env.DRIVER_REPLAY_TO_DATE || "").trim();

check(corpus.length > 0, "The Driver replay corpus is empty.");
check(corpus.length === expectedCount, "The Driver replay corpus count changed during capture.", {
  expectedCount,
  actualCount: corpus.length
});

const sourceKeys = new Set();
const visits = new Map();
for (const [index, entry] of corpus.entries()) {
  const sourceKey = String(entry.sourceKey || "");
  const visitKey = String(entry.visitKey || "");
  const planDate = String(entry.planDate || "");
  check(/^[a-f0-9]{32}$/.test(sourceKey), "A replay row has an invalid anonymized source key.", { index });
  check(/^[a-f0-9]{32}$/.test(visitKey), "A replay row has an invalid anonymized visit key.", { index });
  check(!sourceKeys.has(sourceKey), "The replay corpus contains a duplicate Driver job.", { sourceKey });
  check(["pickup", "dropoff", "travel"].includes(entry.stopType), "The replay corpus contains an unsupported stop type.", {
    sourceKey,
    stopType: entry.stopType
  });
  check(!fromDate || planDate >= fromDate, "A replay job predates the requested corpus window.", { sourceKey, planDate, fromDate });
  check(!toDate || planDate <= toDate, "A replay job exceeds the requested corpus window.", { sourceKey, planDate, toDate });
  sourceKeys.add(sourceKey);
  if (!visits.has(visitKey)) visits.set(visitKey, []);
  visits.get(visitKey).push({ ...entry, corpusIndex: index });
}

for (const [visitKey, entries] of visits.entries()) {
  const declaredSizes = new Set(entries.map((entry) => integer(entry.declaredVisitSize, 1)));
  check(declaredSizes.size === 1 && declaredSizes.has(entries.length), "A consolidated physical visit is incomplete in the replay corpus.", {
    visitKey,
    declaredSizes: [...declaredSizes],
    actualSize: entries.length
  });
  check(new Set(entries.map((entry) => entry.stopType)).size === 1, "A replay physical visit mixes stop types.", { visitKey });
}

const rollback = await beginRollbackContext();
try {
  await rollback.run(async () => {
    let replayedJobs = 0;
    let replayedVisits = 0;
    const byDate = new Map();
    const byStopType = new Map();
    const byOriginalStatus = new Map();

    for (const [visitIndex, [visitKey, entries]] of [...visits.entries()].entries()) {
      const jobIds = entries.map((entry, memberIndex) =>
        `seven-day-replay:${visitIndex}:${memberIndex}:${entry.sourceKey}`
      );
      const routeJobs = entries.map((entry, memberIndex) => {
        const orderRefCount = integer(entry.orderRefCount, 0);
        return {
          jobId: jobIds[memberIndex],
          planId: null,
          planDate: entry.planDate,
          driverLogin: `replay-${String(entry.driverKey || "driver").slice(0, 12)}`,
          driverName: "Seven-day replay",
          truckId: `REPLAY-TRUCK-${visitIndex}`,
          truckPlate: `REPLAY-${visitIndex}`,
          loadId: `REPLAY-LOAD-${visitKey}`,
          loadName: `Replay visit ${visitIndex + 1}`,
          stopId: `REPLAY-STOP-${memberIndex}-${entry.sourceKey}`,
          stopType: entry.stopType,
          orderRefs: Array.from({ length: orderRefCount }, (_unused, orderIndex) =>
            `REPLAY-ORDER-${entry.sourceKey}-${orderIndex}`
          ),
          requiredPhotos: integer(entry.requiredPhotos, entry.stopType === "travel" ? 0 : 2),
          physicalVisitJobIds: [...jobIds],
          physicalVisitStopIds: jobIds.map((_jobId, stopIndex) => `REPLAY-STOP-${stopIndex}-${visitKey}`),
          consolidatedPhysicalVisit: jobIds.length > 1,
          dependencyPickupManifests: [],
          orders: []
        };
      });
      const driverLogin = routeJobs[0].driverLogin;
      for (const job of routeJobs) await startDriverJob(driverLogin, job.jobId, { job });

      const requiredPhotos = Math.max(...routeJobs.map((job) => job.requiredPhotos));
      const effectiveRequiredPhotos = requiredPhotos === 0 ? 0 : Math.max(2, requiredPhotos);
      const photoDataUrls = Array.from({ length: effectiveRequiredPhotos }, (_unused, photoIndex) =>
        `r2://driver-seven-day-replay/${visitKey}/${photoIndex + 1}.jpg`
      );
      const completion = await completeDriverJobOperationalEffects({
        driverLogin,
        job: routeJobs[0],
        routeJobs,
        photoDataUrls
      });
      check(completion.records.length === routeJobs.length, "A physical visit did not complete every logical Driver job.", {
        visitKey,
        expected: routeJobs.length,
        actual: completion.records.length
      });

      const firstPass = await query(
        `SELECT job_id, status, photo_data_urls
           FROM driver_job_records
          WHERE job_id = ANY($1::text[])
          ORDER BY job_id`,
        [jobIds]
      );
      check(firstPass.rowCount === jobIds.length
        && firstPass.rows.every((record) => record.status === "complete")
        && firstPass.rows.every((record) => record.photo_data_urls.length === effectiveRequiredPhotos),
      "A replayed Driver job did not retain its completed status and required photo evidence.", {
        visitKey,
        records: firstPass.rows.map((record) => ({
          jobId: record.job_id,
          status: record.status,
          photoCount: record.photo_data_urls.length
        }))
      });

      await completeDriverJobOperationalEffects({
        driverLogin,
        job: routeJobs[0],
        routeJobs,
        photoDataUrls: [...photoDataUrls].reverse()
      });
      const retryPass = await query(
        `SELECT job_id, status, photo_data_urls
           FROM driver_job_records
          WHERE job_id = ANY($1::text[])
          ORDER BY job_id`,
        [jobIds]
      );
      check(JSON.stringify(retryPass.rows) === JSON.stringify(firstPass.rows),
        "Retrying a replayed physical visit changed its durable completion evidence.", { visitKey });

      replayedVisits += 1;
      replayedJobs += routeJobs.length;
      for (const entry of entries) {
        incrementCount(byDate, entry.planDate);
        incrementCount(byStopType, entry.stopType);
        incrementCount(byOriginalStatus, entry.originalStatus);
      }
    }

    check(replayedJobs === corpus.length, "Not every captured Driver job was replayed.", {
      replayedJobs,
      corpusJobs: corpus.length
    });
    console.log(JSON.stringify({
      status: "passed",
      fromDate,
      toDate,
      replayedJobs,
      replayedPhysicalVisits: replayedVisits,
      consolidatedPhysicalVisits: [...visits.values()].filter((entries) => entries.length > 1).length,
      byDate: sortedCounts(byDate),
      byStopType: sortedCounts(byStopType),
      byOriginalStatus: sortedCounts(byOriginalStatus)
    }));
  });
} finally {
  await rollback.rollback();
  await closeDb();
}
