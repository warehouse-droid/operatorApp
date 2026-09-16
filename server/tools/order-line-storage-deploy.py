"""Prepare and deploy the tested orderLine schema, app and webhook worker."""
import argparse
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import urllib.request
import zipfile

spec = importlib.util.spec_from_file_location("operator_deploy", Path(__file__).with_name("operator-improvements-deploy.py"))
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE = Path("/home/ubuntu/operatorapp-deploy-backups/order-line-storage-20260916-v3")
core.BASE_IMAGE = "sha256:e3cbbe3bda58be7694dcd666d9757fb671763656efcd322ea53e7a5111f82a6d"
core.IMAGE = "mbbs-operator-app:order-line-storage-20260916-v3"
core.ROLLBACK = "mbbs-operator-app:rollback-order-line-storage-20260916"
core.MIGRATION = "202_netsuite_order_line.sql"
artifact = core.SERVER / "test-artifacts/order-line-storage"
core.FILES = sorted(row["file"] for row in json.loads((artifact / "changes.json").read_text())
                    if row["file"].startswith(("src/", "migrations/")) or row["file"] in [
                        "netsuite-order-webhook-user-event-direct.js", "netsuite-order-webhook-scheduled.js", "tools/mbt-predeploy-readiness.mjs"])
tests = ["test/mbt/unit/netsuite-order-line.test.js", "test/mbt/unit/netsuite-order-line-sync.test.js",
         "test/mbt/unit/netsuite-order-line-backfill.test.js", "test/mbt/integration/netsuite-order-line-storage.test.js",
         "test/mbt/integration/netsuite-order-line-backfill.test.js", "test/mbt/integration/migration-upgrade.test.js",
         "test/mbt/integration/p3-predeploy-readiness.test.js"]


def source_gate():
    changes = json.loads((artifact / "changes.json").read_text())
    runtime = [row for row in changes if row["file"] in core.FILES]
    for row in runtime:
        assert hashlib.sha256((core.SERVER / row["file"]).read_bytes()).hexdigest() == row["afterSha256"], row["file"]
    before = {row["file"]: row["beforeSha256"] for row in runtime}
    # The previous overlay deployed migration 201 but omitted its inventory file.
    # This is the observed hash in the pinned base image, reviewed separately.
    before["tools/mbt-predeploy-readiness.mjs"] = "27a15863ec68137baba351ac810a8d7d6bcbffe5698de862c76f1e9ee04b3972"
    return before, {row["file"]: row["afterSha256"] for row in runtime}


def regression_gate():
    for filename in ["checks.json", "static.json"]:
        result = json.loads((artifact / filename).read_text())
        for file, digest in result["sources"].items():
            assert hashlib.sha256((core.SERVER / file).read_bytes()).hexdigest() == digest, f"Untested source: {file}"
    checks = json.loads((artifact / "checks.json").read_text())
    static = json.loads((artifact / "static.json").read_text())
    assert checks["mutationKills"] == checks["propertyMutationKills"] == 5
    assert static["newTypeErrors"] == static["newLint"] == 0
    baseline, final = [(artifact / name).read_text() for name in ["baseline-full.log", "full-final.log"]]
    for log in [baseline, final]:
        assert "Isolated MBT main run failed in 1/" in log
        assert re.findall(r"^✖ (.+?) \([0-9.]+ms\)$", log, re.M) == [
            "P3.12: browser specs share one worker-owned database-pool lifecycle",
            "P3.12: browser specs share one worker-owned database-pool lifecycle"]
    assert "# fail 0\n" in (artifact / "focused-final.log").read_text()


def prepare():
    os.umask(0o077)
    core.RELEASE.mkdir(parents=True, exist_ok=True, mode=0o700)
    assert not (core.RELEASE / "manifest.json").exists(), "Already prepared"
    expected_before, expected_after = source_gate()
    before = core.inspect(*core.SERVICES, *core.DEPENDENCIES)
    assert all(row["Image"] == core.BASE_IMAGE for row in before[:2])
    for service in core.SERVICES:
        assert core.hashes(service) == expected_before, service
    core.save("containers.before.private.json", before)
    core.run("docker", "tag", core.BASE_IMAGE, core.ROLLBACK)
    for image, name in [(core.IMAGE, "compose.release.yml"), (core.ROLLBACK, "compose.rollback.yml")]:
        (core.RELEASE / name).write_text(f"services:\n  app:\n    image: {image}\n  webhook-worker:\n    image: {image}\n")
    stage = core.RELEASE / "image"
    for file in core.FILES:
        target = stage / file
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(core.SERVER / file, target)
    (stage / "Dockerfile").write_text(f"FROM {core.ROLLBACK}\n" + "\n".join(f"COPY --chown=node:node {file} /app/{file}" for file in core.FILES) + "\n")
    with (core.RELEASE / "build.log").open("wb") as output:
        subprocess.run(["docker", "build", "--network", "none", "--pull=false", "-t", core.IMAGE, str(stage)],
                       stdout=output, stderr=subprocess.STDOUT, check=True)
    image_id = core.inspect(core.IMAGE)[0]["Id"]
    original, candidate_files = core.image_files(core.BASE_IMAGE), core.image_files(image_id)
    changed = sorted(file for file in original.keys() | candidate_files.keys() if original.get(file) != candidate_files.get(file))
    assert changed == core.FILES
    assert {file: candidate_files[file] for file in core.FILES} == expected_after
    baseline = artifact / "baseline"
    for file, digest in candidate_files.items():
        if file.startswith(("src/", "public/", "migrations/")) or file in ["package.json", "package-lock.json"]:
            expected = core.SERVER / file if file in core.FILES else baseline / file
            assert hashlib.sha256(expected.read_bytes()).hexdigest() == digest, f"Unexpected runtime: {file}"
    core.save("candidate-files.json", candidate_files)
    core.config_gate(before, core.compose(before, "compose.release.yml"), image_id)
    candidate = core.RELEASE / "candidate"
    if candidate.exists():
        shutil.rmtree(candidate)
    candidate.mkdir(exist_ok=True)
    temporary = core.run("docker", "create", "--entrypoint", "true", image_id).decode().strip()
    try:
        for folder in ["src", "public", "migrations"]:
            core.run("docker", "cp", f"{temporary}:/app/{folder}", str(candidate / folder))
    finally:
        core.run("docker", "rm", temporary)
    for folder in ["test", "tools", "contracts"]:
        shutil.copytree(baseline / folder, candidate / folder, dirs_exist_ok=True, ignore=shutil.ignore_patterns("__pycache__"))
    for file in baseline.iterdir():
        if file.is_file() and (file.suffix in [".json", ".js"] or file.name.startswith("Dockerfile")):
            shutil.copy2(file, candidate / file.name)
    for change in json.loads((artifact / "changes.json").read_text()):
        file = change["file"]
        if not file.startswith(("src/", "migrations/")):
            (candidate / file).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(core.SERVER / file, candidate / file)
    with (core.RELEASE / "candidate-tests.log").open("wb") as output:
        subprocess.run(["bash", str(core.SERVER / "tools/order-line-storage-test.sh"), "node", "--test", "--test-concurrency=1", *tests],
                       cwd=core.SERVER, env={**os.environ, "ORDER_LINE_SOURCE_ROOT": str(candidate)},
                       stdout=output, stderr=subprocess.STDOUT, check=True)
    core.candidate_smoke(image_id)
    env_hashes = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in [core.ROOT / "docker/env/.env", core.ROOT / "docker/env/.env.old"]}
    core.save("manifest.json", {"image": core.IMAGE, "imageId": image_id, "before": expected_before, "after": expected_after,
              "changedFiles": changed, "environmentHashes": env_hashes, "preparedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()})
    package = artifact / "netsuite-orderline-webhook.zip"
    with zipfile.ZipFile(package, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in ["netsuite-order-webhook-user-event-direct.js", "netsuite-order-webhook-scheduled.js"]:
            archive.write(core.SERVER / name, name)
        archive.write(core.SERVER / "test/order-line-storage-webhook-install.md", "INSTALL.md")
    print(json.dumps({"prepared": core.IMAGE, "imageId": image_id, "changedFiles": changed, "netSuitePackage": str(package)}), flush=True)


def migrate():
    inventory = core.node_read("""import {query,closeDb} from './src/db.js';try {
      console.log(JSON.stringify((await query('SELECT filename FROM schema_migrations')).rows.map(r=>r.filename)));
    } finally {await closeDb();}""")
    pending = sorted(p.name for p in (core.SERVER / "migrations").glob("*.sql") if p.name not in inventory)
    assert pending in [[], [core.MIGRATION]], pending
    if not pending:
        return
    for filename, options in [("schema-before.dump", ["--schema-only"]), ("mapping-tables-before.dump", [
            "--table=public.sales_order_lines", "--table=public.purchase_order_lines", "--table=public.transfer_order_lines", "--table=public.schema_migrations"])]:
        with (core.RELEASE / filename).open("wb") as output:
            subprocess.run(["docker", "exec", core.DEPENDENCIES[0], "sh", "-c",
                            'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom "$@"', "backup", *options],
                           stdout=output, stderr=subprocess.PIPE, check=True)
        with (core.RELEASE / filename).open("rb") as dump:
            toc = subprocess.check_output(["docker", "exec", "-i", core.DEPENDENCIES[0], "pg_restore", "--list"], stdin=dump)
        assert b"TABLE" in toc and b"schema_migrations" in toc
    sql = (core.SERVER / "migrations" / core.MIGRATION).read_text()
    applied = core.node_read("""import {query,withTransaction,closeDb} from './src/db.js';try {
      await withTransaction(async()=>{
        await query("SET LOCAL lock_timeout='5s'");await query("SET LOCAL statement_timeout='30s'");
        await query("SELECT pg_advisory_xact_lock(hashtext('order-line-storage-migration'))");
        const filename=FILENAME;
        if(!(await query('SELECT 1 FROM schema_migrations WHERE filename=$1',[filename])).rowCount){
          await query(SQL);await query('INSERT INTO schema_migrations(filename) VALUES($1)',[filename]);
        }console.log(JSON.stringify({applied:filename}));
      });} finally {await closeDb();}""".replace("FILENAME", json.dumps(core.MIGRATION)).replace("SQL", json.dumps(sql)))
    core.save("migration.json", applied)


def verify():
    result = core.node_read("""import assert from 'node:assert/strict';import {query,closeDb} from './src/db.js';
      try {const columns=(await query(`SELECT table_name,column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name IN ('sales_order_lines','purchase_order_lines','transfer_order_lines')
          AND column_name IN ('netsuite_order_line','netsuite_order_line_synced_at') ORDER BY table_name,column_name`)).rows;
        assert.equal(columns.length,6);console.log(JSON.stringify({columns}));} finally {await closeDb();}""")
    for origin in ["http://127.0.0.1:3000", "https://test.mbbsoperation.com"]:
        request = urllib.request.Request(origin + "/health", headers={"User-Agent": "Mozilla/5.0", "Cache-Control": "no-cache"})
        with urllib.request.urlopen(request, timeout=15) as response:
            assert response.status == 200 and json.load(response)["ok"] is True
    result["localAndPublicHealth"] = 200
    core.save("live-verification.json", result)
    return result


core.source_gate = source_gate
core.migrate_with_backup = migrate
core.live_verify = verify

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["prepare", "apply", "verify"])
    mode = parser.parse_args().mode
    if mode == "prepare":
        prepare()
    elif mode == "apply":
        regression_gate()
        core.cutover()
    else:
        print(json.dumps(verify()))
