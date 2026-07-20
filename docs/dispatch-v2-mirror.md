# Dispatch V2 isolated NetSuite mirror

Dispatch V2 runs as a separate Compose project on `127.0.0.1:3099`. It has its own PostgreSQL, application-data, and Ollama volumes. Its database is seeded once from the current application and then owns its planning, operator, driver, and photo state independently.

Only the current port-3000 application talks directly to NetSuite. NetSuite-backed order headers, order lines, item conversions, and inventory balances flow to V2 through an authenticated private application API.

## Runtime contract

- Current app: `NETSUITE_MIRROR_ROLE=source`, direct NetSuite access enabled, Samsara writes enabled.
- Dispatch V2: `NETSUITE_MIRROR_ROLE=consumer`, direct NetSuite access disabled, NetSuite credentials blank, Samsara writes disabled.
- Source writes a durable, ordered outbox in the same transaction as webhook order changes.
- Source pushes every five seconds; V2 also polls every 30 seconds, so either side recovers from a temporary restart.
- V2 applies source sequence numbers strictly in order and idempotently.
- A six-hour incremental reconciliation repairs unlikely drift. Admin can also run a full reconciliation.
- Delivered source events are retained for 30 days. If V2 falls behind that window, it automatically takes a full high-water baseline and recovers.
- Only normalized NetSuite-owned fields are applied. V2 planning, load assignment, operator/driver progress, proof photos, and other local workflow fields are preserved.

## Files

- `docker-compose.mirror-source.yml`: joins only the current app container to the private sync network.
- `docker-compose.v2.yml`: separate Compose project and volumes, bound only to localhost port 3099.
- `docker/v2.env.example`: locked-down V2 environment template.
- `server/migrations/038_netsuite_mirror.sql`: source outbox, consumer inbox, and cursor state.
- Admin > Sync Settings: mirror role, high-water sequence, applied sequence, lag, failures, retry, and full reconciliation.

## First deployment

Do not point both applications at the same PostgreSQL database. Do not expose the internal mirror API through Cloudflare.

1. Create the private Docker network once:

```bash
docker network create mbbs-sync
```

If it already exists, Docker will report that and no change is needed.

2. Generate one shared secret and put the identical value in both environment files:

```bash
openssl rand -hex 32
```

Add these settings to `docker/env/.env` for the current application:

```dotenv
NETSUITE_MIRROR_ROLE=source
NETSUITE_MIRROR_SHARED_SECRET=<generated-secret>
NETSUITE_MIRROR_CONSUMER_URL=http://mbbs-dispatch-v2-app:3000
NETSUITE_MIRROR_SOURCE_URL=
NETSUITE_DIRECT_ACCESS_ENABLED=true
SAMSARA_WRITES_ENABLED=true
```

In the `codex/dispatchv2` worktree, create the ignored environment directory, replace the template passwords and shared secret, and keep the file permission-restricted:

```bash
mkdir -p docker/env
cp docker/v2.env.example docker/env/.env.v2
chmod 600 docker/env/.env.v2
```

3. Back in the current app worktree, migrate and restart with the source overlay before taking the clone. It is safe if V2 is not running yet; relay attempts remain in the outbox.

```bash
docker compose -f docker-compose.yml -f docker-compose.mirror-source.yml --profile tools run --rm --build migrate
docker compose -f docker-compose.yml -f docker-compose.mirror-source.yml up -d --build app
```

4. Capture the source sequence before starting `pg_dump`. This ordering is important: changes made during the dump receive a later sequence and will be replayed after the clone.

```bash
SOURCE_SEQUENCE="$(docker compose -f docker-compose.yml -f docker-compose.mirror-source.yml exec -T db sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT last_sequence FROM netsuite_mirror_sequence WHERE singleton_id = 1"')"
printf 'Clone source sequence: %s\n' "$SOURCE_SEQUENCE"

docker compose -f docker-compose.yml -f docker-compose.mirror-source.yml exec -T db sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > /tmp/mbbs-dispatch-v2-seed.dump
```

5. From a `codex/dispatchv2` worktree containing this mirror implementation, start only the isolated database and restore the clone:

```bash
docker compose -f docker-compose.yml -f docker-compose.v2.yml up -d db

docker compose -f docker-compose.yml -f docker-compose.v2.yml exec -T db sh -lc 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --no-privileges' < /tmp/mbbs-dispatch-v2-seed.dump
```

6. Apply the V2 migrations. The migration runner applies missing driver-oriented migrations 036/037 even though the restored source already records 038.

```bash
docker compose -f docker-compose.yml -f docker-compose.v2.yml --profile tools run --rm --build migrate
```

7. Scrub cloned NetSuite tokens and login sessions, clear cloned mirror queues, and set the consumer cursor to the pre-dump source sequence:

```bash
docker compose -f docker-compose.yml -f docker-compose.v2.yml run --rm --build --no-deps app npm run mirror:init -- "$SOURCE_SEQUENCE"
```

8. Start V2. Cloudflared can continue forwarding `v1.mbbsoperation.com` to `http://localhost:3099`.

```bash
docker compose -f docker-compose.yml -f docker-compose.v2.yml up -d --build
```

9. Open Admin > Sync Settings on V2. `Applied sequence` should catch up to `Source high-water`, `Event lag` should reach zero, and `Failed` should remain zero. Run one full reconciliation after the first catch-up.

## Normal operation

Always operate the current deployment with its source overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.mirror-source.yml up -d
```

Always operate V2 with its V2 overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.v2.yml up -d
```

The source push and consumer poll paths are both enabled. Restarting either app does not lose changes: unapplied records stay in PostgreSQL and resume after restart.

## Recovery

- For a transient failure, use Admin > Sync Settings > Retry Failed / Catch Up.
- An expired event cursor triggers Full Reconciliation automatically. The Admin button can run the same recovery manually: it takes a source high-water baseline, applies current snapshots, advances the cursor, then resumes later events.
- If the shared secret changes, update both environments before restarting either side.
- If V2 is rebuilt from another clone, repeat the pre-dump sequence capture and `mirror:init`; never reuse an arbitrary cursor.
- Do not copy source `app_data` into V2. New V2 proofs use local data URLs stored in the isolated V2 database.

## Verification

Static contract test:

```bash
docker compose -f docker-compose.yml -f docker-compose.v2.yml run --rm --no-deps app npm run test:netsuite-mirror
```

Compose isolation checks:

```bash
docker compose -f docker-compose.yml -f docker-compose.mirror-source.yml config
docker compose -f docker-compose.yml -f docker-compose.v2.yml config
```

The V2 render must show only `127.0.0.1:3099:3000` for the app and volume names prefixed with `mbbs-operator-app-v2_`.
