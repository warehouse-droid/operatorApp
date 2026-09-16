# Operator improvements deployed — 2026-09-16

Deployed successfully at **01:47:59 UTC**. App health is green; app and webhook worker are running with zero restarts.

- Release: `mbbs-operator-app:operator-improvements-20260916-v1`
- Image: `sha256:0ce822ac692745f914776588ecd77f58f5798cbe9047e9dc1b2694f4ad1102fb`
- Previous image: `sha256:a5d846bafecb1ea26e7e960c8d8f25a52dc05600ff08461a44387f4fd6e62989`
- Rollback tag: `mbbs-operator-app:rollback-operator-improvements-20260916`
- Successful cutover: **01:47:47–01:47:59 UTC**.

## Included changes and live results

- **Consolidation Load:** all six Sep-16 Dispatch entries are represented as ten original-order rows for yard 3445. The deployed modules produced valid summaries for the three selections containing the eight previously missing children, with the correct truck/load assignments.
- **Receiving:** completed split and ordinary POs are excluded; returning to Receiving clears searches. Actual SN1400333 is absent from receiving results, and another receipt attempt is rejected with HTTP 409. Its existing receipt remains 993562 / IR14634.
- **IF/IR timing:** the deployed code records call, queue and stage durations with the command identity.
- **Photos:** accepted photos are durable before posting; the background worker uploads them after IF/IR or local load completion. Migration `201_operator_posting_photo_uploads.sql` is applied. The queue was empty during final verification; no test photo was uploaded.
- **Posting notice:** the compact banner and updated PWA assets are served publicly. Refresh the Operator app to load them.

No receipt, fulfillment or load was created as a deployment test. Actual deployed repository checks used an explicit `REPEATABLE READ, READ ONLY` transaction. Production speed improvement will be measured from subsequent normal postings; the deployment does not establish a new posting-time benchmark.

## Verification

| Check | Result |
| --- | --- |
| Source gate | Both implementation manifests and recorded evidence match; their shared-file hash chain is intact |
| Candidate contents | Exactly 19 planned runtime changes; all packaged source/assets/migrations/package files match the tested workspace |
| Packaged candidate regressions | 70 passed, zero failures |
| Prior final complete suite | 2,504 tests: 2,501 passed, two known infrastructure failures, one existing skip; zero new failures |
| Actual production image startup | Passed on a fresh disposable database with external networking disabled; photo-worker polling had no errors |
| Migration | Only 201 was pending; applied transactionally with lock/statement timeouts; no existing business rows rewritten |
| Configuration | Environment, mounts, ports, commands, users and environment-file hashes preserved |
| Dependencies | Database and Ollama container identities/start times unchanged |
| Health | Local and public health return HTTP 200; both services have zero restarts |
| Asset checks | 8/8 local/public responses match the release; public HTML accounts for the proven Cloudflare addition described below |
| Anonymous receiving API | HTTP 401 |
| Operational reads | Ten Sep-16 orders, three load selections, completed SN1400333 excluded and repeat rejected |

The unchanged test failures are `P3.12: browser specs share one worker-owned database-pool lifecycle` and `quality non-regression: the gauntlet builds and validates the omit-dev runtime`.

## First attempt and correction

The initial cutover at 01:44:11 UTC passed application health and deployed operational reads, then automatically restored the prior image because the public HTML hash differed. A comparison against the restored, healthy release proved that Cloudflare inserts one analytics script and newline into public HTML. The application bytes were unchanged.

The deployment verifier now removes only that exact observed script structure and its appended newline from public HTML, with at most one match. Local HTML and all JavaScript/CSS/service-worker files still require exact hashes. Captured baseline HTML proved byte-for-byte equality after normalization, and an unrelated application-byte change still failed comparison. The application code was unchanged; the same verified runtime was rebuilt, retested and deployed successfully. First-attempt startup/cutover/rollback records are retained under `attempt-1/`.

## Backup, rollback and reproduction

Private deployment directory:
`/home/ubuntu/operatorapp-deploy-backups/operator-improvements-20260916/`.

It contains private container/configuration snapshots, image/manifest files, schema and affected-table custom-format backups, validated `pg_restore --list` inventories, candidate test/startup logs, migration records, live verification and final health results. The scoped data backup covers `operator_consolidated_loads` and `schema_migrations`; this is not a full database backup.

The prior image and `compose.rollback.yml` are retained. Apply that override last over the Compose paths recorded in `containers.before.private.json`, recreating only `app` and `webhook-worker` with `up -d --no-deps --no-build --pull never`. Application rollback keeps the additive schema and any queued photos; do not drop the queue or restore business data as an automatic rollback step.

Commands from `server/`:

```bash
sudo -n python3 tools/operator-improvements-deploy.py prepare
sudo -n python3 tools/operator-improvements-deploy.py apply
sudo -n python3 tools/operator-improvements-deploy.py verify
```

Preparation/cutover intentionally require the recorded prior release and matching source. `verify` reads the deployed application and served assets without changing business state. Sep-16 expectations may need review after legitimate operational changes.

[Deployment spec](operator-improvements-deployment-spec.md), [posting/receiving implementation evidence](operator-posting-latency-evidence.md), [consolidation implementation evidence](consolidation-group-planning-evidence.md).
