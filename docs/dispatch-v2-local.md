# Independent localhost:3099 Docker runtime

Port 3099 runs the same `codex/dockerVer` working tree as port 3000, but as the
separate Compose project `mbbs-operator-app-v2`. Its PostgreSQL, application
data, and Ollama volumes remain isolated from the port-3000 project.

## Runtime contract

- The app and migration runner load `docker/env/.env.old` as `.env.old`.
- The database container also receives `docker/env/.env.old`.
- Port 3099 binds only to `127.0.0.1`.
- `NETSUITE_MIRROR_ROLE=disabled` on both applications.
- There is no shared relay network and no 3000-to-3099 data replication.
- The old mirror tables and disabled implementation remain only for migration
  compatibility with databases that already contain that schema.
- Port 3099 keeps Samsara writes and Smart SCM live execution disabled.

## Required `.env.old` settings

Keep the file permission-restricted and configure these values without printing
secrets:

```dotenv
APP_BASE_URL=http://localhost:3099
NETSUITE_REDIRECT_URI=http://localhost:3099/api/auth/netsuite/callback
NETSUITE_MIRROR_ROLE=disabled
NETSUITE_MIRROR_SHARED_SECRET=
NETSUITE_MIRROR_SOURCE_URL=
NETSUITE_MIRROR_CONSUMER_URL=
NETSUITE_DIRECT_ACCESS_ENABLED=true
SAMSARA_WRITES_ENABLED=false
SMART_SCM_LIVE_EXECUTION_ENABLED=false
```

The `DATABASE_URL` and `POSTGRES_*` values must match the existing isolated V2
database. Do not point the 3099 app at the port-3000 PostgreSQL project.

The NetSuite account in `.env.old` determines whether OAuth targets production
or a sandbox. Register the exact port-3099 callback URI in that NetSuite
integration before starting login.

## Rebuild and start

```bash
docker compose -f docker-compose.yml -f docker-compose.v2.yml config
docker compose -f docker-compose.yml -f docker-compose.v2.yml up -d db
docker compose -f docker-compose.yml -f docker-compose.v2.yml build app
docker compose -f docker-compose.yml -f docker-compose.v2.yml run --rm --no-deps app npm run migrate
docker compose -f docker-compose.yml -f docker-compose.v2.yml up -d --force-recreate app
```

Production port 3000 no longer needs a source overlay:

```bash
docker compose -f docker-compose.yml up -d --force-recreate app
```

## Verification

```bash
docker compose -f docker-compose.yml -f docker-compose.v2.yml ps
curl -fsS http://127.0.0.1:3099/health
docker compose -f docker-compose.yml -f docker-compose.v2.yml run --rm --no-deps -e MBBS_REPO_ROOT=/workspace -v "$PWD:/workspace:ro" app npm run test:netsuite-mirror
```

The rendered V2 configuration must contain `127.0.0.1:3099:3000`, must mount
`.env.old`, and must not contain `mirror_sync` or `mbbs-sync`.

After OAuth login, run NetSuite synchronization manually from the control panel.
The isolated setup defaults to manual mode and does not sync on application
startup.
