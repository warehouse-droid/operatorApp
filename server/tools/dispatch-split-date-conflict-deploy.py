"""Deploy only the verified split-date save guard over the current app image."""
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

spec = importlib.util.spec_from_file_location("release_helpers", Path(__file__).with_name("operator-improvements-deploy.py"))
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE = core.ROOT / "backups/dispatch-split-date-conflict-20260916"
core.BASE_IMAGE = "sha256:fa730d5b7614fad1efd126d3ceb32606919c5d3b74e915aa8aace9479544891e"
core.IMAGE = "mbbs-operator-app:dispatch-split-date-conflict-20260916-v1"
core.ROLLBACK = "mbbs-operator-app:rollback-split-date-conflict-20260916"
core.FILES = ["src/server.js"]
core.SERVICES = ["mbbs-operator-app-app-1"]
core.DEPENDENCIES = ["mbbs-operator-app-webhook-worker-1", "mbbs-operator-app-db-1", "mbbs-operator-app-ollama-1"]
BEFORE = {"src/server.js": "b358d80f27da9c6ebab33e14b9d54a297f40219adf50d089aed91fadb5fc6d8e"}
ARTIFACT = core.SERVER / "test-artifacts/split-date-conflict"
compose_command = core.compose


def compose(before, override):
    command = compose_command(before, override)
    paths = before[0]["Config"]["Labels"]["com.docker.compose.project.config_files"].split(",")
    # Earlier releases have root-owned private Compose overrides. Read them
    # through sudo without broadening their permissions or printing secrets.
    return command if all(os.access(path, os.R_OK) for path in paths) else ["sudo", "-n", *command]


core.compose = compose


def source_hash():
    return hashlib.sha256((core.SERVER / "src/server.js").read_bytes()).hexdigest()


def regression_gate():
    checks = json.loads((ARTIFACT / "checks.json").read_text())
    assert checks["sourceSha256"] == source_hash()
    assert checks["mutationKills"] == checks["propertyMutationKills"] == 5
    assert checks["changedLineCoverage"] == 1
    subprocess.run(["sha256sum", "--check", str(ARTIFACT / "final-source.sha256")], cwd=core.ROOT, check=True)
    for name in ["final-focused.log", "adjacent.log"]:
        log = (ARTIFACT / name).read_text()
        assert re.search(r"(?:#|ℹ) fail 0\b", log), name
        assert not re.search(r"^not ok |^✖ ", log, re.M), name
    logs = [(ARTIFACT / name).read_text() for name in ["full-baseline.log", "full-final.log"]]
    for log in logs:
        assert "Isolated MBT main run failed in 1/505" in log, "Full suite not complete or unexpected failure count"
        assert re.findall(r"^✖ (.+?) \([0-9.]+ms\)$", log, re.M) == [
            "P3.12: browser specs share one worker-owned database-pool lifecycle"] * 2
    for mode, before, after in [("compare", "full-baseline.log", "full-final.log"),
                                ("types", "types-baseline.log", "types-final.log"),
                                ("lint", "lint-baseline.log", "lint-final.log")]:
        subprocess.run(["python3", str(core.SERVER / "tools/dispatch-retired-confirm-evidence.py"),
                        mode, str(ARTIFACT / before), str(ARTIFACT / after)], check=True)


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
    (stage / "src").mkdir(parents=True, exist_ok=True)
    shutil.copy2(core.SERVER / "src/server.js", stage / "src/server.js")
    (stage / "Dockerfile").write_text(f"FROM {core.ROLLBACK}\nCOPY --chown=node:node src/server.js /app/src/server.js\n")
    with (core.RELEASE / "build.log").open("wb") as output:
        subprocess.run(["docker", "build", "--network", "none", "--pull=false", "-t", core.IMAGE, str(stage)],
                       stdout=output, stderr=subprocess.STDOUT, check=True)
    image_id = core.inspect(core.IMAGE)[0]["Id"]
    original, candidate = core.image_files(core.BASE_IMAGE), core.image_files(image_id)
    changed = sorted(file for file in original.keys() | candidate.keys() if original.get(file) != candidate.get(file))
    assert changed == core.FILES
    assert candidate["src/server.js"] == source_hash()
    for file, digest in candidate.items():
        if file.startswith(("src/", "public/", "migrations/")) or file in ["package.json", "package-lock.json"]:
            assert hashlib.sha256((core.SERVER / file).read_bytes()).hexdigest() == digest, f"Candidate differs from tested source: {file}"
    core.save("candidate-files.json", candidate)
    core.config_gate(before[:1], core.compose(before, "compose.release.yml"), image_id)
    core.candidate_smoke(image_id)
    manifest = {"image": core.IMAGE, "imageId": image_id, "before": BEFORE,
                "after": {"src/server.js": source_hash()}, "changedFiles": changed, "rollbackImage": core.ROLLBACK}
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
    command = ["docker", "run", "--rm", "--network", "mbbs-operator-app_mbbs", "--volumes-from", core.SERVICES[0] + ":ro"]
    for file in ["tools/replay-dispatch-split-date-conflict.mjs", "test/support/dispatch-split-date-conflict-harness.mjs"]:
        command += ["-v", f"{core.SERVER / file}:/app/{file}:ro"]
    command += ["--entrypoint", "node", manifest["imageId"], "tools/replay-dispatch-split-date-conflict.mjs"]
    replay = json.loads(core.run(*command))
    assert replay["snapshotUnchanged"] and replay["readOnly"] and replay["conflicts"] == []
    return {"image": core.IMAGE, "health": core.health(), "workerAndDependenciesUnchanged": True, "replay": replay}


def apply():
    regression_gate()
    manifest = json.loads((core.RELEASE / "manifest.json").read_text())
    before = json.loads((core.RELEASE / "containers.before.private.json").read_text())
    assert manifest["after"] == {"src/server.js": source_hash()}
    assert [row["Id"] for row in core.inspect(*core.SERVICES, *core.DEPENDENCIES)] == [row["Id"] for row in before]
    assert core.hashes(core.SERVICES[0]) == BEFORE
    core.config_gate(before[:1], core.compose(before, "compose.release.yml"), manifest["imageId"])
    active = core.node_read("""import {query,closeDb} from './src/db.js';try {console.log(JSON.stringify((await query(
      `SELECT count(*)::int AS postings FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing')`)).rows[0]));}
      finally {await closeDb();}""")
    assert active["postings"] == 0, "Posting work is active; retry cutover when idle"
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
    parser.add_argument("mode", choices=["prepare", "apply", "verify", "check"])
    mode = parser.parse_args().mode
    if mode == "check":
        regression_gate()
    elif mode == "prepare":
        prepare()
    elif mode == "apply":
        apply()
    else:
        print(json.dumps(verify()))
