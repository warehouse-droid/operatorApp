"""Deploy only the verified Dispatch save reliability overlay after source-bound gates pass."""
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

spec = importlib.util.spec_from_file_location("release_helpers", Path(__file__).with_name("operator-improvements-deploy.py"))
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE = core.ROOT / "backups/dispatch-save-reliability-20260917-r5"
core.BASE_IMAGE = "sha256:a16f2d23f98c0584b710449cdaf1847e06147b8f55aa946a024d88b5a9918edd"
core.IMAGE = "mbbs-operator-app:dispatch-save-reliability-20260917-v5"
core.ROLLBACK = "mbbs-operator-app:rollback-dispatch-save-20260917"
ARTIFACT = core.SERVER / "test-artifacts/dispatch-save-reliability"
core.FILES = sorted(json.loads((ARTIFACT / "checks-sources.json").read_text())["sources"])
core.SERVICES = ["mbbs-operator-app-app-1"]
core.DEPENDENCIES = ["mbbs-operator-app-webhook-worker-1", "mbbs-operator-app-db-1", "mbbs-operator-app-ollama-1"]
BEFORE = {file: hashlib.sha256((ARTIFACT / "baseline" / file).read_bytes()).hexdigest()
          if (ARTIFACT / "baseline" / file).exists() else None for file in core.FILES}
compose_command = core.compose


def compose(before, override):
    command = compose_command(before, override)
    paths = before[0]["Config"]["Labels"]["com.docker.compose.project.config_files"].split(",")
    # Earlier releases have root-owned private Compose overrides. Read them
    # through sudo without broadening their permissions or printing secrets.
    return command if all(os.access(path, os.R_OK) for path in paths) else ["sudo", "-n", *command]


core.compose = compose


def source_hashes():
    return {file: hashlib.sha256((core.SERVER / file).read_bytes()).hexdigest() for file in core.FILES}


def regression_gate():
    subprocess.run(["python3", str(core.SERVER / "tools/dispatch-save-evidence.py"), "--check"], check=True)


# Explicit disposable subnet avoids collisions with the host's many existing
# isolated test networks; it does not join the production network.
original_run = core.run

def run(*args, **kwargs):
    if args[:4] == ("docker", "network", "create", "--internal"):
        import secrets
        block = secrets.randbelow(8192) * 8
        args = (*args[:4], "--subnet", f"10.246.{block // 256}.{block % 256}/29", *args[4:])
    return original_run(*args, **kwargs)


core.run = run


def prepare():
    core.RELEASE.mkdir(parents=True, exist_ok=True, mode=0o700)
    assert not (core.RELEASE / "manifest.json").exists(), "Release already prepared"
    before = core.inspect(*core.SERVICES, *core.DEPENDENCIES)
    assert before[0]["Image"] == core.BASE_IMAGE, "Live app image changed"
    assert core.hashes(core.SERVICES[0]) == BEFORE, "Live server changed"
    core.save("containers.before.private.json", before)
    core.run("docker", "tag", core.BASE_IMAGE, core.ROLLBACK)
    for image, name in [(core.IMAGE, "compose.release.yml"), (core.ROLLBACK, "compose.rollback.yml")]:
        (core.RELEASE / name).write_text(f"services:\n  app:\n    image: {image}\n")
    stage = core.RELEASE / "image"
    for file in core.FILES:
        target = stage / file
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(core.SERVER / file, target)
    (stage / "Dockerfile").write_text(f"FROM {core.ROLLBACK}\n" + "".join(
        f"COPY --chown=node:node {file} /app/{file}\n" for file in core.FILES))
    with (core.RELEASE / "build.log").open("wb") as output:
        subprocess.run(["docker", "build", "--network", "none", "--pull=false", "-t", core.IMAGE, str(stage)],
                       stdout=output, stderr=subprocess.STDOUT, check=True)
    image_id = core.inspect(core.IMAGE)[0]["Id"]
    original, candidate = core.image_files(core.BASE_IMAGE), core.image_files(image_id)
    changed = sorted(file for file in original.keys() | candidate.keys() if original.get(file) != candidate.get(file))
    assert changed == core.FILES
    assert {file: candidate[file] for file in core.FILES} == source_hashes()
    for file, digest in candidate.items():
        if file.startswith(("src/", "public/", "migrations/")) or file in ["package.json", "package-lock.json"]:
            assert hashlib.sha256((core.SERVER / file).read_bytes()).hexdigest() == digest, f"Candidate differs from tested source: {file}"
    core.save("candidate-files.json", candidate)
    core.config_gate(before[:1], core.compose(before, "compose.release.yml"), image_id)
    core.candidate_smoke(image_id)
    manifest = {"image": core.IMAGE, "imageId": image_id, "before": BEFORE,
                "after": source_hashes(), "changedFiles": changed, "rollbackImage": core.ROLLBACK}
    core.save("manifest.json", manifest)
    print(json.dumps({"prepared": core.IMAGE, "imageId": image_id, "changedFiles": changed}), flush=True)


def verify():
    before = json.loads((core.RELEASE / "containers.before.private.json").read_text())
    manifest = json.loads((core.RELEASE / "manifest.json").read_text())
    after = core.inspect(*core.SERVICES, *core.DEPENDENCIES)
    prior, current = before[0], after[0]
    assert current["Image"] == manifest["imageId"] and current["State"]["Running"] and current["RestartCount"] == 0
    assert sorted(prior["Config"]["Env"]) == sorted(current["Config"]["Env"])
    assert sorted(prior["Mounts"], key=lambda row: row["Destination"]) == sorted(current["Mounts"], key=lambda row: row["Destination"])
    for field in ["Cmd", "Entrypoint", "User", "WorkingDir"]:
        assert prior["Config"][field] == current["Config"][field]
    assert prior["HostConfig"]["PortBindings"] == current["HostConfig"]["PortBindings"]
    assert core.hashes(core.SERVICES[0]) == manifest["after"]
    assert [(row["Id"], row["State"]["StartedAt"]) for row in before[1:]] == [(row["Id"], row["State"]["StartedAt"]) for row in after[1:]]
    for file in core.FILES:
        if file.startswith("public/"):
            with urllib.request.urlopen("http://127.0.0.1:3000/" + file.removeprefix("public/"), timeout=10) as response:
                assert response.status == 200
                assert hashlib.sha256(response.read()).hexdigest() == manifest["after"][file], f"Served asset differs: {file}"
    # Only SELECTs, held in a repeatable-read read-only transaction.
    script = (core.SERVER / "tools/dispatch-save-live.mjs").read_text()
    live = core.node_read(script)
    assert live["readOnly"] and live["fenceMismatches"] == []
    return {"image": core.IMAGE, "health": core.health(), "workerAndDependenciesUnchanged": True, "live": live}



def preflight():
    return core.node_read("""import {query,withTransaction,closeDb} from './src/db.js';
      try {const result=await withTransaction(async()=>{await query('SET TRANSACTION READ ONLY');return (await query(
        `SELECT (SELECT count(*)::int FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing')) AS postings,
          (SELECT count(*)::int FROM dispatch_plan_edit_leases WHERE expires_at>clock_timestamp()) AS editors`)).rows[0];});
        console.log(JSON.stringify(result));} finally {await closeDb();}""")


def apply():
    regression_gate()
    manifest = json.loads((core.RELEASE / "manifest.json").read_text())
    before = json.loads((core.RELEASE / "containers.before.private.json").read_text())
    assert manifest["after"] == source_hashes()
    assert [row["Id"] for row in core.inspect(*core.SERVICES, *core.DEPENDENCIES)] == [row["Id"] for row in before]
    assert core.hashes(core.SERVICES[0]) == BEFORE
    core.config_gate(before[:1], core.compose(before, "compose.release.yml"), manifest["imageId"])
    active = preflight()
    assert active["postings"] == 0 and active["editors"] == 0, "An active posting or Dispatch editor is present; retry cutover when idle"
    command = ["up", "-d", "--no-deps", "--no-build", "--pull", "never", "app"]
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    try:
        with (core.RELEASE / "cutover.log").open("wb") as output:
            subprocess.run(core.compose(before, "compose.release.yml") + command, cwd=core.ROOT,
                           stdout=output, stderr=subprocess.STDOUT, check=True, timeout=120)
        core.wait_ready(manifest["imageId"])
        result = verify()
        core.save("result.json", {"deployed": True, "at": started, **result})
        print(json.dumps({"deployed": True, **result}), flush=True)
    except Exception:
        with (core.RELEASE / "rollback.log").open("wb") as output:
            subprocess.run(core.compose(before, "compose.rollback.yml") + command, cwd=core.ROOT,
                           stdout=output, stderr=subprocess.STDOUT, check=True, timeout=120)
        core.wait_ready(core.BASE_IMAGE)
        raise


if __name__ == "__main__":
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["prepare", "apply", "verify", "check", "preflight"])
    mode = parser.parse_args().mode
    if mode == "preflight":
        print(json.dumps(preflight()))
    elif mode == "check":
        regression_gate()
    elif mode == "prepare":
        prepare()
    elif mode == "apply":
        apply()
    else:
        print(json.dumps(verify()))
