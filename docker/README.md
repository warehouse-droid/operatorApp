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

Normal operation:

```powershell
docker compose --env-file docker/env/.env ps
docker compose --env-file docker/env/.env logs -f app
docker compose --env-file docker/env/.env restart app
docker compose --env-file docker/env/.env down
docker compose --env-file docker/env/.env up -d
```

Do not use `docker compose down -v` during normal operation because `-v` deletes the PostgreSQL, app-data, and Ollama model volumes.
