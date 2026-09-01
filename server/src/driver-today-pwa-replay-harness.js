import crypto from "node:crypto";
import http from "node:http";

import { closeDb, query } from "./db.js";
import {
  DRIVER_PWA_CURRENT_VERSION,
  DRIVER_PWA_VERSION_HEADER
} from "./driver-client-version.js";
import { getDriverDayJobs } from "./driver-repository.js";
import { app } from "./server.js";

function check(condition, message, details = {}) {
  if (condition) return;
  const error = new Error(message);
  error.details = details;
  throw error;
}

function incrementCount(map, key, amount = 1) {
  map.set(key, (map.get(key) || 0) + amount);
}

function sortedCounts(map) {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

const planDate = String(process.env.DRIVER_PWA_REPLAY_PLAN_DATE || "").trim();
const expectedDrivers = Number(process.env.DRIVER_PWA_REPLAY_EXPECTED_DRIVERS || 0);
check(/^\d{4}-\d{2}-\d{2}$/.test(planDate), "The PWA replay requires DRIVER_PWA_REPLAY_PLAN_DATE.");

let server;
let uploadServer;
try {
  let uploadSequence = 0;
  uploadServer = await new Promise((resolve) => {
    const listener = http.createServer((request, response) => {
      if (request.method !== "POST" || request.url !== "/upload") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end('{"error":"not found"}');
        return;
      }
      const authorization = String(request.headers.authorization || "");
      const contentType = String(request.headers["content-type"] || "");
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        if (!authorization.startsWith("Bearer ") || !contentType.startsWith("multipart/form-data")) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end('{"error":"invalid upload request"}');
          return;
        }
        if (Buffer.concat(chunks).length === 0) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end('{"error":"empty upload"}');
          return;
        }
        uploadSequence += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ key: `driver-pwa-replay/2026/08/28/photo-${uploadSequence}.jpg` }));
      });
    });
    listener.listen(3999, "127.0.0.1", () => resolve(listener));
  });
  await query(
    `UPDATE dispatch_drivers
        SET samsara_enabled = false,
            password_hash = null,
            password_salt = null
      WHERE active = true`
  );
  await query(
    `UPDATE mbt_feature_flags
        SET enabled = false, revision = revision + 1, updated_at = now()
      WHERE flag_key = 'driver_offline_mode'`
  );
  const assigned = await query(
    `SELECT DISTINCT lower(COALESCE(
              NULLIF(load.value->>'driverLogin', ''),
              NULLIF(truck.value->>'driverLogin', ''),
              NULLIF(load.value->>'driver', ''),
              NULLIF(truck.value->>'driver', '')
            )) AS driver_login
       FROM dispatch_plans plan
       JOIN dispatch_plan_snapshots snapshot ON snapshot.plan_id = plan.id
       CROSS JOIN LATERAL jsonb_array_elements(snapshot.trucks) AS truck(value)
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(truck.value->'loads', '[]'::jsonb)) AS load(value)
      WHERE plan.plan_date = $1::date
        AND plan.status = 'confirmed'
        AND COALESCE(
              NULLIF(load.value->>'driverLogin', ''),
              NULLIF(truck.value->>'driverLogin', ''),
              NULLIF(load.value->>'driver', ''),
              NULLIF(truck.value->>'driver', '')
            ) IS NOT NULL
      ORDER BY driver_login`,
    [planDate]
  );
  const driverLogins = assigned.rows.map((row) => row.driver_login);
  check(driverLogins.length > 0, "The cloned plan has no assigned PWA drivers.");
  check(!expectedDrivers || driverLogins.length === expectedDrivers,
    "The cloned plan's assigned Driver count differs from the production snapshot.", {
      expectedDrivers,
      actualDrivers: driverLogins.length
    });

  server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const byStopType = new Map();
  let pwaActions = 0;
  let uploadedPhotos = 0;
  let completedLogicalJobs = 0;
  let expectedLogicalJobs = 0;

  for (const [driverIndex, driverLogin] of driverLogins.entries()) {
    const deviceId = crypto.randomUUID();
    let token = "";
    const request = async (path, { method = "GET", body } = {}) => {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          "x-mbbs-driver-device": deviceId,
          [DRIVER_PWA_VERSION_HEADER]: DRIVER_PWA_CURRENT_VERSION
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const payload = await response.json().catch(() => ({}));
      return { response, payload };
    };

    const login = await request("/api/driver/login", {
      method: "POST",
      body: { username: driverLogin, password: "", deviceId }
    });
    check(login.response.status === 200, "A cloned PWA driver could not sign in.", {
      driverIndex,
      status: login.response.status,
      error: login.payload.error
    });
    token = login.payload.token;

    const initialRoute = await getDriverDayJobs(driverLogin, { date: planDate });
    const expectedJobIds = new Set(initialRoute.jobs.map((job) => String(job.jobId)));
    expectedLogicalJobs += expectedJobIds.size;
    check(expectedJobIds.size > 0, "A cloned assigned Driver has no materialized PWA jobs.", { driverIndex });

    const completedIds = new Set();
    const visitedActions = new Set();
    for (let actionIndex = 0; actionIndex <= expectedJobIds.size + 5; actionIndex += 1) {
      const next = await request(`/api/driver/next-job?revalidate=${Date.now()}`);
      check(next.response.status === 200, "The online-only PWA could not load its next job.", {
        driverIndex,
        actionIndex,
        status: next.response.status,
        error: next.payload.error
      });
      const job = next.payload.job;
      if (!job) {
        check(next.payload.state?.allJobsComplete === true, "The PWA route ended without all jobs complete.", {
          driverIndex,
          state: next.payload.state
        });
        break;
      }
      check(expectedJobIds.has(String(job.jobId)), "The PWA returned a job outside the cloned route.", {
        driverIndex,
        jobId: job.jobId
      });
      check(!visitedActions.has(String(job.jobId)), "The PWA repeated the same next job after completion.", {
        driverIndex,
        jobId: job.jobId
      });
      visitedActions.add(String(job.jobId));

      if (job.stopType === "truck_switch") {
        const switched = await request(`/api/driver/jobs/${encodeURIComponent(job.jobId)}/skip-samsara`, {
          method: "POST",
          body: {}
        });
        check(switched.response.status === 200, "The online PWA truck-switch action failed.", {
          driverIndex,
          jobId: job.jobId,
          status: switched.response.status,
          error: switched.payload.error
        });
      } else {
        const started = await request(`/api/driver/jobs/${encodeURIComponent(job.jobId)}/start`, {
          method: "POST",
          body: { deviceOccurredAt: new Date().toISOString() }
        });
        check(started.response.status === 200, "The online PWA could not start a job.", {
          driverIndex,
          jobId: job.jobId,
          stopType: job.stopType,
          status: started.response.status,
          error: started.payload.error
        });
        await query(
          `UPDATE driver_job_records
              SET started_at = now() - interval '11 seconds'
            WHERE lower(driver_login) = lower($1)
              AND status = 'in_progress'`,
          [driverLogin]
        );

        const requiredPhotos = Number(job.requiredPhotos || 0) > 0
          ? Math.max(2, Number(job.requiredPhotos || 0))
          : 0;
        const photoDataUrls = [];
        for (let photoIndex = 0; photoIndex < requiredPhotos; photoIndex += 1) {
          const uploadToken = await request("/api/driver/photo-upload-token", {
            method: "POST",
            body: {
              recordType: "driver-stop-photo",
              jobId: job.jobId,
              planId: job.planId,
              loadId: job.loadId,
              stopId: job.stopId,
              mimeType: "image/jpeg"
            }
          });
          check(uploadToken.response.status === 200, "The online PWA could not prepare a photo upload.", {
            driverIndex,
            jobId: job.jobId,
            photoIndex,
            status: uploadToken.response.status,
            error: uploadToken.payload.error
          });
          const formData = new FormData();
          formData.append(
            "file",
            new Blob([Buffer.from([0xff, 0xd8, driverIndex, actionIndex, photoIndex, 0xff, 0xd9])], { type: "image/jpeg" }),
            `driver-stop-photo-${photoIndex + 1}.jpg`
          );
          const uploaded = await fetch(uploadToken.payload.uploadUrl, {
            method: "POST",
            headers: { Authorization: `Bearer ${uploadToken.payload.token}` },
            body: formData
          });
          const uploadedPayload = await uploaded.json().catch(() => ({}));
          check(uploaded.status === 200 && uploadedPayload.key,
            "The online PWA photo worker did not return durable object evidence.", {
              driverIndex,
              jobId: job.jobId,
              photoIndex,
              status: uploaded.status,
              error: uploadedPayload.error
            });
          photoDataUrls.push(`r2://${uploadedPayload.key}`);
        }
        const completed = await request(`/api/driver/jobs/${encodeURIComponent(job.jobId)}/photos`, {
          method: "POST",
          body: {
            photoDataUrls,
            locationOverride: true,
            autoStartNext: false
          }
        });
        check(completed.response.status === 200, "The online PWA could not upload evidence and complete a job.", {
          driverIndex,
          jobId: job.jobId,
          stopType: job.stopType,
          status: completed.response.status,
          error: completed.payload.error
        });
        uploadedPhotos += photoDataUrls.length;
      }

      const logicalJobIds = Array.isArray(job.physicalVisitJobIds) && job.physicalVisitJobIds.length
        ? job.physicalVisitJobIds.map(String)
        : [String(job.jobId)];
      for (const jobId of logicalJobIds) completedIds.add(jobId);
      incrementCount(byStopType, job.stopType, logicalJobIds.length);
      pwaActions += 1;
    }

    const persisted = await query(
      `SELECT job_id, stop_type, status, photo_data_urls
         FROM driver_job_records
        WHERE job_id = ANY($1::text[])
        ORDER BY job_id`,
      [[...expectedJobIds]]
    );
    check(persisted.rowCount === expectedJobIds.size
      && persisted.rows.every((record) => record.status === "complete")
      && persisted.rows.every((record) => record.stop_type === "travel"
        || record.stop_type === "truck_switch"
        || record.photo_data_urls.length >= 2),
    "The PWA did not persist complete status and required evidence for every cloned route job.", {
      driverIndex,
      expected: expectedJobIds.size,
      persisted: persisted.rows.map((record) => ({
        jobId: record.job_id,
        stopType: record.stop_type,
        status: record.status,
        photoCount: record.photo_data_urls.length
      }))
    });
    check(completedIds.size === expectedJobIds.size,
      "The PWA action sequence did not cover every logical job in a consolidated visit.", {
        driverIndex,
        expected: expectedJobIds.size,
        completed: completedIds.size
      });
    completedLogicalJobs += completedIds.size;
  }

  check(completedLogicalJobs === expectedLogicalJobs,
    "The online PWA replay did not complete the entire cloned plan.", {
      expectedLogicalJobs,
      completedLogicalJobs
    });
  console.log(JSON.stringify({
    status: "passed",
    mode: "online-only",
    planDate,
    drivers: driverLogins.length,
    expectedLogicalJobs,
    completedLogicalJobs,
    pwaActions,
    uploadedPhotos,
    byStopType: sortedCounts(byStopType)
  }));
} finally {
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (uploadServer) await new Promise((resolve, reject) => uploadServer.close((error) => error ? reject(error) : resolve()));
  await closeDb();
}
