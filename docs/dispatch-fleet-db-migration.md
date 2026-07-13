# Dispatch Fleet Database Migration

Drivers and trucks are stored in PostgreSQL starting with migration
`019_dispatch_fleet_setup.sql`. Driver passwords are stored as salted scrypt hashes and
are never returned by the dispatch setup API.

The fleet tables are:

- `dispatch_drivers`
- `dispatch_trucks`

The remaining dispatch setup values, such as own yards, sync settings, and the Samsara
DVIR author, remain in the `app_data` volume's `dispatch-setup.json` file.

## Local Docker Setup

From the repository root in PowerShell:

```powershell
docker compose --env-file docker/env/.env build app migrate
docker compose --env-file docker/env/.env --profile tools run --rm migrate
docker compose --env-file docker/env/.env stop app
docker compose --env-file docker/env/.env --profile tools run --rm migrate npm run migrate:dispatch-fleet
docker compose --env-file docker/env/.env up -d app
docker compose --env-file docker/env/.env --profile tools run --rm migrate npm run verify:dispatch-fleet
```

Run `migrate:dispatch-fleet` only while `dispatch-setup.json` still contains the legacy
driver and truck arrays. It imports those arrays and removes them from that runtime JSON
only after the database transaction succeeds.

## Move The Fleet From This Computer To The VM

This process transfers only driver and truck setup. It does not replace orders, dispatch
plans, photos, audit records, or other VM data.

### 1. Export Fleet Data On Windows

Run from the local repository root:

```powershell
New-Item -ItemType Directory -Force docker\backups | Out-Null
docker compose --env-file docker/env/.env exec -T db pg_dump -U mbbs_app -d mbbs_yard --data-only --column-inserts --table=dispatch_drivers --table=dispatch_trucks --file=/tmp/dispatch-fleet.sql
$dbContainer = docker compose --env-file docker/env/.env ps -q db
docker cp "${dbContainer}:/tmp/dispatch-fleet.sql" docker\backups\dispatch-fleet.sql
scp docker\backups\dispatch-fleet.sql ubuntu@VM_IP:~/apps/operatorApp/docker/backups/dispatch-fleet.sql
```

Replace `VM_IP` with the VM address. The exported file contains password hashes and must
not be committed or shared.

### 2. Deploy The Code And Schema On Ubuntu

Connect to the VM, then run:

```bash

git pull origin codex/dispatch
docker compose --env-file docker/env/.env build app migrate
docker compose --env-file docker/env/.env --profile tools run --rm migrate
```

Migration `019` creates the fleet tables. It does not delete or alter existing orders or
dispatch plans.

### 3. Back Up Any Existing VM Fleet

```bash
cd ~/apps/operatorApp
mkdir -p docker/backups
docker compose --env-file docker/env/.env exec -T db pg_dump -U mbbs_app -d mbbs_yard --data-only --column-inserts --table=dispatch_drivers --table=dispatch_trucks --file=/tmp/dispatch-fleet-before-import.sql
db_container=$(docker compose --env-file docker/env/.env ps -q db)
docker cp "${db_container}:/tmp/dispatch-fleet-before-import.sql" docker/backups/dispatch-fleet-before-import.sql
```

### 4. Import The Local Fleet On The VM

```bash
cd ~/apps/operatorApp
docker compose --env-file docker/env/.env stop app
docker compose --env-file docker/env/.env exec -T db psql -U mbbs_app -d mbbs_yard -v ON_ERROR_STOP=1 -c "TRUNCATE dispatch_drivers, dispatch_trucks RESTART IDENTITY;"
docker compose --env-file docker/env/.env exec -T db psql -U mbbs_app -d mbbs_yard -v ON_ERROR_STOP=1 < docker/backups/dispatch-fleet.sql
docker compose --env-file docker/env/.env up -d app
```

If the import fails, restore the pre-import file with the same truncate and `psql`
commands before starting the app.

### 5. Verify The VM

```bash
cd ~/apps/operatorApp
docker compose --env-file docker/env/.env --profile tools run --rm migrate npm run verify:dispatch-fleet
curl http://127.0.0.1:3000/health
docker compose --env-file docker/env/.env logs --tail 100 app
```

Then check `/dispatch/setup` and confirm the expected drivers, truck plates, truck order,
Samsara usernames, capacities, and timing values are present. Test one driver login before
using the VM for live dispatch work.

## Future Code Deployments

After this one-time data transfer, future releases only need the normal code and schema
steps:

```bash
cd ~/apps/operatorApp
git pull origin codex/dispatch
docker compose --env-file docker/env/.env build app migrate
docker compose --env-file docker/env/.env --profile tools run --rm migrate
docker compose --env-file docker/env/.env up -d app
```

Database volumes retain the fleet records across container rebuilds and restarts.
