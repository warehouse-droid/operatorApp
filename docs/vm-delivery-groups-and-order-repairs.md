# VM Update: Delivery Groups And Order Repairs

This runbook deploys the operator grouped-order performance changes from commit
`5df8fa8`, creates the delivery-group projection tables, rebuilds the projection from
current dispatch plans, and conditionally applies two known order-data repairs.

The update is designed for the existing VM database. Do **not** replace the VM database
with a full local database dump because the VM may contain newer production activity.

## What This Update Contains

- Migration `018_dispatch_delivery_groups.sql`
  - creates `dispatch_delivery_groups`;
  - creates `dispatch_delivery_group_members`.
- A durable delivery-group projection rebuilt from active dispatch plan snapshots.
- Batched grouped-order reads and grouped confirm/pack operations for the operator PWA.
- A unified `/api/delivery/bootstrap` request to reduce repeated startup queries.
- Repair for the nested groups involving:
  - `SOA02778`
  - `SOA02779`
  - `SOA04350`
- Repair for missing outbound lines on:
  - `TOB00521-S3`
  - `TOB00521-S4`

The two repair SQL files are **not migrations** and are not run automatically. Apply each
one only when its preflight check confirms that the VM still has that exact problem.

## 1. Enter The Repository And Preserve VM Changes

```bash
cd ~/apps/operatorApp
git status --short
git rev-parse HEAD
```

If `git status` shows a VM-only edit, stash it before pulling:

```bash
git stash push -m "VM changes before delivery-group update"
```

## 2. Create A Full VM Database Backup

Keep this backup until the operator and dispatch screens have been verified.

```bash
cd ~/apps/operatorApp
mkdir -p docker/backups
stamp=$(date +%Y%m%d-%H%M%S)
docker compose --env-file docker/env/.env exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f /tmp/before-delivery-group-update.dump'
db_container=$(docker compose --env-file docker/env/.env ps -q db)
docker cp "${db_container}:/tmp/before-delivery-group-update.dump" "docker/backups/before-delivery-group-update-${stamp}.dump"
ls -lh "docker/backups/before-delivery-group-update-${stamp}.dump"
```

Do not continue if the backup file is missing or has a zero-byte size.

## 3. Pull And Build The Updated Application

```bash
cd ~/apps/operatorApp
git pull --ff-only origin codex/dockerVer
git rev-parse --short HEAD
docker compose --env-file docker/env/.env build app migrate
```

The commit should be `5df8fa8` or a later commit containing it.

## 4. Stop The App And Apply Migrations

Stopping the app prevents plan saves while the projection and repair work runs. PostgreSQL
and Ollama can remain running.

```bash
cd ~/apps/operatorApp
docker compose --env-file docker/env/.env stop app
docker compose --env-file docker/env/.env --profile tools run --rm migrate
```

Verify migrations `018` and `019`:

```bash
docker compose --env-file docker/env/.env exec -T db psql -U mbbs_app -d mbbs_yard -c "SELECT filename, applied_at FROM schema_migrations WHERE filename IN ('018_dispatch_delivery_groups.sql', '019_dispatch_fleet_setup.sql') ORDER BY filename;"
```

Migration `019` creates the driver/truck tables. Moving fleet data into those tables is
covered separately in `docs/dispatch-fleet-db-migration.md`. If the VM fleet is still
missing, complete that fleet-data transfer before starting the updated app in step 8.

## 5. Check The Grouped Sales-Order Repair

Show every matching group currently stored in active plan snapshots:

```bash
docker compose --env-file docker/env/.env exec -T db psql -U mbbs_app -d mbbs_yard -c "SELECT p.id AS plan_id, p.plan_date, o->>'id' AS group_ref, o->'childOrders' AS children FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id CROSS JOIN LATERAL jsonb_array_elements(s.orders) o WHERE o->>'id' IN ('GOA-2778-2779','GOA-2779-4350','GOA-2778-2779-4350') ORDER BY p.plan_date,p.id,o->>'id';"
```

Decision:

- If `GOA-2778-2779-4350` already contains all three source orders, skip this repair.
- If the VM shows the old nested `GOA-2778-2779` and `GOA-2779-4350` state on the
  expected plans, run the repair below.
- If the output is different from either state, stop and inspect it manually. The repair
  intentionally aborts rather than guessing.

Apply the repair only when required:

```bash
docker compose --env-file docker/env/.env exec -T db psql -U mbbs_app -d mbbs_yard -v ON_ERROR_STOP=1 < docker/repairs/regroup-goa-2778-2779-4350.sql
```

The repair archives each affected active snapshot in
`dispatch_plan_snapshot_history` before changing it and increments the plan revision.

## 6. Check The TOB00521 Split-Line Repair

First inspect canonical outbound lines:

```bash
docker compose --env-file docker/env/.env exec -T db psql -U mbbs_app -d mbbs_yard -c "SELECT o.tranid, count(l.id) AS outbound_lines, COALESCE(sum(l.quantity),0) AS sales_qty FROM transfer_orders o LEFT JOIN transfer_order_lines l ON l.transfer_order_id=o.netsuite_id AND l.line_stage='outbound' WHERE o.tranid IN ('TOB00521-S3','TOB00521-S4') GROUP BY o.tranid ORDER BY o.tranid;"
```

Then inspect the split data stored in dispatch plans:

```bash
docker compose --env-file docker/env/.env exec -T db psql -U mbbs_app -d mbbs_yard -c "SELECT p.id AS plan_id, p.plan_date, o->>'id' AS split_ref, o->>'originalOrderId' AS source_ref, jsonb_array_length(COALESCE(o->'items','[]'::jsonb)) AS item_count FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id CROSS JOIN LATERAL jsonb_array_elements(s.orders) o WHERE o->>'id' IN ('TOB00521-S3','TOB00521-S4') ORDER BY p.plan_date,p.id,o->>'id';"
```

Decision:

- If both split orders already have outbound lines and every snapshot has item content,
  skip this repair.
- If either order has zero outbound lines or affected snapshots have empty item arrays,
  and plan `13` still contains the intact split items, run the repair.
- If plan `13` is absent or does not contain both intact split orders, do not run it. The
  SQL will abort because it has no trustworthy source data.

Apply the repair only when required:

```bash
docker compose --env-file docker/env/.env exec -T db psql -U mbbs_app -d mbbs_yard -v ON_ERROR_STOP=1 < docker/repairs/repair-tob00521-s3-s4-lines.sql
```

This repair archives affected snapshots before changing them and restores canonical
outbound lines without overwriting packed or loaded quantities.

## 7. Rebuild The Delivery-Group Projection

Run this after all required repairs so the projection reflects the final plan snapshots:

```bash
cd ~/apps/operatorApp
docker compose --env-file docker/env/.env --profile tools run --rm migrate npm run rebuild:delivery-groups
```

The command reports plans scanned, groups written, and members written. Counts can differ
from the local computer because the VM may have newer plans.

Verify the projection:

```bash
docker compose --env-file docker/env/.env exec -T db psql -U mbbs_app -d mbbs_yard -c "SELECT count(*) FILTER (WHERE active) AS active_groups FROM dispatch_delivery_groups; SELECT count(*) AS members FROM dispatch_delivery_group_members;"
```

The rebuild is safe to run again. Canonical sales/transfer order headers and lines remain
the source of truth; these two tables are only the fast grouped-order read model.

## 8. Start And Verify The Application

```bash
cd ~/apps/operatorApp
docker compose --env-file docker/env/.env up -d app
curl http://127.0.0.1:3000/health
docker compose --env-file docker/env/.env logs --tail 120 app
docker compose --env-file docker/env/.env ps
```

Frontend checks:

1. Open `/operator` and confirm normal order cards appear promptly.
2. Open a grouped order and confirm details load without the previous multi-second delay.
3. Confirm page, pack, and release a test grouped order where operationally safe.
4. Confirm the combined group displays all source order numbers.
5. Confirm `TOB00521-S3` and `TOB00521-S4` show their outbound item lines if that repair
   was needed.
6. Open `/dispatch/planning` and confirm existing groups and loads remain visible.

Review repair audit entries:

```bash
docker compose --env-file docker/env/.env exec -T db psql -U mbbs_app -d mbbs_yard -c "SELECT created_at, action, entity_id, plan_id, plan_date FROM dispatch_audit_log WHERE action IN ('dispatch.group.regroup_repair','dispatch.split.lines_repaired') ORDER BY created_at DESC;"
```

## Rollback

If verification fails, stop the app and preserve the failure logs:

```bash
cd ~/apps/operatorApp
docker compose --env-file docker/env/.env logs --tail 300 app
docker compose --env-file docker/env/.env stop app
```

The repair scripts archive pre-change plan snapshots with reasons
`before_group_regroup` and `before_split_line_repair`. For a full rollback, restore the
custom-format database backup created in step 2. Do not run a destructive database
restore while the app is active.

Because migration `018` is additive, the previous application version can ignore the new
projection tables. If only application code must be rolled back, return to the commit
recorded in step 1, rebuild `app`, and start it without deleting Docker volumes.
