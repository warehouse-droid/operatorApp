import crypto from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { pool } from "../src/db.js";
import {
  buildDispatchHistoricalReplayReport,
  sanitizeDispatchReplayPlan
} from "../src/dispatch-planner-replay.js";

const from = String(process.argv[2] || "2026-08-05T04:00:00.000Z");
const to = String(process.argv[3] || "2026-08-19T04:00:00.000Z");
const output = path.resolve(process.argv[4] || "test-artifacts/dispatch-planner-replay/two-week-2026-08-05_2026-08-18.json");
const salt = String(process.env.DISPATCH_REPLAY_SALT || "dispatch-planner-replay-2026-v1");

function pseudonym(namespace, value) {
  return `${namespace}_${crypto.createHash("sha256").update(`${salt}\0${namespace}\0${String(value ?? "")}`).digest("hex").slice(0, 16)}`;
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

const client = await pool.connect();
let report;
try {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const params = [from, to];
  const commands = await client.query(
      `SELECT id, plan_id, plan_date::text, command_type, applied_revision, result -> 'plan' AS plan, created_at
         FROM dispatch_plan_commands
        WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
        ORDER BY created_at, id`, params);
  const snapshots = await client.query(
      `SELECT history.id, history.plan_id, history.plan_date::text, history.revision,
              history.archive_reason, history.archived_at,
              plan.status
         FROM dispatch_plan_snapshot_history history
         JOIN dispatch_plans plan ON plan.id = history.plan_id
        WHERE history.archived_at >= $1::timestamptz AND history.archived_at < $2::timestamptz
        ORDER BY history.archived_at, history.id`, params);
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
              COALESCE(occurred_at, received_at, created_at) AS event_at,
              payload IS NOT NULL AS has_payload
         FROM scm_reconciliation_audit_events
        WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
        ORDER BY COALESCE(occurred_at, received_at, created_at), id`, params);
  const offlineEvents = await client.query(
      `SELECT id, event_type, status, client_sequence,
              device_occurred_at, server_received_at, server_applied_at,
              immutable_payload IS NOT NULL AS has_payload
         FROM driver_offline_events
        WHERE server_received_at >= $1::timestamptz AND server_received_at < $2::timestamptz
        ORDER BY server_received_at, id`, params);
  const driverJobs = await client.query(
      `SELECT id, status, stop_type, device_occurred_at,
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
    events.push({
      stream: "dispatch",
      id: eventId("dispatch", "snapshot_history", row.id),
      serverAt: iso(row.archived_at),
      sourceSequence: Number(row.id),
      action: row.archive_reason,
      before: { archived: true },
      after: { revision: Number(row.revision || 0) },
      candidateOnly: row.archive_reason === "save_recovery"
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
      stream: "dispatch",
      id: eventId("dispatch", "audit", row.id),
      serverAt: iso(row.created_at),
      sourceSequence: Number(row.id),
      action: row.action
    };
    if (row.has_before && row.has_after) {
      event.before = { present: true };
      event.after = { present: true };
    } else if (row.has_details) {event.payload = { action: row.action, source: row.source || "" };}
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
      serverAt: iso(row.event_at),
      sourceSequence: Number(row.id),
      action: row.action || row.event_type,
      ...(row.has_payload ? { payload: {
        eventType: row.event_type || "",
        action: row.action || "",
        validationStatus: row.validation_status || "",
        source: row.source || ""
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
        source: row.source || ""
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
    events.push({
      stream: "driver",
      id: eventId("driver", "job", row.id),
      serverAt: iso(row.event_at),
      deviceAt: row.device_occurred_at ? iso(row.device_occurred_at) : undefined,
      sourceSequence: Number(row.id),
      action: `driver_job_${row.status}`,
      before: { materialized: false },
      after: { status: row.status, stopType: row.stop_type, offlineSource: row.offline_source === true }
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

  report = buildDispatchHistoricalReplayReport({
    events,
    window: { from, to, timezone: "America/Toronto" },
    sourceCounts
  });
  report.historicalActionCounts = {
    dispatch: actionCount(audits.rows),
    commands: actionCount(commands.rows, "command_type"),
    netsuiteDerived: actionCount(scmEvents.rows),
    driverOffline: actionCount(offlineEvents.rows, "event_type")
  };
  report.assertions = {
    everyEventCompared: report.projectionComparisons === report.eventsProcessed,
    noProjectionMismatch: report.mismatchCount === 0,
    hasDispatchEvidence: report.streamCounts.dispatch > 0,
    hasScmEvidence: report.streamCounts.scm > 0,
    hasNetSuiteDerivedEvidence: report.streamCounts.netsuite > 0,
    hasDriverEvidence: report.streamCounts.driver > 0,
    gapsExplicit: report.gapCount === 0 || report.gapSamples.length > 0
  };
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK").catch(() => null);
  throw error;
} finally {
  client.release();
  await pool.end();
}

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (Object.values(report.assertions).some((passed) => passed !== true)) {
  throw new Error(`Dispatch historical replay failed: ${JSON.stringify(report.assertions)}`);
}
process.stdout.write(`${JSON.stringify({
  output,
  eventsProcessed: report.eventsProcessed,
  projectionComparisons: report.projectionComparisons,
  mismatchCount: report.mismatchCount,
  gapCount: report.gapCount,
  interactionCoverage: report.interactionCoverage,
  historicalInteractionGaps: report.historicalInteractionGaps,
  causalDigest: report.causalDigest
})}\n`);
