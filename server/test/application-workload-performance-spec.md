# Application workload and planning read-model executable specification

Status: approved for implementation on 2026-08-28.

## Outcomes

- Dispatch and SCM PO Split return at most 200 most-recently-updated summary cards on the initial request. Full order lines are fetched only for the selected order.
- Indexed search, initial Dispatch load, and initial PO Split load have a measured p95 below 1,000 ms with at least 1,000 Dispatch plan dates and today's anonymized workload replayed concurrently.
- Planned status comes from `dispatch_plan_order_assignments`; request paths do not deserialize all current or historical snapshot documents to infer assignment.
- NetSuite order webhooks are durably acknowledged with HTTP 202, deduplicated, ordered by source modification time, coalesced to the newest full transaction payload per entity, and processed by exactly one worker at a time.
- A failed or leased webhook is recoverable. Admins can inspect, pause, resume, and retry the queue. A duplicate success is not applied twice.
- Ollama has a hard two-CPU Compose ceiling. The serial webhook worker has a hard one-CPU ceiling.
- Dispatch keeps the canonical current snapshot plus at most four history checkpoints for Toronto today and future plan dates. Past dates keep only the canonical final snapshot. Unresolved recovery checkpoints are exempt from the cap.
- Empty printer-agent polling is not persisted as one audit row per poll; actual lease/job state transitions remain auditable.
- Today's production event shape is stored only as anonymized counts, byte sizes, timings, and anonymous entity ordinals and is replayed only against disposable test containers.

## Failure model

1. A duplicate webhook arrives before, during, or after processing.
2. An older webhook arrives after a newer payload, including when the older payload was already leased.
3. The worker exits after claiming, during the database transaction, or after commit but before marking completion.
4. A burst arrives while one webhook is running; only the newest safe trailing payload per entity remains queued.
5. The read model is empty, stale, partially backfilled, or unavailable during deployment.
6. A plan changes while assignment projection or catalog refresh is being rebuilt.
7. Cursor rows share timestamps, are updated between pages, or match linked split/group references only.
8. Retention runs concurrently, in bounded batches, with manual/lifecycle/recovery checkpoints and more than 1,000 plan dates.
9. App and SQL CPU are loaded by today's mix of printer polls, webhook expansions, delayed refreshes, Dispatch commands, PO searches, and snapshot history.

## Invariants

- Public list responses never include line arrays or raw order JSON.
- Cursor ordering is deterministic and has no duplicates within an unchanged catalog generation.
- Exact linked PO/split/group references are searchable from indexed columns.
- A planned card is never reported unplanned when an active assignment row exists.
- Queue claims use `FOR UPDATE SKIP LOCKED` and a fenced lease token; concurrent claimers cannot own the same row.
- Only a successful processing transaction may advance the entity watermark.
- Retention never deletes `dispatch_plan_snapshots`, command receipts, follow-up outbox rows, or unresolved recovery evidence.
- Production capture is read-only and contains no order reference, customer, address, item, prompt, response, or raw payload.

## Performance evidence

The gauntlet records warm and cold latency samples, app/database CPU samples, row counts, query plans for indexed searches, replay totals, and before/after write amplification. A rollout gate remains off unless projections are ready, shadow comparisons have no mismatch, and both list p95 values are below 1,000 ms.
