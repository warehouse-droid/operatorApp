# Evidence — Dispatch Planning stale identity and outbound location

Status: GREEN, deployed, narrowly recovered, and production-audited on
2026-08-28.

## Diagnosis and RED proof

Two independent defects were reproduced before production code changed:

- `DELIVERY-MBR-0828-1` is canonical Custom Order ID `143`, but older recovery
  snapshots retained only its unique immutable ref. The pre-fix canonicalizer
  rejected the assigned order with
  `DISPATCH_CUSTOM_ORDER_PLAN_ID_REQUIRED` because both stable-ID fields were
  blank.
- NetSuite webhook `28` had applied four `2967` line locations to `SOA07750` at
  11:55 UTC. A complete webhook `70` arrived later at 13:18 UTC with all four
  line locations at `12441`. Neither event carried `sourceModifiedAt`; the
  pre-fix queue compared payload hashes, so the newer event was incorrectly
  marked superseded. The RED queue test observed `superseded: true` where
  receipt order required `false`.

The exact-ref Custom Order regression and the later timestamp-free webhook
regression both failed on the pre-change implementation. Production remained
read-only during reproduction.

## Implemented behavior

- When an assigned Custom Order snapshot lacks a stable ID, canonicalization
  may recover it only from an exact unique `dispatch_custom_orders.ref_number`
  match. A submitted stable ID remains authoritative, so mismatched ref/ID,
  duplicate assignment, completion, status, and route guards still reject.
- Webhooks with explicit source modification timestamps retain source-time
  ordering. When both snapshots lack that timestamp, later database receipt
  order is authoritative instead of payload-hash lexical order.
- A later timestamp-free queued snapshot coalesces older queued work for the
  same entity. Lease, pause, retry, single-claimer, and duplicate guarantees are
  unchanged.
- Failed validation still writes only a recovery snapshot; it never overwrites
  the active Dispatch plan.

## Verification

The reproducible command is:

```sh
bash tools/dispatch-planning-stale-identity-location-gauntlet.sh
```

The final isolated run completed successfully with:

- all 428 MBT test files passing in isolated execution;
- 37/37 application-workload checks;
- 6/6 webhook-queue integration checks, the Custom Order canonicalization
  harness, and 6/6 recovery-snapshot checks;
- 86.53% overall line coverage, with 87.16% lines for the Custom Order
  repository, 85.01% for the webhook queue repository, and all 4/4 required
  changed markers/outcomes covered;
- zero-warning focused ESLint, legacy browser syntax, and TypeScript checks;
- 4/4 killed mutations (100%), with source restoration verified;
- a clean changed-line secret scan and source-state SHA-256
  `ab458879ad601ae8496aff7a6f74a784543361df08dac55b151e7021c3ba657c`.

Migration-contract tests were updated to include the already present migration
189; the focused migration/readiness checks passed 7/7 and the final 428-file
run remained green.

## Backup, deployment, and targeted recovery

- A custom-format PostgreSQL backup was created online at
  `docker/backups/mbbs-before-dispatch-stale-identity-location-20260828T155056Z.dump`
  (234,195,058 bytes). `pg_restore --list` validated all 3,055 archive entries.
- The pre-change app and worker images were retained as
  `mbbs-operator-app-app:rollback-dispatch-stale-20260828T155056Z` and
  `mbbs-operator-app-webhook-worker:rollback-dispatch-stale-20260828T155056Z`.
- App and worker images were built while production stayed live. Their joint
  recreation took 1.53 seconds; the app was healthy within ten seconds and
  `/health` returned `{"ok":true,"app":"MBBS Yard Server"}`. Production was
  already migrated through 189, so migration was a no-op.
- Only the known false-superseded webhook row `70` was requeued, inside a guarded
  transaction that rechecked entity/type/internal ID/ref, null source timestamp,
  four `12441` line locations, and absence of a newer event. It succeeded on
  attempt 1 at 15:55:43Z and notified the app. No unrelated superseded webhook
  was replayed.

## Final production proof

- `SOA07750` is active with outbound location ID `15` / `12441`; all four active
  lines are ID `15` / `12441`. Its ready Dispatch catalog card reports
  `sourceYard: "12441"` and `pickupLocations: ["12441"]`.
- Webhook `70` is succeeded with one attempt and no error. The final webhook
  queue is unpaused with zero queued, running, or failed rows.
- The Dispatch catalog is ready, assignment-ready, error-free, and has zero
  pending refreshes; all 301 refresh-outbox rows are complete.
- Active plan `261` remains confirmed. Its current
  `DELIVERY-MBR-0828-1` snapshot has both `customOrderId: "143"` and
  `raw.custom_order_id: "143"`. The plan snapshot timestamp is 16:01:58Z,
  before the final 16:09 app-only cutover, proving that cutover did not rewrite
  the active plan.
- The final app image containing both repairs is
  `sha256:eb477e3a2b8ef44960049557dbaf9fc95ed4d9a71df8e8f7e3bc9ee36b69ff24`.
  The uninterrupted webhook-worker image containing the ordering repair is
  `sha256:561ed980096ca2738d894cfe37b4dd5f5c447c274a15d348a13a285e65a44596`.
