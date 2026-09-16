"""Deploy the verified Operator improvements with an additive migration and image rollback."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / "server"
RELEASE = Path("/home/ubuntu/operatorapp-deploy-backups/operator-improvements-20260916")
IMAGE = "mbbs-operator-app:operator-improvements-20260916-v1"
ROLLBACK = "mbbs-operator-app:rollback-operator-improvements-20260916"
BASE_IMAGE = "sha256:a5d846bafecb1ea26e7e960c8d8f25a52dc05600ff08461a44387f4fd6e62989"
SERVICES = ["mbbs-operator-app-app-1", "mbbs-operator-app-webhook-worker-1"]
DEPENDENCIES = ["mbbs-operator-app-db-1", "mbbs-operator-app-ollama-1"]
TASKS = ["operator-posting-latency", "consolidation-group-planning"]
FILES = sorted({row["file"] for task in TASKS for row in json.loads((SERVER / f"test/{task}-changes.json").read_text())
                if row["file"].startswith(("src/", "public/", "migrations/"))})
MIGRATION = "201_operator_posting_photo_uploads.sql"


def run(*args, **kwargs):
    return subprocess.check_output(args, cwd=ROOT, **kwargs)


def save(name, value):
    path = RELEASE / name
    path.write_text(json.dumps(value, indent=2) + "\n")
    path.chmod(0o600)


def inspect(*containers):
    return json.loads(run("docker", "inspect", *containers))


def hashes(container):
    script = """const fs=require('fs'),crypto=require('crypto');
      const names=JSON.parse(process.argv[1]);console.log(JSON.stringify(Object.fromEntries(names.map(name=>[name,
      fs.existsSync('/app/'+name)?crypto.createHash('sha256').update(fs.readFileSync('/app/'+name)).digest('hex'):null]))));"""
    return json.loads(run("docker", "exec", container, "node", "-e", script, json.dumps(FILES)))


def image_files(image):
    script = """const fs=require('fs'),path=require('path'),crypto=require('crypto'),out={};
    function visit(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      if(dir==='/app'&&['node_modules','data'].includes(entry.name))continue;
      const file=path.join(dir,entry.name);
      if(entry.isDirectory())visit(file);
      else if(entry.isFile())out[path.relative('/app',file)]=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }}visit('/app');console.log(JSON.stringify(out));"""
    return json.loads(run("docker", "run", "--rm", "--network", "none", "--entrypoint", "node", image, "-e", script))


def compose(before, override):
    paths = before[0]["Config"]["Labels"]["com.docker.compose.project.config_files"].split(",")
    command = ["docker", "compose", "-p", "mbbs-operator-app"]
    for filename in paths:
        command += ["-f", filename]
    return command + ["-f", str(RELEASE / override)]


def source_gate():
    before, after = {}, {}
    for task in TASKS:
        changes = json.loads((SERVER / f"test/{task}-changes.json").read_text())
        report = json.loads((SERVER / f"test-artifacts/{task}/summary.json").read_text())
        state = hashlib.sha256(json.dumps([(row["file"], row["afterSha256"]) for row in changes]).encode()).hexdigest()
        assert state == report["sourceState"], task
        assert report["full"]["fail"] == report["baseline"]["fail"] == 2
        assert report["focused"]["fail"] == 0
        for row in changes:
            file = row["file"]
            if file in after:
                assert after[file] == row["beforeSha256"], f"Broken verified chain: {file}"
            before.setdefault(file, row["beforeSha256"])
            after[file] = row["afterSha256"]
    for file, digest in after.items():
        assert hashlib.sha256((SERVER / file).read_bytes()).hexdigest() == digest, f"Untested source: {file}"
    return {file: before[file] for file in FILES}, {file: after[file] for file in FILES}


def config_gate(before, command, image_id):
    configured = json.loads(run(*command, "config", "--format", "json"))
    defaults = dict(value.split("=", 1) for value in inspect(image_id)[0]["Config"]["Env"])
    for prior, service in zip(before, ["app", "webhook-worker"]):
        expected = {**defaults, **{key: str(value) for key, value in configured["services"][service]["environment"].items()}}
        actual = dict(value.split("=", 1) for value in prior["Config"]["Env"])
        assert expected == actual, f"Environment drift for {service}"
    save("compose.release.private.json", configured)


def prepare():
    os.umask(0o077)
    RELEASE.mkdir(parents=True, exist_ok=True, mode=0o700)
    expected_before, expected_after = source_gate()
    before = inspect(*SERVICES, *DEPENDENCIES)
    assert all(row["Image"] == BASE_IMAGE for row in before[:2]), "Live release changed"
    for container in SERVICES:
        assert hashes(container) == expected_before, "Live source changed"
    save("containers.before.private.json", before)
    for service_image, name in [(IMAGE, "compose.release.yml"), (ROLLBACK, "compose.rollback.yml")]:
        (RELEASE / name).write_text(f"services:\n  app:\n    image: {service_image}\n  webhook-worker:\n    image: {service_image}\n")
    stage = RELEASE / "image"
    for file in FILES:
        destination = stage / file
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SERVER / file, destination)
    run("docker", "tag", BASE_IMAGE, ROLLBACK)
    (stage / "Dockerfile").write_text(f"FROM {ROLLBACK}\n" + "\n".join(f"COPY --chown=node:node {file} /app/{file}" for file in FILES) + "\n")
    with (RELEASE / "build.log").open("wb") as output:
        subprocess.run(["docker", "build", "--network", "none", "--pull=false", "-t", IMAGE, str(stage)],
                       cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, check=True)
    image_id = inspect(IMAGE)[0]["Id"]
    base_files, candidate_files = image_files(BASE_IMAGE), image_files(image_id)
    changed = sorted(name for name in base_files.keys() | candidate_files.keys() if base_files.get(name) != candidate_files.get(name))
    assert changed == sorted(FILES), changed
    assert {file: candidate_files[file] for file in FILES} == expected_after
    save("candidate-files.json", candidate_files)
    config_gate(before, compose(before, "compose.release.yml"), image_id)
    # The entire candidate runtime must equal the source exercised by the final full suite.
    for file, digest in candidate_files.items():
        if file.startswith(("src/", "public/", "migrations/")) or file in ["package.json", "package-lock.json"]:
            assert hashlib.sha256((SERVER / file).read_bytes()).hexdigest() == digest, f"Candidate differs from tested workspace: {file}"
    candidate = RELEASE / "candidate"
    candidate.mkdir(exist_ok=True)
    temporary = run("docker", "create", "--entrypoint", "true", image_id).decode().strip()
    try:
        for folder in ["src", "public", "migrations"]:
            if (candidate / folder).exists():
                shutil.rmtree(candidate / folder)
            run("docker", "cp", f"{temporary}:/app/{folder}", str(candidate / folder))
    finally:
        run("docker", "rm", temporary)
    for folder in ["test", "tools"]:
        shutil.copytree(SERVER / folder, candidate / folder, dirs_exist_ok=True, ignore=shutil.ignore_patterns("__pycache__"))
    for file in ["package.json", "package-lock.json", "tsconfig.mbt.json", "eslint.mbt.config.js"]:
        shutil.copy2(SERVER / file, candidate / file)
    tests = ["test/mbt/unit/operator-posting-latency.test.js", "test/mbt/unit/operator-posting-photo-client.test.js",
        "test/mbt/unit/operator-receiving-return.test.js", "test/mbt/integration/operator-posting-photos.test.js",
        "test/mbt/integration/operator-posting-http-timing.test.js", "test/mbt/integration/operator-receiving-completed.test.js",
        "test/mbt/integration/consolidation-group-planning.test.js", "test/mbt/integration/consolidation-load.test.js",
        "test/mbt/unit/consolidation-load.test.js", "test/mbt/unit/consolidation-load-posting.test.js",
        "test/mbt/unit/sn1400333-receiving.test.js", "test/mbt/integration/migration-upgrade.test.js"]
    with (RELEASE / "candidate-tests.log").open("wb") as output:
        subprocess.run(["bash", str(SERVER / "tools/operator-receiving-identity-test.sh"), "node", "--test", "--test-concurrency=1", *tests],
            cwd=SERVER, env={**os.environ, "RECEIVING_IDENTITY_SOURCE_ROOT": str(candidate)},
            stdout=output, stderr=subprocess.STDOUT, check=True)
    candidate_smoke(image_id)
    environment_hashes = {str(path): hashlib.sha256(path.read_bytes()).hexdigest()
                          for path in [ROOT / "docker/env/.env", ROOT / "docker/env/.env.old"]}
    manifest = {"image": IMAGE, "imageId": image_id, "rollbackImage": ROLLBACK,
                "before": expected_before, "after": expected_after, "changedFiles": changed,
                "imageFileCount": len(candidate_files), "environmentHashes": environment_hashes}
    save("manifest.json", manifest)
    print(json.dumps({"prepared": IMAGE, "imageId": image_id, "changedFiles": changed}), flush=True)


def health():
    with urllib.request.urlopen("http://127.0.0.1:3000/health", timeout=2) as response:
        value = json.load(response)
        assert response.status == 200 and value["ok"] is True
        return value


def wait_ready(image_id):
    for _ in range(55):
        state = inspect(*SERVICES)
        if (all(row["Image"] == image_id and row["State"]["Running"] and row["RestartCount"] == 0 for row in state)
                and state[0]["State"].get("Health", {}).get("Status") == "healthy"):
            return health()
        time.sleep(1)
    raise RuntimeError("Release did not become healthy")


def cutover():
    os.umask(0o077)
    manifest = json.loads((RELEASE / "manifest.json").read_text())
    before = json.loads((RELEASE / "containers.before.private.json").read_text())
    current = inspect(*SERVICES, *DEPENDENCIES)
    source_gate()
    assert [row["Id"] for row in current] == [row["Id"] for row in before], "Containers changed since preparation"
    for container in SERVICES:
        assert hashes(container) == manifest["before"]
    config_gate(before, compose(before, "compose.release.yml"), manifest["imageId"])
    active_script = """import {query,pool} from './src/db.js';
      try {const rows=await query(`SELECT (SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing')) AS postings,
        (SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status='running') AS webhooks`);
        console.log(JSON.stringify(rows.rows[0]));} finally {await pool.end();}"""
    active = json.loads(run("docker", "exec", SERVICES[0], "node", "--input-type=module", "-e", active_script))
    assert int(active["postings"]) == 0 and int(active["webhooks"]) == 0, "Live posting work is active; retry cutover when idle"
    health()
    migrate_with_backup()
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    print(json.dumps({"cutoverStartedAt": started}), flush=True)
    command_end = ["up", "-d", "--no-deps", "--no-build", "--pull", "never", "app", "webhook-worker"]
    try:
        with (RELEASE / "cutover.log").open("wb") as output:
            subprocess.run(compose(before, "compose.release.yml") + command_end, cwd=ROOT,
                           stdout=output, stderr=subprocess.STDOUT, check=True, timeout=120)
        ready = wait_ready(manifest["imageId"])
        after = inspect(*SERVICES, *DEPENDENCIES)
        for prior, row in zip(before[:2], after[:2]):
            assert sorted(prior["Config"]["Env"]) == sorted(row["Config"]["Env"])
            assert sorted(prior["Mounts"], key=lambda mount: mount["Destination"]) == sorted(row["Mounts"], key=lambda mount: mount["Destination"])
            for field in ["Cmd", "Entrypoint", "User", "WorkingDir"]:
                assert prior["Config"][field] == row["Config"][field], field
            assert prior["HostConfig"]["PortBindings"] == row["HostConfig"]["PortBindings"]
            assert hashes(row["Name"]) == manifest["after"]
        assert [(row["Id"], row["State"]["StartedAt"]) for row in before[2:]] == [(row["Id"], row["State"]["StartedAt"]) for row in after[2:]]
        for path, digest in manifest["environmentHashes"].items():
            assert hashlib.sha256(Path(path).read_bytes()).hexdigest() == digest
        for name, container in zip(["app", "worker"], SERVICES):
            logs = run("docker", "logs", "--since", started, container, stderr=subprocess.STDOUT).decode()
            (RELEASE / f"{name}-startup.log").write_text(logs)
            assert not re.search(r"SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND|uncaughtException|operator_photo_worker_error", logs)
            if name == "worker":
                assert "NetSuite order webhook serial worker" in logs and "started." in logs
        verification = live_verify()
        result = {"deployed": True, "image": IMAGE, "imageId": manifest["imageId"], "health": ready,
                  "readyAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  "configurationPreserved": True, "dependenciesUnchanged": True, "changedFiles": FILES, "verification": verification, "migration": MIGRATION,
                  "containers": [{"name": row["Name"], "id": row["Id"], "restartCount": row["RestartCount"]} for row in after[:2]]}
        save("result.json", result)
        print(json.dumps(result), flush=True)
    except Exception:
        with (RELEASE / "rollback.log").open("wb") as output:
            subprocess.run(compose(before, "compose.rollback.yml") + command_end, cwd=ROOT,
                           stdout=output, stderr=subprocess.STDOUT, check=True, timeout=120)
        wait_ready(BASE_IMAGE)
        save("rolled-back.json", {"at": datetime.datetime.now(datetime.timezone.utc).isoformat()})
        raise


def candidate_smoke(image_id):
    network = f"operator-release-smoke-{os.getpid()}"
    database, application = f"{network}-db", f"{network}-app"
    try:
        run("docker", "network", "create", "--internal", network)
        run("docker", "run", "-d", "--name", database, "--network", network, "--network-alias", "db",
            "--tmpfs", "/var/lib/postgresql", "-e", "POSTGRES_USER=mbt_test", "-e", "POSTGRES_PASSWORD=mbt_test_password",
            "-e", "POSTGRES_DB=mbt_test", "postgres:18-alpine")
        for _ in range(30):
            ready = subprocess.run(["docker", "exec", database, "pg_isready", "-U", "mbt_test", "-d", "mbt_test"], capture_output=True)
            if ready.returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError("Disposable smoke database did not start")
        environment = ["-e", "DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test",
                       "-e", "MBBS_ENV_FILE=/nonexistent", "-e", "NODE_ENV=test", "-e", "MBT_TEST_ISOLATED=1"]
        with (RELEASE / "candidate-migration.log").open("wb") as output:
            subprocess.run(["docker", "run", "--rm", "--network", network, *environment, "--entrypoint", "node", image_id, "src/migrate.js"],
                           stdout=output, stderr=subprocess.STDOUT, check=True)
        run("docker", "run", "-d", "--name", application, "--network", network, *environment, "--entrypoint", "node", image_id, "src/server.js")
        probe = "fetch('http://127.0.0.1:3000/health').then(async r=>{if(!r.ok||(await r.json()).ok!==true)process.exit(1)}).catch(()=>process.exit(1))"
        for _ in range(40):
            ready = subprocess.run(["docker", "exec", application, "node", "-e", probe], capture_output=True)
            if ready.returncode == 0:
                break
            time.sleep(0.5)
        else:
            raise RuntimeError("Production image failed isolated readiness")
        time.sleep(6)
        logs = run("docker", "logs", application, stderr=subprocess.STDOUT).decode()
        (RELEASE / "candidate-startup.log").write_text(logs)
        assert not re.search(r"operator_photo_worker_error|SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND", logs)
        assert inspect(application)[0]["State"]["Running"]
        save("candidate-smoke.json", {"health": 200, "photoWorkerPollsWithoutErrors": True, "externalNetwork": False, "imageId": image_id})
    finally:
        subprocess.run(["docker", "rm", "-f", application, database], capture_output=True)
        subprocess.run(["docker", "network", "rm", network], capture_output=True)


def node_read(script):
    result = subprocess.run(["docker", "exec", "-i", SERVICES[0], "node", "--input-type=module"],
                            input=script, text=True, capture_output=True, check=True)
    return json.loads(result.stdout)


def migrate_with_backup():
    inventory = node_read("""import {query,withTransaction,pool} from './src/db.js';
      try {await withTransaction(async()=>{await query('SET TRANSACTION READ ONLY');
        console.log(JSON.stringify((await query('SELECT filename FROM schema_migrations ORDER BY filename')).rows.map(r=>r.filename)));
      });} finally {await pool.end();}""")
    pending = sorted(file.name for file in (SERVER / "migrations").glob("*.sql") if file.name not in inventory)
    assert pending in [[], [MIGRATION]], f"Unexpected pending migrations: {pending}"
    if not pending:
        save("migration.json", {"alreadyApplied": MIGRATION})
        return
    # The migration creates a new queue and adds a nullable field; it rewrites no existing rows.
    for filename, options in [("schema-before.dump", ["--schema-only"]),
                              ("affected-tables-before.dump", ["--table=public.operator_consolidated_loads", "--table=public.schema_migrations"])]:
        with (RELEASE / filename).open("wb") as output:
            subprocess.run(["docker", "exec", DEPENDENCIES[0], "sh", "-c",
                            'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom "$@"', "backup", *options],
                           stdout=output, stderr=subprocess.PIPE, check=True)
        with (RELEASE / filename).open("rb") as source:
            contents = subprocess.check_output(["docker", "exec", "-i", DEPENDENCIES[0], "pg_restore", "--list"], stdin=source)
        assert b"TABLE" in contents and b"schema_migrations" in contents
        (RELEASE / (filename + ".toc")).write_bytes(contents)
    sql = (SERVER / "migrations" / MIGRATION).read_text()
    result = node_read("""import {query,withTransaction,pool} from './src/db.js';
      try {await withTransaction(async()=>{
        await query("SET LOCAL lock_timeout='5s'"); await query("SET LOCAL statement_timeout='30s'");
        await query("SELECT pg_advisory_xact_lock(hashtext('operator-improvements-migration'))");
        const filename=FILENAME;
        if(!(await query('SELECT 1 FROM schema_migrations WHERE filename=$1',[filename])).rowCount){
          await query(SQL); await query('INSERT INTO schema_migrations(filename) VALUES($1)',[filename]);
        }
        console.log(JSON.stringify({applied:filename}));
      });} finally {await pool.end();}""".replace("FILENAME", json.dumps(MIGRATION)).replace("SQL", json.dumps(sql)))
    save("migration.json", result)


def live_verify():
    result = node_read("""import assert from 'node:assert/strict';
      import {query,withTransaction,pool} from './src/db.js';
      import {listConsolidationLoadOrders,readConsolidationOrders} from './src/consolidation-load-repository.js';
      import {buildConsolidationSnapshot} from './src/consolidation-load-domain.js';
      import {listReceivingOrders,getReceivableReceivingOrder} from './src/receiving-repository.js';
      try {await withTransaction(async()=>{
        await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
        const operator={id:'deployment-read-only',role:'admin',roles:['admin'],operatorYardLocationIds:[1,15,28,26]};
        const orders=(await listConsolidationLoadOrders(operator,{locationId:1,planDate:'2026-09-16'})).orders;
        const expected=['SOA08600','SOA08648','SOB120124','SOB120358','SOB120251','SOB120252','SOB120300','SOB120301','SOB120385','RP-UNI-GORMLEY-3445-0915-1'];
        assert.deepEqual(orders.map(o=>o.tranid).sort(),expected.sort());
        for(const refs of [['SOA08600','SOA08648','SOB120124','SOB120358'],['SOB120251','SOB120252'],['SOB120300','SOB120301']]){
          const ids=orders.filter(o=>refs.includes(o.tranid)).map(o=>o.netsuite_id);
          assert.equal(buildConsolidationSnapshot(await readConsolidationOrders(operator,1,ids)).orders.length,refs.length);
        }
        const po=(await query("SELECT netsuite_id,tranid,receipt_status,last_item_receipt_id FROM purchase_orders WHERE tranid='SN1400333'")).rows[0];
        assert.equal(po.receipt_status,'received');
        assert.ok(!(await listReceivingOrders({orderType:'purchase_order',search:po.tranid})).some(o=>String(o.netsuite_id)===String(po.netsuite_id)));
        await assert.rejects(getReceivableReceivingOrder(po.netsuite_id,{includeNetSuiteClosed:true}),{code:'RECEIVING_ALREADY_COMPLETED',status:409});
        const queue=(await query('SELECT status,count(*)::int AS count FROM operator_posting_photo_uploads GROUP BY status')).rows;
        console.log(JSON.stringify({mode:'deployed modules; READ ONLY transaction',consolidationCount:orders.length,orders:orders.map(({tranid,assignment})=>({tranid,assignment})),loadSelections:3,
          receiving:{order:po.tranid,hidden:true,repeatStatus:409,receiptId:po.last_item_receipt_id},photoQueue:queue}));
      });} finally {await pool.end();}""")
    manifest = json.loads((RELEASE / "manifest.json").read_text())
    probes = []
    for origin in ["http://127.0.0.1:3000", "https://test.mbbsoperation.com"]:
        for route, file in [("/operator", "public/operator.html"), ("/operator.js?v=20260916-posting-photos-v1", "public/operator.js"),
                            ("/operator.css?v=20260916-posting-photos-v1", "public/operator.css"), ("/service-worker.js", "public/service-worker.js")]:
            request = urllib.request.Request(origin + route, headers={"User-Agent": "Mozilla/5.0", "Cache-Control": "no-cache"})
            with urllib.request.urlopen(request, timeout=15) as response:
                assert response.status == 200
                body = response.read()
                edge_scripts = 0
                if origin.startswith("https:") and file == "public/operator.html":
                    body, edge_scripts = normalize_edge_html(body)
                assert hashlib.sha256(body).hexdigest() == manifest["after"][file], origin + route
                probes.append({"url": origin + route, "status": 200, "hashMatched": True, "edgeAnalyticsScripts": edge_scripts})
    result["assets"] = probes
    save("live-verification.json", result)
    return result


def normalize_edge_html(body):
    # Cloudflare adds this analytics script to public HTML; every application byte still must match.
    pattern = rb'''<script type="module" src="https://static\.cloudflareinsights\.com/beacon\.min\.js/[A-Za-z0-9]+" integrity="sha512-[A-Za-z0-9+/=]+" data-cf-beacon='[^']*' crossorigin="anonymous"></script>\n'''
    normalized, count = re.subn(pattern, b"", body)
    assert count <= 1, "Unexpected repeated edge analytics injection"
    return normalized, count


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["prepare", "apply", "verify"])
    mode = parser.parse_args().mode
    if mode == "prepare":
        prepare()
    elif mode == "apply":
        cutover()
    else:
        print(json.dumps(live_verify()))
