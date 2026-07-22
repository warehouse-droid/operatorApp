import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { closeDb, query, withTransaction } from "./db.js";
import {
  convertLegacyDispatchPlanToV2,
  isDispatchV2Plan
} from "./dispatch-plan-repository.js";
import { syncDispatchPlanLoadAssignments } from "./dispatch-load-assignment-repository.js";

const ARCHIVE_REASON = "before_driver_oriented_planning";
const BACKFILL_SESSION_ID = "dockerVer-backfill";

async function configuredOwnYardCodes() {
  try {
    const payload = JSON.parse(await readFile(new URL("../data/dispatch-setup.json", import.meta.url), "utf8"));
    const codes = (payload.ownYards || [])
      .map((yard) => String(yard?.code || yard?.name || yard?.id || "").trim())
      .filter(Boolean);
    return codes.length ? [...new Set(codes)] : null;
  } catch {
    return null;
  }
}

function cleanPlanId(value) {
  if (value === null || value === undefined || value === "") return null;
  const candidate = String(value).trim();
  if (!/^\d+$/.test(candidate) || candidate === "0") {
    throw new Error("planId must be a positive integer.");
  }
  return candidate;
}

function loadCount(trucks = []) {
  return (trucks || []).reduce((total, truck) => total + (truck.loads || []).length, 0);
}

async function selectCurrentPlans({ planId, lock = false } = {}) {
  const suffix = lock ? " FOR UPDATE OF p, s" : "";
  const result = await query(
    `SELECT p.id, p.plan_date::text AS plan_date, p.status, p.revision,
            s.orders, s.trucks, s.summary, s.saved_at
       FROM dispatch_plans p
       JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      WHERE ($1::bigint IS NULL OR p.id = $1::bigint)
      ORDER BY p.plan_date, p.id${suffix}`,
    [planId]
  );
  return result.rows;
}

async function archiveLegacySnapshotOnce(row) {
  const result = await query(
    `INSERT INTO dispatch_plan_snapshot_history (
       plan_id, plan_date, revision, orders, trucks, summary,
       original_saved_at, archive_reason, session_id
     )
     SELECT p.id, p.plan_date, p.revision, s.orders, s.trucks, s.summary,
            s.saved_at, $2, $3
       FROM dispatch_plans p
       JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      WHERE p.id = $1
        AND NOT EXISTS (
          SELECT 1
            FROM dispatch_plan_snapshot_history h
           WHERE h.plan_id = p.id
             AND h.archive_reason = $2
        )
     RETURNING id`,
    [row.id, ARCHIVE_REASON, BACKFILL_SESSION_ID]
  );
  return result.rows[0]?.id || null;
}

async function applyLegacyPlan(row, migratedAt, ownYardCodes) {
  const converted = convertLegacyDispatchPlanToV2({
    id: String(row.id),
    planDate: row.plan_date,
    orders: row.orders || [],
    trucks: row.trucks || [],
    summary: row.summary || {}
  }, { migratedAt, ownYardCodes: ownYardCodes || undefined });
  const archiveId = await archiveLegacySnapshotOnce(row);

  await query(
    `UPDATE dispatch_plan_snapshots
        SET trucks = $2::jsonb,
            summary = $3::jsonb,
            saved_at = now()
      WHERE plan_id = $1`,
    [row.id, JSON.stringify(converted.trucks), JSON.stringify(converted.summary)]
  );
  const revisionResult = await query(
    `UPDATE dispatch_plans
        SET revision = revision + 1,
            updated_at = now()
      WHERE id = $1
      RETURNING revision`,
    [row.id]
  );
  await syncDispatchPlanLoadAssignments({
    ...converted,
    id: row.id,
    planDate: row.plan_date
  });

  return {
    planId: String(row.id),
    planDate: row.plan_date,
    status: row.status,
    action: "migrated",
    previousRevision: Number(row.revision || 0),
    revision: Number(revisionResult.rows[0]?.revision || 0),
    loadCount: loadCount(converted.trucks),
    archiveCreated: Boolean(archiveId),
    archiveId: archiveId ? String(archiveId) : null
  };
}

export async function backfillDispatchV2Plans({
  apply = false,
  planId = null,
  migratedAt = null,
  ownYardCodes = null
} = {}) {
  const selectedPlanId = cleanPlanId(planId);
  const runMigratedAt = String(migratedAt || new Date().toISOString());
  const runOwnYardCodes = Array.isArray(ownYardCodes) && ownYardCodes.length
    ? ownYardCodes
    : await configuredOwnYardCodes();
  const run = async () => {
    const rows = await selectCurrentPlans({ planId: selectedPlanId, lock: apply });
    const plans = [];
    let migrated = 0;
    let archived = 0;
    let assignmentLoadsRebuilt = 0;

    for (const row of rows) {
      const plan = { summary: row.summary || {} };
      if (isDispatchV2Plan(plan)) {
        plans.push({
          planId: String(row.id),
          planDate: row.plan_date,
          status: row.status,
          action: "skipped_v2",
          revision: Number(row.revision || 0),
          loadCount: loadCount(row.trucks)
        });
        continue;
      }

      if (!apply) {
        const converted = convertLegacyDispatchPlanToV2({
          orders: row.orders || [],
          trucks: row.trucks || [],
          summary: row.summary || {}
        }, { migratedAt: runMigratedAt, ownYardCodes: runOwnYardCodes || undefined });
        plans.push({
          planId: String(row.id),
          planDate: row.plan_date,
          status: row.status,
          action: "would_migrate",
          revision: Number(row.revision || 0),
          loadCount: loadCount(converted.trucks)
        });
        continue;
      }

      const result = await applyLegacyPlan(row, runMigratedAt, runOwnYardCodes);
      plans.push(result);
      migrated += 1;
      archived += result.archiveCreated ? 1 : 0;
      assignmentLoadsRebuilt += result.loadCount;
    }

    return {
      ok: true,
      mode: apply ? "apply" : "dry-run",
      planId: selectedPlanId,
      migratedAt: runMigratedAt,
      ownYardCodes: runOwnYardCodes || [],
      scanned: rows.length,
      eligible: plans.filter((plan) => plan.action === "would_migrate" || plan.action === "migrated").length,
      migrated,
      skipped: plans.filter((plan) => plan.action === "skipped_v2").length,
      archived,
      assignmentLoadsRebuilt,
      plans
    };
  };

  return apply ? withTransaction(run) : run();
}

function parseCliArgs(argv) {
  const apply = argv.includes("--apply");
  const verify = argv.includes("--verify");
  if (apply && verify) throw new Error("--apply and --verify cannot be used together.");
  const supported = new Set(["--apply", "--dry-run", "--verify"]);
  let planId = null;
  for (const arg of argv) {
    if (arg.startsWith("--plan-id=")) {
      planId = cleanPlanId(arg.slice("--plan-id=".length));
      continue;
    }
    if (!supported.has(arg)) throw new Error(`Unknown argument: ${arg}`);
  }
  return { apply, verify, planId };
}

const invokedDirectly = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    const result = await backfillDispatchV2Plans(options);
    console.log(JSON.stringify(result, null, 2));
    if (options.verify && result.eligible > 0) {
      console.error(`DispatchV2 backfill verification failed: ${result.eligible} current plan(s) still require migration.`);
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
