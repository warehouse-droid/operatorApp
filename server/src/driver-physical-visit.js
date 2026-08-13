function uniqueTextValues(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

/**
 * A consolidated physical visit keeps one durable Driver job per Dispatch stop.
 * This list is the execution boundary for the driver's single Start/Complete
 * action; it never replaces the individual job IDs used for reconciliation.
 */
export function driverPhysicalVisitJobIds(job = {}) {
  const jobId = String(job?.jobId || "").trim();
  const declared = uniqueTextValues(job?.physicalVisitJobIds);
  if (!declared.length) return jobId ? [jobId] : [];
  return jobId && !declared.includes(jobId) ? [...declared, jobId] : declared;
}

function physicalVisitError(message, code) {
  return Object.assign(new Error(message), { status: 409, code });
}

/**
 * Resolve every logical job covered by one physical visit. Missing or
 * inconsistent members fail closed so a one-click completion cannot partially
 * complete a consolidated delivery.
 */
export function driverPhysicalVisitExecutionJobs(job = {}, routeJobs = []) {
  if (!job?.jobId) {
    throw physicalVisitError(
      "The Driver physical visit is no longer available.",
      "DRIVER_PHYSICAL_VISIT_UNAVAILABLE"
    );
  }
  const jobIds = driverPhysicalVisitJobIds(job);
  if (jobIds.length <= 1) return [job];

  const routeById = new Map((routeJobs || []).map((candidate) => [
    String(candidate?.jobId || ""),
    candidate
  ]));
  const missingJobIds = jobIds.filter((jobId) => !routeById.has(jobId) && jobId !== String(job.jobId));
  if (missingJobIds.length) {
    throw Object.assign(
      physicalVisitError(
        "The consolidated Driver stop changed. Refresh the route before recording it.",
        "DRIVER_PHYSICAL_VISIT_CHANGED"
      ),
      { missingJobIds }
    );
  }

  const sharedDisplay = {
    physicalVisitJobIds: jobIds,
    physicalVisitStopIds: Array.isArray(job.physicalVisitStopIds)
      ? [...job.physicalVisitStopIds]
      : [],
    consolidatedPhysicalVisit: true,
    detailOrderRefs: Array.isArray(job.detailOrderRefs) ? [...job.detailOrderRefs] : [],
    detailOrderScopes: Array.isArray(job.detailOrderScopes) ? [...job.detailOrderScopes] : [],
    orders: Array.isArray(job.orders) ? [...job.orders] : []
  };
  const primaryJobId = String(job.jobId);
  const resolved = jobIds.map((jobId) => {
    const routeJob = routeById.get(jobId) || job;
    const candidate = jobId === primaryJobId ? { ...routeJob, ...job } : routeJob;
    return {
      ...candidate,
      ...sharedDisplay,
      // Each durable record keeps the logical order and stop identity from its
      // own route job even though the visible manifest is shared.
      jobId: routeJob.jobId,
      stopId: routeJob.stopId,
      orderRefs: Array.isArray(routeJob.orderRefs) ? [...routeJob.orderRefs] : [],
      lineRowIds: Array.isArray(routeJob.lineRowIds) ? [...routeJob.lineRowIds] : [],
      destinationLocationId: routeJob.destinationLocationId ?? null,
      startedAt: job.startedAt || routeJob.startedAt || null
    };
  });

  const invalid = resolved.filter((candidate) =>
    String(candidate.planId ?? "") !== String(job.planId ?? "")
    || String(candidate.loadId || "") !== String(job.loadId || "")
    || candidate.stopType !== "dropoff"
  );
  if (invalid.length) {
    throw Object.assign(
      physicalVisitError(
        "The consolidated Driver stop is inconsistent. Refresh the route before recording it.",
        "DRIVER_PHYSICAL_VISIT_INVALID"
      ),
      { invalidJobIds: invalid.map((candidate) => candidate.jobId) }
    );
  }
  return resolved;
}

export function driverPhysicalVisitOrderRefs(job = {}, routeJobs = []) {
  return uniqueTextValues(
    driverPhysicalVisitExecutionJobs(job, routeJobs)
      .flatMap((candidate) => candidate.orderRefs || [])
  );
}
