# Local Docker runtime

The Docker environment files and database backups in this folder are ignored by Git.

Prepare the runtime environment without printing secrets:

```powershell
node docker/prepare-env.mjs
```

All Compose commands must use the generated environment file:

```powershell
docker compose --env-file docker/env/.env up -d db
docker compose --env-file docker/env/.env --profile tools run --rm bootstrap-data
docker compose --env-file docker/env/.env --profile tools run --rm migrate
docker compose --env-file docker/env/.env up -d ollama
docker compose --env-file docker/env/.env --profile tools run --rm ollama-pull
docker compose --env-file docker/env/.env up -d app
```

The app defaults to `http://localhost:3001`. For cutover, set `MBBS_APP_HOST_PORT=3000` in `docker/env/.env` and recreate the app container after the host Node server is stopped.

Use the helper to change the persistent host port without exposing or replacing secrets:

```powershell
node docker/set-host-port.mjs 3000
docker compose --env-file docker/env/.env up -d --force-recreate app
```

Create an ignored custom-format PostgreSQL backup:

```powershell
powershell -ExecutionPolicy Bypass -File docker/backup-docker-db.ps1
```

Full database backups are stored under `backups/production`. The host's daily
`operatorapp-storage-cleanup` timer retains the five newest full `.dump` backups
under `backups`, ordered by modification time. Keep partial schema, repair and
deployment snapshots in `docker/backups`, `operatorapp-deploy-backups` or
`server/deployments`; those locations are outside full-database retention.

Host deployment copies now retain the latest five complete copies across
`server/deployments` and `/home/ubuntu/operatorapp-deploy-backups`. The hourly
`operatorapp-copy-retention.timer` removes older copies and abandoned test
artifacts, preserving live Compose files, tracked records, and operational audits.
It leaves recently active trees for at least two hours and checks production
container identity and health before and after deletion.

Run host tests with `bash docker/run-isolated-tests.sh [command ...]`. This uses
the bounded isolated Compose configuration, a unique project and artifact folder,
and unconditional container/volume/network teardown. Its outer runner deletes
the run's artifacts after success, failure, or interruption. For custom bounded
harnesses, use `python3 docker/retention/retention.py run -- <command>` and write
all temporary output under `$MBBS_TEST_ARTIFACT_DIR`. Keep concise source evidence
and operational audits separately; the hourly sweep is recovery, not a substitute
for immediate teardown. Validate retention changes with
`bash docker/retention/check.sh`.

Normal operation:

```powershell
docker compose --env-file docker/env/.env ps
docker compose --env-file docker/env/.env logs -f app
docker compose --env-file docker/env/.env restart app
docker compose --env-file docker/env/.env down
docker compose --env-file docker/env/.env up -d
```

## VM update

From the repository root on the Ubuntu VM, run the automated updater:

```bash
bash docker/update-vm.sh
```

The updater creates a PostgreSQL backup, pulls `origin/codex/dockerVer`, builds the
new images, stops only the app, applies migrations, recreates the app container,
and verifies the configured host port with `/health`.

Optional overrides:

```bash
BRANCH=codex/dockerVer bash docker/update-vm.sh
HEALTH_URL=http://127.0.0.1:3000/health bash docker/update-vm.sh
SKIP_BACKUP=1 bash docker/update-vm.sh
```

The script intentionally stops if the VM Git worktree contains local changes.
Commit or stash those changes before running it.

Do not use `docker compose down -v` during normal operation because `-v` deletes the PostgreSQL, app-data, and Ollama model volumes.

## Independent localhost:3099

The secondary Docker project uses the same working tree with
`docker-compose.v2.yml`, loads `docker/env/.env.old`, and binds to
`http://127.0.0.1:3099`. It does not use the retired NetSuite relay network.

```bash
docker compose -f docker-compose.yml -f docker-compose.v2.yml build app
docker compose -f docker-compose.yml -f docker-compose.v2.yml run --rm --no-deps app npm run migrate
docker compose -f docker-compose.yml -f docker-compose.v2.yml up -d --force-recreate app
```

See `docs/dispatch-v2-local.md` for the environment contract and isolation checks.
