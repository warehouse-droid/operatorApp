"""Release the verified untouched-SO-line guard over the current live image."""
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
core.RELEASE = core.ROOT / "backups/scm-to-untouched-lines-20260916"
core.BASE_IMAGE = "sha256:8347c79f964bcc84e601d53031c402004af557290a61b5a9802171fd5dfac93b"
core.IMAGE = "mbbs-operator-app:scm-to-untouched-lines-20260916-v1"
core.ROLLBACK = "mbbs-operator-app:rollback-scm-to-untouched-lines-20260916"
core.FILES = ["src/scm-dependency-preview-service.js"]
core.SERVICES = ["mbbs-operator-app-app-1"]
core.DEPENDENCIES = ["mbbs-operator-app-webhook-worker-1", "mbbs-operator-app-db-1", "mbbs-operator-app-ollama-1"]
ARTIFACT = core.SERVER / "test-artifacts/scm-to-untouched-lines"


def source_hash():
    return hashlib.sha256((core.SERVER / core.FILES[0]).read_bytes()).hexdigest()


def gate(*, full=True):
    result = json.loads((ARTIFACT / "checks.json").read_text())
    assert result["sourceSha256"] == source_hash()
    assert len(result["mutationKills"]) == 11
    assert result["changedLineCoverage"]["missing"] == []
    assert result["changedLineCoverage"]["executed"] == result["changedLineCoverage"]["total"] > 0
    assert re.search(r"# fail 0\b", (ARTIFACT / "final-focused.log").read_text())
    if not full:
        return result
    for mode, before, after in [("compare", "full-baseline.log", "full-final.log"),
                                ("types", "types-baseline.log", "types-final.log")]:
        subprocess.run(["python3", str(core.SERVER / "tools/dispatch-retired-confirm-evidence.py"),
                        mode, str(ARTIFACT / before), str(ARTIFACT / after)], check=True)
    for name in ["full-baseline.log", "full-final.log"]:
        assert "Isolated MBT main run failed in 1/505" in (ARTIFACT / name).read_text(), "Incomplete or changed regression run"
    return result


def live(image):
    output = core.run("docker", "run", "--rm", "--network", "mbbs-operator-app_mbbs",
        "--volumes-from", core.SERVICES[0] + ":ro", "-v",
        f"{core.SERVER / 'tools/scm-to-untouched-lines-live.mjs'}:/app/tools/scm-to-untouched-lines-live.mjs:ro",
        "--entrypoint", "node", image, "tools/scm-to-untouched-lines-live.mjs", "--expect-allowed")
    return json.loads(output)


def prepare():
    gate(full=False)
    core.RELEASE.mkdir(parents=True, exist_ok=True, mode=0o700)
    assert not (core.RELEASE / "manifest.json").exists(), "Release already prepared"
    before = core.inspect(*core.SERVICES, *core.DEPENDENCIES)
    assert before[0]["Image"] == core.BASE_IMAGE, "Live app image changed"
    baseline = hashlib.sha256((ARTIFACT / "baseline/scm-dependency-preview-service.js").read_bytes()).hexdigest()
    assert core.hashes(core.SERVICES[0]) == {core.FILES[0]: baseline}
    core.save("containers.before.private.json", before)
    core.run("docker", "tag", core.BASE_IMAGE, core.ROLLBACK)
    for image, name in [(core.IMAGE, "compose.release.yml"), (core.ROLLBACK, "compose.rollback.yml")]:
        (core.RELEASE / name).write_text(f"services:\n  app:\n    image: {image}\n")
    stage = core.RELEASE / "image"
    (stage / "src").mkdir(parents=True, exist_ok=True)
    shutil.copy2(core.SERVER / core.FILES[0], stage / core.FILES[0])
    (stage / "Dockerfile").write_text(f"FROM {core.ROLLBACK}\nCOPY --chown=node:node {core.FILES[0]} /app/{core.FILES[0]}\n")
    with (core.RELEASE / "build.log").open("wb") as output:
        subprocess.run(["docker", "build", "--network", "none", "--pull=false", "-t", core.IMAGE, str(stage)],
                       stdout=output, stderr=subprocess.STDOUT, check=True)
    image_id = core.inspect(core.IMAGE)[0]["Id"]
    original, candidate = core.image_files(core.BASE_IMAGE), core.image_files(image_id)
    changed = sorted(file for file in original.keys() | candidate.keys() if original.get(file) != candidate.get(file))
    assert changed == core.FILES
    for file, digest in candidate.items():
        if file.startswith(("src/", "public/", "migrations/")) or file in ["package.json", "package-lock.json"]:
            assert hashlib.sha256((core.SERVER / file).read_bytes()).hexdigest() == digest, f"Untested source: {file}"
    core.config_gate(before[:1], core.compose(before, "compose.release.yml"), image_id)
    core.candidate_smoke(image_id)
    replay = live(image_id)
    core.save("candidate-live-preview.json", replay)
    core.save("manifest.json", {"image": core.IMAGE, "imageId": image_id,
              "before": {core.FILES[0]: baseline}, "after": {core.FILES[0]: source_hash()},
              "changedFiles": changed, "rollbackImage": core.ROLLBACK})
    print(json.dumps({"prepared": core.IMAGE, "imageId": image_id, "changedFiles": changed, "preview": replay}), flush=True)


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
    script = (core.SERVER / "tools/scm-to-untouched-lines-live.mjs").read_text().replace('"../src/', '"./src/')
    replay = core.node_read('process.argv.push("--expect-allowed");\n' + script)
    return {"image": core.IMAGE, "health": core.health(), "workerAndDependenciesUnchanged": True, "preview": replay}


def apply():
    gate()
    manifest = json.loads((core.RELEASE / "manifest.json").read_text())
    before = json.loads((core.RELEASE / "containers.before.private.json").read_text())
    assert manifest["after"] == {core.FILES[0]: source_hash()}
    assert [row["Id"] for row in core.inspect(*core.SERVICES, *core.DEPENDENCIES)] == [row["Id"] for row in before]
    assert core.hashes(core.SERVICES[0]) == manifest["before"]
    core.config_gate(before[:1], core.compose(before, "compose.release.yml"), manifest["imageId"])
    active = core.node_read("""import {query,closeDb} from './src/db.js';try {console.log(JSON.stringify((await query(
      `SELECT count(*)::int AS postings FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing')`)).rows[0]));}
      finally {await closeDb();}""")
    assert active["postings"] == 0, "Posting work is active; retry when idle"
    command = ["up", "-d", "--no-deps", "--no-build", "--pull", "never", "app"]
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    try:
        with (core.RELEASE / "cutover.log").open("wb") as output:
            subprocess.run(core.compose(before, "compose.release.yml") + command, cwd=core.ROOT,
                           stdout=output, stderr=subprocess.STDOUT, check=True, timeout=120)
        core.wait_ready(manifest["imageId"])
        result = verify()
        logs = core.run("docker", "logs", "--since", started, core.SERVICES[0], stderr=subprocess.STDOUT).decode()
        (core.RELEASE / "startup.log").write_text(logs)
        assert not re.search(r"SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND|uncaughtException", logs)
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
        gate()
    elif mode == "prepare":
        prepare()
    elif mode == "apply":
        apply()
    else:
        print(json.dumps(verify()))
