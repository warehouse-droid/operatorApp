import { driverCompanyDate } from "./driver-plan-date-policy.js";

export const HISTORICAL_ASSIST_TIME_ZONE = "America/Toronto";
export const HISTORICAL_ASSIST_MINIMUM_DURATION_MS = 10_000;
export const HISTORICAL_ASSIST_MAX_PHOTOS = 20;

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIME_PATTERN = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;
const OFFSET_PATTERN = /^[+-]\d{2}:\d{2}$/;
const PHYSICAL_STOP_TYPES = new Set(["pickup", "dropoff"]);

function historicalAssistError(message, code, status = 400, details = {}) {
  return Object.assign(new Error(message), { status, code, ...details });
}

function normalizedDate(value) {
  const text = String(value ?? "").trim();
  if (!ISO_DATE_PATTERN.test(text)) {
    return "";
  }
  const [year, month, day] = text.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
    ? text
    : "";
}

function normalizedLocalTime(value) {
  const match = String(value ?? "").trim().match(LOCAL_TIME_PATTERN);
  if (!match) {
    return "";
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  if (hour > 23 || minute > 59 || second > 59) {
    return "";
  }
  return `${match[1]}:${match[2]}:${String(second).padStart(2, "0")}`;
}

function torontoParts(instant, { includeName = false } = {}) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: HISTORICAL_ASSIST_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    ...(includeName ? { timeZoneName: "short" } : {})
  }).formatToParts(instant);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function offsetText(totalMinutes) {
  const sign = totalMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(totalMinutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

function instantValue(value, field) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw historicalAssistError(
      `${field} is not a valid timestamp.`,
      "HISTORICAL_ASSIST_TIMESTAMP_INVALID"
    );
  }
  return parsed;
}

export function historicalAssistDateDecision(planDateValue, { now = new Date() } = {}) {
  const companyDate = driverCompanyDate(now);
  const planDate = normalizedDate(planDateValue);
  if (!planDate) {
    return {
      allowed: false,
      code: "HISTORICAL_ASSIST_DATE_INVALID",
      message: "Historical completion requires a valid YYYY-MM-DD plan date.",
      planDate: "",
      companyDate,
      timeZone: HISTORICAL_ASSIST_TIME_ZONE
    };
  }
  if (planDate >= companyDate) {
    return {
      allowed: false,
      code: "HISTORICAL_ASSIST_DATE_NOT_PAST",
      message: "Historical completion is available only for a past Toronto plan date.",
      planDate,
      companyDate,
      timeZone: HISTORICAL_ASSIST_TIME_ZONE
    };
  }
  return {
    allowed: true,
    code: "",
    message: "",
    planDate,
    companyDate,
    timeZone: HISTORICAL_ASSIST_TIME_ZONE
  };
}

export function assertHistoricalAssistPlanDate(planDate, options = {}) {
  const decision = historicalAssistDateDecision(planDate, options);
  if (decision.allowed) {
    return decision;
  }
  throw historicalAssistError(
    decision.message,
    decision.code,
    decision.code === "HISTORICAL_ASSIST_DATE_NOT_PAST" ? 409 : 400,
    decision
  );
}

export function torontoOffsetChoices(planDateValue, localTimeValue) {
  const planDate = normalizedDate(planDateValue);
  const localTime = normalizedLocalTime(localTimeValue);
  if (!planDate || !localTime) {
    return [];
  }
  const [year, month, day] = planDate.split("-").map(Number);
  const [hour, minute, second] = localTime.split(":").map(Number);
  const localEpoch = Date.UTC(year, month - 1, day, hour, minute, second);
  const choices = [];

  // Current Toronto civil time uses only EST and EDT. Testing those two
  // observed offsets preserves both fall-back instants and rejects the
  // spring-forward gap without scanning every world time zone offset.
  for (const offsetMinutes of [-4 * 60, -5 * 60]) {
    const instant = new Date(localEpoch - offsetMinutes * 60_000);
    const parts = torontoParts(instant, { includeName: true });
    const formattedDate = `${parts.year}-${parts.month}-${parts.day}`;
    const formattedTime = `${parts.hour}:${parts.minute}:${parts.second}`;
    if (formattedDate !== planDate || formattedTime !== localTime) {
      continue;
    }
    const offset = offsetText(offsetMinutes);
    if (choices.some((choice) => choice.offset === offset)) {
      continue;
    }
    choices.push({
      offset,
      abbreviation: String(parts.timeZoneName || offset),
      instant: instant.toISOString()
    });
  }
  return choices.sort((left, right) => left.instant.localeCompare(right.instant));
}

function historicalTimeInputs(planDateValue, localTimeValue) {
  const planDate = normalizedDate(planDateValue);
  if (!planDate) {
    throw historicalAssistError(
      "A valid plan date is required for the entered time.",
      "HISTORICAL_ASSIST_DATE_INVALID"
    );
  }
  const localTime = normalizedLocalTime(localTimeValue);
  if (!localTime) {
    throw historicalAssistError(
      "Enter a valid local time including hour and minute.",
      "HISTORICAL_ASSIST_TIME_INVALID"
    );
  }
  return { planDate, localTime };
}

function selectedHistoricalOffset(choices, offset) {
  const requestedOffset = String(offset || "").trim();
  if (!requestedOffset && choices.length > 1) {
    throw historicalAssistError(
      "Choose EDT or EST for this repeated Toronto time.",
      "HISTORICAL_ASSIST_TIME_AMBIGUOUS",
      409,
      { choices }
    );
  }
  if (requestedOffset && !OFFSET_PATTERN.test(requestedOffset)) {
    throw historicalAssistError(
      "The selected UTC offset is invalid.",
      "HISTORICAL_ASSIST_OFFSET_INVALID"
    );
  }
  const selected = requestedOffset
    ? choices.find((choice) => choice.offset === requestedOffset)
    : choices[0];
  if (!selected) {
    throw historicalAssistError(
      "The selected offset does not match that Toronto local time.",
      "HISTORICAL_ASSIST_OFFSET_INVALID",
      409,
      { choices }
    );
  }
  return selected;
}

export function resolveHistoricalAssistInstant({ planDate: planDateValue, localTime: localTimeValue, offset = "" } = {}) {
  const { planDate, localTime } = historicalTimeInputs(planDateValue, localTimeValue);
  const choices = torontoOffsetChoices(planDate, localTime);
  if (!choices.length) {
    throw historicalAssistError(
      "That local time does not exist in Toronto because of the daylight-saving transition.",
      "HISTORICAL_ASSIST_TIME_NONEXISTENT"
    );
  }
  const selected = selectedHistoricalOffset(choices, offset);
  return new Date(selected.instant);
}

function historicalChronologyStart({ planDate, arrival, storedStartedAt }) {
  const storedStart = instantValue(storedStartedAt, "Stored start time");
  if (!storedStart && !arrival) {
    throw historicalAssistError(
      "Arrival time is required for a visit that was never started.",
      "HISTORICAL_ASSIST_ARRIVAL_REQUIRED"
    );
  }
  if (storedStart && driverCompanyDate(storedStart) !== normalizedDate(planDate)) {
    throw historicalAssistError(
      "The stored arrival is outside the selected Toronto plan date.",
      "HISTORICAL_ASSIST_STORED_START_DATE_CONFLICT",
      409
    );
  }
  return {
    storedStart,
    started: storedStart || resolveHistoricalAssistInstant({ planDate, ...arrival })
  };
}

function assertHistoricalDuration(started, completed) {
  if (completed.getTime() - started.getTime() < HISTORICAL_ASSIST_MINIMUM_DURATION_MS) {
    throw historicalAssistError(
      "Completion must be at least 10 seconds after arrival.",
      "HISTORICAL_ASSIST_DURATION_INVALID",
      409
    );
  }
}

function assertHistoricalSurroundingChronology({
  started,
  completed,
  previousCompletedAt,
  nextStartedAt,
  nextCompletedAt
}) {
  const previous = instantValue(previousCompletedAt, "Previous completion time");
  if (previous && started.getTime() < previous.getTime()) {
    throw historicalAssistError(
      "Arrival cannot be before the previous completed physical visit.",
      "HISTORICAL_ASSIST_PREVIOUS_CHRONOLOGY_CONFLICT",
      409
    );
  }
  const next = instantValue(nextStartedAt, "Next arrival time")
    || instantValue(nextCompletedAt, "Next completion time");
  if (next && completed.getTime() > next.getTime()) {
    throw historicalAssistError(
      "Completion cannot be after the next completed physical visit began.",
      "HISTORICAL_ASSIST_NEXT_CHRONOLOGY_CONFLICT",
      409
    );
  }
}

export function validateHistoricalAssistChronology({
  planDate,
  arrival = null,
  completion = null,
  storedStartedAt = null,
  previousCompletedAt = null,
  nextStartedAt = null,
  nextCompletedAt = null
} = {}) {
  if (!completion) {
    throw historicalAssistError(
      "Completion time is required.",
      "HISTORICAL_ASSIST_COMPLETION_REQUIRED"
    );
  }
  const { storedStart, started } = historicalChronologyStart({
    planDate,
    arrival,
    storedStartedAt
  });
  const completed = resolveHistoricalAssistInstant({ planDate, ...completion });
  assertHistoricalDuration(started, completed);
  assertHistoricalSurroundingChronology({
    started,
    completed,
    previousCompletedAt,
    nextStartedAt,
    nextCompletedAt
  });
  return {
    startedAt: started.toISOString(),
    completedAt: completed.toISOString(),
    usedStoredStart: Boolean(storedStart)
  };
}

export function historicalAssistRequiredPhotoCount(job = {}) {
  const configured = Number(job?.requiredPhotos);
  if (configured === 0) {
    return 0;
  }
  return Math.min(
    HISTORICAL_ASSIST_MAX_PHOTOS,
    Math.max(2, Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 2)
  );
}

function recordFor(recordsByJobId, jobId) {
  return recordsByJobId instanceof Map
    ? recordsByJobId.get(jobId) || null
    : recordsByJobId?.[jobId] || null;
}

function recordValue(record, camelName, snakeName) {
  return record?.[camelName] ?? record?.[snakeName] ?? null;
}

function isCompleteRecord(record) {
  return ["complete", "completed", "done"].includes(String(record?.status || "").toLowerCase());
}

function uniqueJobIds(job) {
  const values = Array.isArray(job?.physicalVisitJobIds) && job.physicalVisitJobIds.length
    ? job.physicalVisitJobIds
    : [job?.jobId];
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function visitTiming(visit, recordsByJobId) {
  const records = visit.jobIds.map((jobId) => recordFor(recordsByJobId, jobId)).filter(Boolean);
  const startedAt = records
    .map((record) => recordValue(record, "startedAt", "started_at"))
    .find(Boolean) || visit.job.startedAt || null;
  const completedValues = records
    .map((record) => recordValue(record, "completedAt", "completed_at"))
    .filter(Boolean)
    .map((value) => new Date(value))
    .filter((value) => Number.isFinite(value.getTime()));
  const completedAt = completedValues.length
    ? new Date(Math.max(...completedValues.map((value) => value.getTime()))).toISOString()
    : null;
  return {
    startedAt: startedAt ? new Date(startedAt).toISOString() : null,
    completedAt,
    complete: visit.jobIds.every((jobId) => isCompleteRecord(recordFor(recordsByJobId, jobId))),
    completedJobIds: visit.jobIds.filter((jobId) => isCompleteRecord(recordFor(recordsByJobId, jobId)))
  };
}

function historicalPhysicalVisitCandidates(routeJobs) {
  const routeById = new Map(routeJobs.map((job) => [String(job?.jobId || ""), job]));
  const seen = new Set();
  const visits = [];
  for (const job of routeJobs) {
    const stopType = String(job?.stopType || "").toLowerCase();
    if (!PHYSICAL_STOP_TYPES.has(stopType) || job?.mbt?.schemaVersion) {
      continue;
    }
    const jobIds = uniqueJobIds(job);
    const key = [...jobIds].sort().join("\u0000");
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    const primary = jobIds.map((jobId) => routeById.get(jobId)).find(Boolean) || job;
    visits.push({ job: primary, jobIds });
  }
  return visits;
}

function historicalIncompleteVisit(visit, timed, firstIncompleteJobId) {
  const routeIndex = timed.indexOf(visit);
  const previous = timed.slice(0, routeIndex).reverse().find((candidate) => candidate.complete);
  const next = timed.slice(routeIndex + 1).find((candidate) => candidate.complete);
  const actionable = visit.jobIds.includes(firstIncompleteJobId);
  return {
    ...visit,
    requiredPhotos: historicalAssistRequiredPhotoCount(visit.job),
    actionable,
    blockedByJobId: actionable ? "" : firstIncompleteJobId,
    previousCompletedAt: previous?.completedAt || null,
    nextStartedAt: next?.startedAt || null,
    nextCompletedAt: next?.completedAt || null
  };
}

export function buildHistoricalAssistPhysicalVisits(routeJobs = [], recordsByJobId = {}) {
  const visits = historicalPhysicalVisitCandidates(routeJobs || []);
  const timed = visits.map((visit) => ({ ...visit, ...visitTiming(visit, recordsByJobId) }));
  const incomplete = timed.filter((visit) => !visit.complete);
  const firstIncompleteJobId = incomplete[0]?.jobIds[0] || "";
  return incomplete.map((visit) => historicalIncompleteVisit(visit, timed, firstIncompleteJobId));
}
