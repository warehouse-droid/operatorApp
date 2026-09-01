const PROHIBITED_KEYS = new Set([
  "tranid",
  "orderref",
  "customer",
  "address",
  "itemid",
  "prompt",
  "response",
  "rawbody",
  "payload"
]);

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError(`${label} must be a non-negative integer.`);
  }
  return number;
}

function walkKeys(value, visit) {
  if (Array.isArray(value)) {
    for (const entry of value) walkKeys(entry, visit);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, candidate] of Object.entries(value)) {
    visit(key);
    walkKeys(candidate, visit);
  }
}

export function validateAnonymizedWorkloadFixture(fixture = {}) {
  if (fixture?.schemaVersion !== "operator-workload-replay-v1") {
    throw new TypeError("Unsupported workload replay fixture schema.");
  }
  if (fixture?.privacy?.identifiers !== "anonymous-counts-only"
    || fixture?.privacy?.rawPayloads !== false
    || fixture?.privacy?.customerData !== false) {
    throw new TypeError("Workload replay fixture privacy declaration is incomplete.");
  }
  walkKeys(fixture, (key) => {
    if (PROHIBITED_KEYS.has(String(key).toLowerCase())) {
      throw new TypeError(`Workload replay fixture contains prohibited key ${key}.`);
    }
  });
  for (const row of fixture.eventTotals || []) positiveInteger(row.count, `${row.kind || "event"} count`);
  for (const row of fixture.webhookEntityMultiplicity || []) {
    positiveInteger(row.eventsPerEntity, "eventsPerEntity");
    positiveInteger(row.entities, "entities");
  }
  return { ok: true };
}

function totalByKind(fixture, kind) {
  return positiveInteger(
    (fixture.eventTotals || []).find((row) => row.kind === kind)?.count || 0,
    `${kind} count`
  );
}

export function buildAnonymizedWorkloadReplayPlan(fixture = {}) {
  validateAnonymizedWorkloadFixture(fixture);
  const printerPolls = totalByKind(fixture, "printer_idle_lease");
  const webhookApplications = totalByKind(fixture, "order_webhook");
  const minimumWebhookApplications = (fixture.webhookEntityMultiplicity || [])
    .reduce((total, row) => total + positiveInteger(row.entities, "entities"), 0);
  const eventWrites = (fixture.eventTotals || [])
    .reduce((total, row) => total + positiveInteger(row.count, `${row.kind} count`), 0);
  const webhookExpansionWrites = [
    "netsuite_line_update",
    "netsuite_receiving_line_update",
    "netsuite_line_discover",
    "netsuite_receiving_line_discover"
  ].reduce((total, kind) => total + totalByKind(fixture, kind), 0);
  const minimumExpansionWrites = webhookApplications
    ? Math.ceil(webhookExpansionWrites * minimumWebhookApplications / webhookApplications)
    : 0;
  return {
    window: {
      timezone: fixture.timezone,
      localDate: fixture.localDate,
      from: fixture.capturedFrom,
      to: fixture.capturedTo
    },
    peak: fixture.peakFiveMinutes,
    legacy: {
      printerAuditWrites: printerPolls,
      webhookApplications,
      estimatedDatabaseWrites: eventWrites
    },
    optimized: {
      printerAuditWrites: 0,
      minimumWebhookApplications,
      maximumWebhookApplications: webhookApplications,
      workerConcurrency: 1,
      minimumEstimatedDatabaseWrites: eventWrites
        - printerPolls
        - webhookExpansionWrites
        + minimumExpansionWrites
    }
  };
}
