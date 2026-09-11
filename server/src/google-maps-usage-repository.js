import crypto from "node:crypto";
import {
  query as defaultQuery,
  withIndependentTransaction as defaultWithIndependentTransaction
} from "./db.js";
import {
  GOOGLE_MAPS_USAGE_LIMITS,
  googleMapsAdmissionDecision,
  googleMapsBudgetState
} from "./google-maps-usage-policy.js";

const USAGE_LOCK_KEY = 1_296_125_011;
const OUTCOMES = new Set(["not_called", "admitted", "succeeded", "failed", "timeout", "invalid_request", "invalid_response"]);

function text(value, maximum = 120) {
  return String(value || "").trim().slice(0, maximum);
}

function safeInteger(value, fallback = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(0, Math.trunc(number))) : fallback;
}

function requestFingerprint(value) {
  const retained = String(value || "");
  if (/^[0-9a-f]{64}$/iu.test(retained)) return retained.toLowerCase();
  return crypto.createHash("sha256").update(retained).digest("hex");
}

function privateIdentifier(value) {
  const retained = String(value || "").trim();
  return retained ? crypto.createHash("sha256").update(retained).digest("hex") : "";
}

export function createGoogleMapsUsageRepository({
  query = defaultQuery,
  withTransaction = defaultWithIndependentTransaction,
  limits = GOOGLE_MAPS_USAGE_LIMITS
} = {}) {
  async function admit(input = {}) {
    return withTransaction(async (transactionQuery) => {
      const runQuery = typeof transactionQuery === "function" ? transactionQuery : query;
      await runQuery("SELECT pg_advisory_xact_lock($1)", [USAGE_LOCK_KEY]);
      const usage = await runQuery(
        `SELECT coalesce(sum(admitted_units), 0)::integer AS rolling_usage,
                coalesce(sum(admitted_units) FILTER (WHERE subsystem = $2), 0)::integer AS subsystem_usage
           FROM google_maps_usage_ledger
          WHERE admitted
            AND requested_at >= now() - ($1::integer * interval '1 day')`,
        [limits.windowDays, text(input.subsystem || "support_route", 60)]
      );
      const rollingUsage = Number(usage.rows[0]?.rolling_usage || 0);
      const subsystemUsage = Number(usage.rows[0]?.subsystem_usage || 0);
      const decision = googleMapsAdmissionDecision({
        ...input,
        rollingUsage,
        subsystemUsage,
        limits
      });
      const inserted = await runQuery(
        `INSERT INTO google_maps_usage_ledger (
           subsystem, api, reason, request_fingerprint, actor_id, session_id,
           requested_units, admitted_units, admitted, admission_reason, budget_state, outcome
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id, requested_at`,
        [
          text(input.subsystem || "support_route", 60),
          text(input.api || "unknown", 80),
          text(input.reason || "unknown", 80),
          requestFingerprint(input.fingerprint),
          privateIdentifier(input.actorId),
          privateIdentifier(input.sessionId),
          decision.units,
          decision.admitted ? decision.units : 0,
          decision.admitted,
          decision.reason,
          decision.budgetState,
          decision.admitted ? "admitted" : "not_called"
        ]
      );
      return {
        ...decision,
        ledgerId: inserted.rows[0].id,
        requestedAt: inserted.rows[0].requested_at,
        rollingUsage,
        subsystemUsage
      };
    });
  }

  async function recordOutcome({ ledgerId, outcome, httpStatus = null, latencyMs = null } = {}) {
    const normalizedOutcome = OUTCOMES.has(outcome) ? outcome : "failed";
    return withTransaction(async (transactionQuery) => {
      const runQuery = typeof transactionQuery === "function" ? transactionQuery : query;
      const result = await runQuery(
        `UPDATE google_maps_usage_ledger
            SET outcome = $2,
                http_status = $3,
                latency_ms = $4,
                completed_at = now()
          WHERE id = $1
          RETURNING id`,
        [
          ledgerId,
          normalizedOutcome,
          httpStatus === null ? null : safeInteger(httpStatus, 0, 999),
          latencyMs === null ? null : safeInteger(latencyMs, 0, 86_400_000)
        ]
      );
      return Boolean(result.rowCount);
    });
  }

  async function summary() {
    const [totalsResult, dailyResult, actionResult] = await Promise.all([
      query(
        `WITH filtered AS (
           SELECT *
             FROM google_maps_usage_ledger
            WHERE requested_at >= now() - ($1::integer * interval '1 day')
         ), subsystem_usage AS (
           SELECT subsystem, sum(admitted_units)::integer AS units
             FROM filtered
            GROUP BY subsystem
         )
         SELECT coalesce((SELECT sum(admitted_units) FROM filtered), 0)::integer AS rolling_usage,
                coalesce((SELECT sum(requested_units) FROM filtered), 0)::integer AS attempted_usage,
                coalesce((
                  SELECT sum(admitted_units)
                    FROM google_maps_usage_ledger
                   WHERE requested_at >= (((now() AT TIME ZONE 'UTC')::date - 7) AT TIME ZONE 'UTC')
                     AND requested_at < ((now() AT TIME ZONE 'UTC')::date AT TIME ZONE 'UTC')
                ), 0)::integer AS recent_complete_seven_day_usage,
                (SELECT count(*) FROM filtered)::integer AS request_count,
                (SELECT count(*) FROM filtered WHERE NOT admitted)::integer AS denied_count,
                (SELECT count(*) FROM filtered
                  WHERE admitted AND outcome IN ('failed', 'timeout', 'invalid_request', 'invalid_response'))::integer AS failed_count,
                coalesce((SELECT jsonb_object_agg(subsystem, units) FROM subsystem_usage), '{}'::jsonb) AS per_subsystem`,
        [limits.windowDays]
      ),
      query(
        `WITH days AS (
           SELECT generate_series(
             (now() AT TIME ZONE 'UTC')::date - ($1::integer - 1),
             (now() AT TIME ZONE 'UTC')::date,
             interval '1 day'
           )::date AS day
         ), usage AS (
           SELECT (requested_at AT TIME ZONE 'UTC')::date AS day,
                  coalesce(sum(requested_units), 0)::integer AS attempted_units,
                  coalesce(sum(admitted_units), 0)::integer AS admitted_units,
                  count(*) FILTER (WHERE NOT admitted)::integer AS denied_count,
                  count(*) FILTER (
                    WHERE admitted AND outcome IN ('failed', 'timeout', 'invalid_request', 'invalid_response')
                  )::integer AS failed_count
             FROM google_maps_usage_ledger
            WHERE requested_at >= now() - ($1::integer * interval '1 day')
            GROUP BY 1
         )
         SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
                coalesce(usage.attempted_units, 0)::integer AS attempted_units,
                coalesce(usage.admitted_units, 0)::integer AS admitted_units,
                coalesce(usage.denied_count, 0)::integer AS denied_count,
                coalesce(usage.failed_count, 0)::integer AS failed_count
           FROM days
           LEFT JOIN usage USING (day)
          ORDER BY days.day`,
        [limits.windowDays]
      ),
      query(
        `SELECT subsystem, api, reason,
                count(*)::integer AS request_count,
                coalesce(sum(requested_units), 0)::integer AS attempted_units,
                coalesce(sum(admitted_units), 0)::integer AS admitted_units,
                count(*) FILTER (WHERE NOT admitted)::integer AS denied_count,
                count(*) FILTER (WHERE admitted AND outcome = 'succeeded')::integer AS succeeded_count,
                count(*) FILTER (
                  WHERE admitted AND outcome IN ('failed', 'timeout', 'invalid_request', 'invalid_response')
                )::integer AS failed_count,
                round(avg(latency_ms) FILTER (WHERE latency_ms IS NOT NULL))::integer AS average_latency_ms
           FROM google_maps_usage_ledger
          WHERE requested_at >= now() - ($1::integer * interval '1 day')
          GROUP BY subsystem, api, reason
          ORDER BY admitted_units DESC, attempted_units DESC, subsystem, api, reason`,
        [limits.windowDays]
      )
    ]);
    const totals = totalsResult.rows[0] || {};
    const rolling30Day = Number(totals.rolling_usage || 0);
    const daily = dailyResult.rows.map((row) => ({
      day: row.day,
      attemptedUnits: Number(row.attempted_units || 0),
      admittedUnits: Number(row.admitted_units || 0),
      deniedCount: Number(row.denied_count || 0),
      failedCount: Number(row.failed_count || 0)
    }));
    const recentCompleteSevenDays = Number(totals.recent_complete_seven_day_usage || 0);
    return {
      rolling30Day,
      attempted30Day: Number(totals.attempted_usage || 0),
      requestCount30Day: Number(totals.request_count || 0),
      deniedCount30Day: Number(totals.denied_count || 0),
      failedCount30Day: Number(totals.failed_count || 0),
      perSubsystem: totals.per_subsystem || {},
      daily,
      actions: actionResult.rows.map((row) => ({
        subsystem: row.subsystem,
        api: row.api,
        reason: row.reason,
        requestCount: Number(row.request_count || 0),
        attemptedUnits: Number(row.attempted_units || 0),
        admittedUnits: Number(row.admitted_units || 0),
        deniedCount: Number(row.denied_count || 0),
        succeededCount: Number(row.succeeded_count || 0),
        failedCount: Number(row.failed_count || 0),
        averageLatencyMs: row.average_latency_ms === null ? null : Number(row.average_latency_ms)
      })),
      projected30DayFromSevenDays: Math.round((recentCompleteSevenDays / 7) * 30),
      alertLimit: limits.alertLimit,
      conserveLimit: limits.conserveLimit,
      normalLimit: limits.normalLimit,
      hardLimit: limits.hardLimit,
      consoleTarget: limits.consoleTarget,
      remaining: Math.max(0, limits.hardLimit - rolling30Day),
      budgetState: googleMapsBudgetState(rolling30Day, limits)
    };
  }

  return Object.freeze({ admit, recordOutcome, summary });
}
