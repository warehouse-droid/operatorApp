"""Release only the shared daily Maps capacity over the captured production image."""
import datetime
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("maps_release_core", Path(__file__).with_name("operator-display-settings-deploy.py"))
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
CHECKS = SERVER / "test-artifacts/maps-daily-capacity"
core.RELEASE = SERVER / "test-artifacts/maps-daily-capacity-deployment-20260922"
core.BEFORE = CHECKS / "baseline"
core.IMAGE = "mbbs-operator-app:maps-daily-capacity-20260922-v1"
core.ROLLBACK = "mbbs-operator-app:rollback-maps-daily-capacity-20260922-v1"
core.MIGRATION = "219_google_maps_daily_capacity.sql"
core.EXISTING = ["public/admin.html", "public/control.js", "public/control.css",
                 "src/google-maps-usage-policy.js", "src/google-maps-usage-repository.js", "src/server.js"]
core.ADDED = ["migrations/" + core.MIGRATION]
core.FILES = sorted(core.EXISTING + core.ADDED)
original_docker = core.docker


def docker(*args, **kwargs):
    if args[0] != "cp":
        return original_docker(*args, **kwargs)
    target = Path(args[2])
    assert target.resolve().is_relative_to(core.RELEASE.resolve())
    archive_bytes = original_docker("cp", args[1], "-", **kwargs)
    with tarfile.open(fileobj=io.BytesIO(archive_bytes)) as archive:
        assert all(Path(member.name).parts[0] == target.name for member in archive.getmembers())
        archive.extractall(target.parent, filter="data")
    return b""


core.docker = docker


def source_gate():
    proof = json.loads((CHECKS / "checks.json").read_text())
    assert proof["passed"]
    for name, sha in proof["runtimeHashes"].items():
        assert core.digest((SERVER / name).read_bytes()) == sha, "Source changed: " + name
    return proof


def prepare():
    source_gate()
    core.prepare()


def candidate_check():
    state = core.manifest()
    source_gate()
    core.current(state)
    script = """import assert from 'node:assert/strict';
import {app} from './src/server.js';
import {pool} from './src/db.js';
import {googleMapsUsageRepository} from './src/google-maps-service.js';
const server=app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
try { const base='http://127.0.0.1:'+server.address().port;
assert.equal((await fetch(base+'/health')).status,200);
assert.equal((await fetch(base+'/api/admin/maps-usage/reopen-daily',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
const summary=await googleMapsUsageRepository.summary(); assert.equal(summary.dailyCapacity.baseLimit,150);
console.log(JSON.stringify({health:200,anonymousReopen:401,baseDailyLimit:150}));
} finally {await new Promise(r=>server.close(r)); await pool.end();}
"""
    result = docker("run", "--rm", "-i", "--network", "mbbs-maps-daily-capacity-test", "--read-only",
                    "--tmpfs", "/app/data:uid=1000,gid=1000,mode=0700", "--tmpfs", "/tmp",
                    "-e", "NODE_ENV=test", "-e", "MBT_TEST_ISOLATED=1", "-e", "MBBS_ENV_FILE=.env.maps-daily-test-missing",
                    "-e", "DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test",
                    "--entrypoint", "node", core.IMAGE, "--input-type=module", input=script.encode())
    core.save("candidate-check.json", json.loads(result))
    core.save("verified.json", {"passed": True, "imageId": state["candidateImageId"]})
    print(result.decode().strip())


def verify():
    state = core.manifest()
    core.ready(state["candidateImageId"])
    after = core.metadata(core.APP)
    assert after["configuration"] == state["app"]["configuration"]
    assert [core.metadata(name) for name in core.DEPENDENCIES] == state["dependencies"]
    actual = docker("exec", core.APP, "sha256sum", *["/app/" + name for name in core.FILES]).decode().splitlines()
    assert {line.split()[1].removeprefix("/app/"): line.split()[0] for line in actual} == state["after"]
    assert core.database("SELECT count(*) FROM schema_migrations WHERE filename='" + core.MIGRATION + "';").strip() == "1"
    script = """import assert from 'node:assert/strict'; import crypto from 'node:crypto';
import {pool} from './src/db.js'; import {config} from './src/config.js';
import {createGoogleMapsUsageRepository} from './src/google-maps-usage-repository.js';
import {GOOGLE_MAPS_USAGE_LIMITS} from './src/google-maps-usage-policy.js';
for (const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
 for (const [name,hash] of Object.entries(ASSETS)) {
  const r=await fetch(base+'/'+name.replace(/^public\\//,''),{headers:{'Cache-Control':'no-cache'}});
  assert.equal(r.status,200); assert.equal(crypto.createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex'),hash);
 }
 assert.equal((await fetch(base+'/health')).status,200);
 assert.equal((await fetch(base+'/api/admin/maps-usage/reopen-daily',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
}
const client=await pool.connect(); let summary;
try { await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
summary=await createGoogleMapsUsageRepository({query:(sql,p)=>client.query(sql,p)}).summary();
assert.equal(summary.dailyCapacity.baseLimit,150); assert.equal(GOOGLE_MAPS_USAGE_LIMITS.subsystemLimits.dynamic_map,undefined);
} finally {await client.query('ROLLBACK'); client.release(); await pool.end();}
console.log(JSON.stringify({mode:config.googleMaps.mode,dailyCapacity:summary.dailyCapacity,rolling30Day:summary.rolling30Day,
 hardLimit:summary.hardLimit,perSubsystem:summary.perSubsystem,anonymousReopen:401,publicAssetHashes:3,googleCallsMade:0}));
""".replace("ASSETS", json.dumps({name: value for name, value in state["after"].items() if name.startswith("public/")}))
    http = json.loads(docker("exec", "-i", core.APP, "node", "--input-type=module", input=script.encode()))
    result = {"deployed": True, "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "image": core.IMAGE, "imageId": after["imageId"], "configurationPreserved": True,
              "dependenciesUnchanged": True, "migration": core.MIGRATION, **http}
    core.save("deployment-result.json", result)
    print(json.dumps(result))


def apply():
    source_gate()
    state = core.manifest()
    core.current(state)
    proof = json.loads((core.RELEASE / "verified.json").read_text())
    assert proof == {"passed": True, "imageId": state["candidateImageId"]}
    resolved = json.loads(subprocess.check_output(core.compose(state, "compose.release.yml") + ["config", "--format", "json"], cwd=core.ROOT))["services"]["app"]
    image_config = json.loads(docker("image", "inspect", core.IMAGE))[0]["Config"]
    runtime_config = json.loads(docker("inspect", core.APP))[0]["Config"]
    expected_env = dict(entry.split("=", 1) for entry in image_config["Env"])
    expected_env.update({key: str(value) for key, value in resolved.get("environment", {}).items()})
    assert expected_env == dict(entry.split("=", 1) for entry in runtime_config["Env"]), "Environment would change"
    for filename, options in [("schema-before.dump", ["--schema-only"]), ("migrations-before.dump", ["--table=public.schema_migrations"])]:
        with (core.RELEASE / filename).open("wb") as output:
            subprocess.run(["sudo", "-n", "docker", "exec", core.DEPENDENCIES[1], "pg_dump", "-U", "mbbs_app", "-d", "mbbs_yard", "--format=custom", *options], stdout=output, check=True)
        with (core.RELEASE / filename).open("rb") as source:
            assert b"schema_migrations" in docker("exec", "-i", core.DEPENDENCIES[1], "pg_restore", "--list", stdin=source)
    assert core.database("SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing');").strip() == "0", "Wait for active posting"
    if core.database("SELECT count(*) FROM schema_migrations WHERE filename='" + core.MIGRATION + "';").strip() == "0":
        sql = (core.RELEASE / "candidate/migrations" / core.MIGRATION).read_text()
        core.database("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';\n" + sql +
                      "\nINSERT INTO schema_migrations(filename) VALUES ('" + core.MIGRATION + "'); COMMIT;")
    core.current(state)
    command = ["up", "-d", "--no-build", "--no-deps", "--pull", "never", "app"]
    try:
        with (core.RELEASE / "cutover.log").open("wb") as output:
            subprocess.run(core.compose(state, "compose.release.yml") + command, cwd=core.ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=100)
        verify()
    except Exception:
        with (core.RELEASE / "rollback.log").open("wb") as output:
            subprocess.run(core.compose(state, "compose.rollback.yml") + command, cwd=core.ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=100)
        core.ready(state["app"]["imageId"])
        raise


if __name__ == "__main__":
    {"prepare": prepare, "build": core.build, "candidate": candidate_check, "apply": apply, "verify": verify}[sys.argv[1]]()
