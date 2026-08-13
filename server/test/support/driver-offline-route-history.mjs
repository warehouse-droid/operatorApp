import crypto from "node:crypto";

const TOKEN_PATTERN = /^(?<kind>[pdvs])(?<photos>\d+)\.(?<load>\d+)\.(?<truck>\d+)(?<direct>x?)$/u;
const STOP_TYPES = Object.freeze({ p: "pickup", d: "dropoff", v: "travel", s: "truck_switch" });

export function decodeHistoricalRouteToken(token) {
  const match = TOKEN_PATTERN.exec(String(token || ""));
  if (!match?.groups) {
    throw new Error(`Invalid historical route token: ${token}`);
  }
  const photos = Number(match.groups.photos);
  const loadOrdinal = Number(match.groups.load);
  const truckOrdinal = Number(match.groups.truck);
  if (![photos, loadOrdinal, truckOrdinal].every(Number.isSafeInteger)) {
    throw new Error(`Invalid historical route token number: ${token}`);
  }
  const direct = match.groups.direct === "x";
  if (direct && match.groups.kind !== "p") {
    throw new Error(`Only a pickup may carry direct-transfer evidence: ${token}`);
  }
  return {
    kind: match.groups.kind,
    stopType: STOP_TYPES[match.groups.kind],
    requiredPhotos: photos,
    loadOrdinal,
    truckOrdinal,
    direct
  };
}

export function materializeHistoricalRoute(route) {
  const routeNumber = Number(String(route?.id || "").replace(/^H/u, ""));
  if (!Number.isSafeInteger(routeNumber) || routeNumber < 1) {
    throw new Error(`Invalid historical route ID: ${route?.id}`);
  }
  let predecessorFingerprint = "0".repeat(64);
  const jobs = (route.jobs || []).map((token, index) => {
    const decoded = decodeHistoricalRouteToken(token);
    const jobId = `history-${route.id}-job-${index + 1}`;
    const fingerprint = crypto.createHash("sha256")
      .update(`${route.id}:${route.date}:${index}:${token}`)
      .digest("hex");
    const job = {
      jobId,
      sequenceIndex: index,
      stopType: decoded.stopType,
      requiredPhotos: decoded.requiredPhotos,
      fingerprint,
      predecessorFingerprint,
      planId: 900000 + routeNumber,
      planDate: route.date,
      planRevision: 1,
      driverLogin: `history-${route.id.toLowerCase()}`,
      truckId: `truck-${decoded.truckOrdinal}`,
      truckPlate: `HIST-${decoded.truckOrdinal}`,
      loadId: `load-${decoded.loadOrdinal}`,
      loadName: `Historical load ${decoded.loadOrdinal}`,
      stopId: `stop-${index + 1}`,
      orderRefs: decoded.stopType === "travel" || decoded.stopType === "truck_switch"
        ? []
        : [`ORDER-${route.id}-${index + 1}`],
      dependencyPickupManifests: decoded.direct
        ? [{
            transferOrderRef: `TRANSFER-${route.id}-${index + 1}`,
            salesOrderRef: `ORDER-${route.id}-${index + 1}`,
            items: []
          }]
        : []
    };
    predecessorFingerprint = fingerprint;
    return job;
  });
  return {
    id: route.id,
    date: route.date,
    routeNumber,
    jobs,
    actions: jobs.flatMap((job) => job.stopType === "truck_switch"
      ? [{ eventType: "truck_switched_physical", jobId: job.jobId, photoCount: 0 }]
      : [
          { eventType: "job_started", jobId: job.jobId, photoCount: 0 },
          { eventType: "job_completed", jobId: job.jobId, photoCount: job.requiredPhotos }
        ])
  };
}

export function summarizeHistoricalRoutes(routes = []) {
  const summary = {
    routes: 0,
    jobs: 0,
    actions: 0,
    photos: 0,
    directPickups: 0,
    stopTypes: { pickup: 0, dropoff: 0, travel: 0, truck_switch: 0 }
  };
  for (const source of routes) {
    const route = materializeHistoricalRoute(source);
    summary.routes += 1;
    summary.jobs += route.jobs.length;
    summary.actions += route.actions.length;
    for (const job of route.jobs) {
      summary.stopTypes[job.stopType] += 1;
      summary.photos += job.requiredPhotos;
      if (job.dependencyPickupManifests.length) {
        summary.directPickups += 1;
      }
    }
  }
  return summary;
}
