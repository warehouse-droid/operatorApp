function text(value) {
  return String(value ?? "").trim();
}

function rowJobId(row = {}) {
  return text(row.job_id ?? row.jobId);
}

function rowStatus(row = {}) {
  return text(row.status).toLowerCase();
}

function statusRows(statuses) {
  if (statuses instanceof Map) {return [...statuses.values()];}
  return Array.isArray(statuses) ? statuses : [];
}

function completeStatus(value) {
  return ["complete", "completed", "done"].includes(text(value).toLowerCase());
}

function startedTime(row = {}) {
  const parsed = Date.parse(row.started_at ?? row.startedAt ?? "");
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function routeConflict(activeJobIds = [], details = {}) {
  return Object.assign(
    new Error("Active Driver work no longer maps to the confirmed route. Dispatch must resolve the route conflict before work continues."),
    {
      status: 409,
      code: "DRIVER_ACTIVE_ROUTE_CONFLICT",
      activeJobIds: [...new Set(activeJobIds.map(text))],
      ...details
    }
  );
}

function physicalVisitIds(job = {}) {
  const declared = Array.isArray(job.physicalVisitJobIds)
    ? job.physicalVisitJobIds.map(text).filter(Boolean)
    : [];
  return [...new Set(declared.length ? declared : [text(job.jobId)].filter(Boolean))];
}

/**
 * Select the one route position a Driver may act on.
 *
 * Durable in-progress work is authoritative. Without active work, the cursor
 * advances beyond the furthest completed route position and never returns to
 * a pending gap behind it. Pending gaps are reported for Dispatch correction;
 * they are never converted into completion evidence here.
 */
export function selectDriverRouteCursor({ jobs = [], statuses = [], activeRecords = [] } = {}) {
  const orderedJobs = Array.isArray(jobs) ? jobs : [];
  const jobById = new Map();
  const indexById = new Map();
  for (const [index, job] of orderedJobs.entries()) {
    const id = text(job?.jobId);
    if (!id || jobById.has(id)) {continue;}
    jobById.set(id, job);
    indexById.set(id, index);
  }

  const rows = statusRows(statuses);
  const statusById = new Map();
  for (const row of rows) {
    const id = rowJobId(row);
    if (id) {statusById.set(id, row);}
  }
  const activeById = new Map();
  for (const row of [...rows, ...statusRows(activeRecords)]) {
    if (rowStatus(row) !== "in_progress") {continue;}
    const id = rowJobId(row);
    if (!id || !jobById.has(id)) {
      throw routeConflict([id], { reason: id ? "active_job_missing_from_route" : "active_job_identity_missing" });
    }
    activeById.set(id, row);
    statusById.set(id, row);
  }

  if (activeById.size) {
    const groups = new Map();
    for (const [id, row] of activeById) {
      const job = jobById.get(id);
      const groupIds = physicalVisitIds(job);
      const missingGroupIds = groupIds.filter((groupId) => !jobById.has(groupId));
      if (missingGroupIds.length) {
        throw routeConflict([...activeById.keys()], {
          reason: "active_physical_visit_changed",
          missingJobIds: missingGroupIds
        });
      }
      const loadIds = new Set(groupIds.map((groupId) => text(jobById.get(groupId)?.loadId)));
      if (loadIds.size > 1) {
        throw routeConflict([...activeById.keys()], { reason: "active_physical_visit_crosses_loads" });
      }
      const key = [...groupIds].sort().join("\u001f");
      const group = groups.get(key) || {
        key,
        groupIds,
        activeIds: [],
        firstIndex: Math.min(...groupIds.map((groupId) => indexById.get(groupId))),
        startedAt: Number.MAX_SAFE_INTEGER
      };
      group.activeIds.push(id);
      group.startedAt = Math.min(group.startedAt, startedTime(row));
      groups.set(key, group);
    }
    const orderedGroups = [...groups.values()].sort((left, right) =>
      left.startedAt - right.startedAt || left.firstIndex - right.firstIndex || left.key.localeCompare(right.key)
    );
    const selectedGroup = orderedGroups[0];
    const selectedId = [...selectedGroup.activeIds].sort((left, right) =>
      indexById.get(left) - indexById.get(right)
    )[0];
    const index = indexById.get(selectedId);
    const activeIds = new Set(selectedGroup.groupIds);
    const passedPendingJobIds = orderedJobs
      .slice(0, index)
      .filter((job) => {
        const id = text(job?.jobId);
        return id && !activeIds.has(id) && !completeStatus(statusById.get(id)?.status);
      })
      .map((job) => text(job.jobId));
    return {
      job: jobById.get(selectedId) || null,
      index,
      latestCompletedIndex: orderedJobs.reduce((latest, job, jobIndex) =>
        completeStatus(statusById.get(text(job?.jobId))?.status) ? Math.max(latest, jobIndex) : latest,
      -1),
      passedPendingJobIds,
      attention: orderedGroups.length > 1
        ? {
            code: "DRIVER_MULTIPLE_ACTIVE_ROUTE_GROUPS",
            message: "More than one unrelated Driver job is active. Finish the oldest active visit before starting anything else.",
            activeJobIds: [...activeById.keys()],
            activeGroupCount: orderedGroups.length
          }
        : null
    };
  }

  let latestCompletedIndex = -1;
  for (const [index, job] of orderedJobs.entries()) {
    if (completeStatus(statusById.get(text(job?.jobId))?.status)) {latestCompletedIndex = index;}
  }
  let index = -1;
  for (let candidate = latestCompletedIndex + 1; candidate < orderedJobs.length; candidate += 1) {
    if (!completeStatus(statusById.get(text(orderedJobs[candidate]?.jobId))?.status)) {
      index = candidate;
      break;
    }
  }
  const passedPendingJobIds = orderedJobs
    .slice(0, latestCompletedIndex + 1)
    .filter((job) => !completeStatus(statusById.get(text(job?.jobId))?.status))
    .map((job) => text(job.jobId))
    .filter(Boolean);
  return {
    job: index >= 0 ? orderedJobs[index] : null,
    index,
    latestCompletedIndex,
    passedPendingJobIds,
    attention: null
  };
}
