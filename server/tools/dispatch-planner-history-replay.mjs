import crypto from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { pool } from "../src/db.js";
import {
  buildDispatchHistoricalReplayArtifact,
  sanitizeDispatchReplayPlan
} from "../src/dispatch-planner-replay.js";

const from = String(process.argv[2] || "2026-08-05T04:00:00.000Z");
const to = String(process.argv[3] || "2026-08-19T04:00:00.000Z");
const output = path.resolve(process.argv[4] || "test-artifacts/dispatch-planner-replay/two-week-2026-08-05_2026-08-18.json");
const captureOutput = process.env.DISPATCH_REPLAY_CAPTURE_OUTPUT
  ? path.resolve(process.env.DISPATCH_REPLAY_CAPTURE_OUTPUT) : "";
const expectedLocalDayCount = Number(process.env.DISPATCH_REPLAY_EXPECTED_LOCAL_DAYS || 0);
const salt = String(process.env.DISPATCH_REPLAY_SALT || crypto.randomBytes(32).toString("hex"));

function pseudonym(namespace, value) {
  return `${namespace}_${crypto.createHash("sha256").update(`${salt}\0${namespace}\0${String(value ?? "")}`).digest("hex").slice(0, 16)}`;
}

function digestKey(namespace, value) {
  return crypto.createHash("sha256")
    .update(`${salt}\0${namespace}\0${String(value ?? "")}`)
    .digest("hex").slice(0, 32);
}

function iso(value, fallback = from) {
  const parsed = new Date(value || fallback);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

function eventId(stream, table, id) {
  return pseudonym("EVENT", `${stream}:${table}:${id}`);
}

function actionCount(rows, key = "action") {
  const counts = {};
  for (const row of rows) {
    const value = String(row[key] || "unknown");
    counts[value] = (counts[value] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function driverJobDetails(row = {}) {
  return row.job_details && typeof row.job_details === "object" ? row.job_details : {};
}

function sanitizedDriverTravelDetails(row = {}) {
  const details = driverJobDetails(row);
  return {
    ...(details.fromStopId || details.from_stop_id ? {
      fromStopId: pseudonym("STOP", details.fromStopId || details.from_stop_id)
    } : {}),
    ...(details.toStopId || details.to_stop_id ? {
      toStopId: pseudonym("STOP", details.toStopId || details.to_stop_id)
    } : {})
  };
}

function capturedDriverActivity(row = {}) {
  return {
    planId: pseudonym("PLAN", row.plan_id),
    planDate: String(row.plan_date || "").slice(0, 10),
    loadId: pseudonym("LOAD", row.load_id),
    stopId: pseudonym("STOP", row.stop_id),
    stopType: String(row.stop_type || "").toLowerCase(),
    status: String(row.status || "").toLowerCase(),
    orderRefs: (Array.isArray(row.order_refs) ? row.order_refs : [])
      .map((ref) => pseudonym("ORDER", ref)),
    jobDetails: sanitizedDriverTravelDetails(row)
  };
}

function capturedDriverCorpusEntry(row = {}) {
  const details = driverJobDetails(row);
  const visitIdentity = Array.isArray(details.physicalVisitJobIds) && details.physicalVisitJobIds.length
    ? [...details.physicalVisitJobIds].map(String).sort().join("|")
    : String(row.job_id || row.id);
  return {
    sourceKey: digestKey("DRIVER_JOB", row.job_id || row.id),
    visitKey: digestKey("DRIVER_VISIT", visitIdentity),
    driverKey: digestKey("DRIVER", row.driver_login),
    planDate: String(row.plan_date).slice(0, 10),
    stopType: String(row.stop_type).toLowerCase(),
    originalStatus: String(row.status || "").toLowerCase(),
    orderRefCount: Array.isArray(row.order_refs) ? row.order_refs.length : 0,
    requiredPhotos: Math.max(0, Number(details.requiredPhotos || 0))
  };
}

const client = await pool.connect();
let capture;
try {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const readOnly = await client.query("SHOW transaction_read_only");
  if (readOnly.rows[0]?.transaction_read_only !== "on") {
    throw new Error("Dispatch history capture requires a read-only database transaction.");
  }
  const params = [from, to];
  const commands = await client.query(
      `SELECT id, plan_id, plan_date::text, command_type, applied_revision, result -> 'plan' AS plan, created_at
         FROM dispatch_plan_commands
        WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
        ORDER BY created_at, id`, params);
  const snapshots = await client.query(
      `SELECT history.id, history.plan_id, history.plan_date::text, history.revision,
              history.archive_reason, history.archived_at,
              history.orders, history.trucks, history.summary,
              plan.status
         FROM dispatch_plan_snapshot_history history
         JOIN dispatch_plans plan ON plan.id = history.plan_id
        WHERE history.archived_at >= $1::timestamptz AND history.archived_at < $2::timestamptz
        ORDER BY history.archived_at, history.id`, params);
  const currentSnapshots = await client.query(
      `SELECT snapshot.plan_id, plan.plan_date::text, plan.revision, plan.status,
              snapshot.orders, snapshot.trucks, snapshot.summary, snapshot.saved_at
         FROM dispatch_plan_snapshots snapshot
         JOIN dispatch_plans plan ON plan.id = snapshot.plan_id
        WHERE snapshot.saved_at >= $1::timestamptz AND snapshot.saved_at < $2::timestamptz
        ORDER BY snapshot.saved_at, snapshot.plan_id`, params);
  const audits = await client.query(
      `SELECT id, action, source, plan_id, created_at,
              before_state IS NOT NULL AS has_before,
              after_state IS NOT NULL AS has_after,
              details IS NOT NULL AS has_details
         FROM dispatch_audit_log
        WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
        ORDER BY created_at, id`, params);
  const scmChanges = await client.query(
      `SELECT id, source, created_at,
              requested_changes IS NOT NULL AS has_before,
              resulting_snapshot IS NOT NULL AS has_after
         FROM scm_netsuite_po_history_changes
        WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
        ORDER BY created_at, id`, params);
  const scmEvents = await client.query(
      `SELECT id, source, event_type, action, validation_status,
              created_at AS server_at,
              COALESCE(occurred_at, received_at, created_at) AS source_event_at,
              payload IS NOT NULL AS has_payload
         FROM scm_reconciliation_audit_events
        WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
        ORDER BY created_at, id`, params);
  const offlineEvents = await client.query(
      `SELECT id, event_type, status, client_sequence,
              device_occurred_at, server_received_at, server_applied_at,
              immutable_payload IS NOT NULL AS has_payload
         FROM driver_offline_events
        WHERE server_received_at >= $1::timestamptz AND server_received_at < $2::timestamptz
        ORDER BY server_received_at, id`, params);
  const driverJobs = await client.query(
      `SELECT id, job_id, plan_id, plan_date::text, driver_login,
              load_id, stop_id, status, stop_type, order_refs, job_details,
              device_occurred_at,
              COALESCE(server_applied_at, completed_at, started_at, created_at) AS event_at,
              source_offline_event_id IS NOT NULL AS offline_source
         FROM driver_job_records
        WHERE COALESCE(server_applied_at, completed_at, started_at, created_at) >= $1::timestamptz
          AND COALESCE(server_applied_at, completed_at, started_at, created_at) < $2::timestamptz
        ORDER BY COALESCE(server_applied_at, completed_at, started_at, created_at), id`, params);
  const completions = await client.query(
      `SELECT id, order_kind, dispatch_completion_status, completion_evidence_type, created_at
         FROM dispatch_order_completion_events
        WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
        ORDER BY created_at, id`, params);
  const corrections = await client.query(
      `SELECT id, action, created_at,
              before_state IS NOT NULL AS has_before,
              after_state IS NOT NULL AS has_after
         FROM driver_job_corrections
        WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
        ORDER BY created_at, id`, params);
  const mirrorEvents = await client.query(
      `SELECT sequence_id AS id, entity_type, change_type, source, created_at,
              payload IS NOT NULL AS has_payload
         FROM netsuite_mirror_events
        WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
        ORDER BY created_at, sequence_id`, params);

  const events = [];
  for (const row of snapshots.rows) {
    const rawPlan = {
      id: row.plan_id,
      planDate: row.plan_date,
      status: row.status,
      revision: row.revision,
      orders: row.orders || [],
      trucks: row.trucks || [],
      summary: row.summary || {}
    };
    events.push({
      stream: "dispatch",
      id: eventId("dispatch", "snapshot_history", row.id),
      serverAt: iso(row.archived_at),
      sourceSequence: Number(row.id),
      action: row.archive_reason,
      before: { archived: true },
      after: { revision: Number(row.revision || 0) },
      candidateOnly: row.archive_reason === "save_recovery",
      planState: sanitizeDispatchReplayPlan(rawPlan, { salt })
    });
  }
  for (const row of currentSnapshots.rows) {
    events.push({
      stream: "dispatch",
      id: eventId("dispatch", "current_snapshot", row.plan_id),
      serverAt: iso(row.saved_at),
      sourceSequence: Number(row.plan_id),
      action: "current_snapshot",
      after: { revision: Number(row.revision || 0) },
      planState: sanitizeDispatchReplayPlan({
        id: row.plan_id,
        planDate: row.plan_date,
        status: row.status,
        revision: row.revision,
        orders: row.orders || [],
        trucks: row.trucks || [],
        summary: row.summary || {}
      }, { salt })
    });
  }
  for (const row of commands.rows) {
    const rawPlan = row.plan && typeof row.plan === "object" ? row.plan : {
      id: row.plan_id,
      planDate: row.plan_date,
      revision: row.applied_revision,
      orders: [],
      trucks: []
    };
    events.push({
      stream: "dispatch",
      id: eventId("dispatch", "command", row.id),
      serverAt: iso(row.created_at),
      sourceSequence: Number(row.id),
      action: row.command_type,
      payload: { action: row.command_type, revision: Number(row.applied_revision || 0) },
      planState: sanitizeDispatchReplayPlan(rawPlan, { salt })
    });
  }
  for (const row of audits.rows) {
    const event = {
      stream: /^(?:scm\.|dispatch\.scm_)/i.test(String(row.action || ""))
        || ["scm", "dispatch-scm"].includes(String(row.source || "").toLowerCase()) ? "scm" : "dispatch",
      id: eventId("dispatch", "audit", row.id),
      serverAt: iso(row.created_at),
      sourceSequence: Number(row.id),
      action: row.action
    };
    if (row.has_before && row.has_after) {
      event.before = { present: true };
      event.after = { present: true };
    } else if (row.has_details) {event.payload = { action: row.action, source: pseudonym("SOURCE", row.source) };}
    events.push(event);
  }
  for (const row of scmChanges.rows) {
    events.push({
      stream: "scm",
      id: eventId("scm", "po_history_change", row.id),
      serverAt: iso(row.created_at),
      sourceSequence: Number(row.id),
      action: "scm_po_history_changed",
      ...(row.has_before && row.has_after ? { before: { present: true }, after: { present: true } } : {})
    });
  }
  for (const row of scmEvents.rows) {
    events.push({
      stream: "netsuite",
      id: eventId("netsuite", "scm_reconciliation", row.id),
      serverAt: iso(row.server_at),
      occurredAt: iso(row.source_event_at, row.server_at),
      sourceSequence: Number(row.id),
      action: row.action || row.event_type,
      ...(row.has_payload ? { payload: {
        eventType: row.event_type || "",
        action: row.action || "",
        validationStatus: row.validation_status || "",
        source: pseudonym("SOURCE", row.source)
      } } : {})
    });
  }
  for (const row of mirrorEvents.rows) {
    events.push({
      stream: "netsuite",
      id: eventId("netsuite", "mirror", row.id),
      serverAt: iso(row.created_at),
      sourceSequence: Number(row.id),
      action: row.change_type,
      ...(row.has_payload ? { payload: {
        entityType: row.entity_type || "",
        changeType: row.change_type || "",
        source: pseudonym("SOURCE", row.source)
      } } : {})
    });
  }
  for (const row of offlineEvents.rows) {
    events.push({
      stream: "driver",
      id: eventId("driver", "offline", row.id),
      serverAt: iso(row.server_received_at),
      deviceAt: iso(row.device_occurred_at, row.server_received_at),
      sourceSequence: Number(row.client_sequence || row.id),
      action: row.event_type,
      ...(row.has_payload ? { payload: { eventType: row.event_type, status: row.status } } : {})
    });
  }
  for (const row of driverJobs.rows) {
    const jobDetails = row.job_details && typeof row.job_details === "object" ? row.job_details : {};
    const sanitizedOrderRefs = (Array.isArray(row.order_refs) ? row.order_refs : [])
      .map((ref) => pseudonym("ORDER", ref));
    const sanitizedJobDetails = {
      ...(jobDetails.fromStopId || jobDetails.from_stop_id ? {
        fromStopId: pseudonym("STOP", jobDetails.fromStopId || jobDetails.from_stop_id)
      } : {}),
      ...(jobDetails.toStopId || jobDetails.to_stop_id ? {
        toStopId: pseudonym("STOP", jobDetails.toStopId || jobDetails.to_stop_id)
      } : {})
    };
    events.push({
      stream: "driver",
      id: eventId("driver", "job", row.id),
      serverAt: iso(row.event_at),
      deviceAt: row.device_occurred_at ? iso(row.device_occurred_at) : undefined,
      sourceSequence: Number(row.id),
      action: `driver_job_${row.status}`,
      before: { materialized: false },
      after: {
        status: row.status,
        stopType: row.stop_type,
        offlineSource: row.offline_source === true,
        planId: pseudonym("PLAN", row.plan_id),
        loadId: pseudonym("LOAD", row.load_id),
        stopId: pseudonym("STOP", row.stop_id),
        orderRefCount: sanitizedOrderRefs.length,
        jobDetails: sanitizedJobDetails
      }
    });
  }
  for (const row of completions.rows) {
    events.push({
      stream: "driver",
      id: eventId("driver", "completion", row.id),
      serverAt: iso(row.created_at),
      sourceSequence: Number(row.id),
      action: "dispatch_completion_status",
      payload: {
        orderKind: row.order_kind || "",
        status: row.dispatch_completion_status || "",
        evidenceType: row.completion_evidence_type || ""
      }
    });
  }
  for (const row of corrections.rows) {
    events.push({
      stream: "driver",
      id: eventId("driver", "correction", row.id),
      serverAt: iso(row.created_at),
      sourceSequence: Number(row.id),
      action: row.action,
      ...(row.has_before && row.has_after ? { before: { present: true }, after: { present: true } } : {})
    });
  }

  const sourceCounts = {
    dispatch_plan_commands: commands.rowCount,
    dispatch_plan_snapshot_history: snapshots.rowCount,
    dispatch_plan_snapshots: currentSnapshots.rowCount,
    dispatch_audit_log: audits.rowCount,
    scm_netsuite_po_history_changes: scmChanges.rowCount,
    scm_reconciliation_audit_events: scmEvents.rowCount,
    netsuite_mirror_events: mirrorEvents.rowCount,
    driver_offline_events: offlineEvents.rowCount,
    driver_job_records: driverJobs.rowCount,
    dispatch_order_completion_events: completions.rowCount,
    driver_job_corrections: corrections.rowCount
  };
  for (const [table, count] of Object.entries(sourceCounts)) {
    if (count > 0) {continue;}
    events.push({
      stream: table.includes("driver") || table.includes("completion") ? "driver"
        : table.includes("netsuite") || table.includes("reconciliation") ? "netsuite"
          : table.includes("scm") ? "scm" : "dispatch",
      id: eventId("coverage", table, `${from}:${to}`),
      serverAt: from,
      sourceSequence: 0,
      action: `coverage_gap:${table}`
    });
  }

  const driverActivity = driverJobs.rows.map(capturedDriverActivity);
  const supportedDriverRows = driverJobs.rows.filter((row) =>
    ["pickup", "dropoff", "travel"].includes(String(row.stop_type || "").toLowerCase())
    && row.plan_date
  );
  const driverCorpus = supportedDriverRows.map(capturedDriverCorpusEntry);
  const visitSizes = new Map();
  for (const entry of driverCorpus) {
    visitSizes.set(entry.visitKey, Number(visitSizes.get(entry.visitKey) || 0) + 1);
  }
  for (const entry of driverCorpus) {
    entry.declaredVisitSize = visitSizes.get(entry.visitKey);
  }

  capture = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    window: { from, to, timezone: "America/Toronto" },
    privacy: {
      identifiers: "sha256-randomly-salted-pseudonyms",
      names: "excluded",
      addresses: "excluded",
      photos: "excluded",
      rawPayloads: "excluded",
      rawSources: "excluded"
    },
    sourceCounts,
    historicalActionCounts: {
      dispatch: actionCount(audits.rows),
      commands: actionCount(commands.rows, "command_type"),
      netsuiteDerived: actionCount(scmEvents.rows),
      driverOffline: actionCount(offlineEvents.rows, "event_type")
    },
    driverActivity,
    driverCorpus,
    events
  };
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK").catch(() => null);
  throw error;
} finally {
  client.release();
  await pool.end();
}

const report = buildDispatchHistoricalReplayArtifact({ capture, expectedLocalDayCount });
if (captureOutput) {
  await mkdir(path.dirname(captureOutput), { recursive: true });
  await writeFile(captureOutput, `${JSON.stringify(capture, null, 2)}\n`, "utf8");
}
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (Object.values(report.assertions).some((passed) => passed !== true)) {
  throw new Error(`Dispatch historical replay failed: ${JSON.stringify(report.assertions)}`);
}
process.stdout.write(`${JSON.stringify({
  output,
  captureOutput: captureOutput || undefined,
  eventsProcessed: report.eventsProcessed,
  projectionComparisons: report.projectionComparisons,
  mismatchCount: report.mismatchCount,
  gapCount: report.gapCount,
  interactionCoverage: report.interactionCoverage,
  historicalInteractionGaps: report.historicalInteractionGaps,
  causalDigest: report.causalDigest
})}\n`);
