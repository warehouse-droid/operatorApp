"""Release CO direct TO cargo reconciliation and Packed visibility."""
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
core.RELEASE = Path("/home/ubuntu/operatorapp-deploy-backups/co-direct-to-20260917")
core.BASE_IMAGE = "sha256:2c3580e507b7474dd5e075f76d173bf94439b840fd300f709d6a3850db10292a"
core.IMAGE = "mbbs-operator-app:co-direct-to-20260917-v1"
core.ROLLBACK = "mbbs-operator-app:rollback-co-direct-to-20260917"
core.FILES = sorted(["src/co-direct-to-cargo.js", "src/dispatch-local-co-cargo.js", "src/dispatch-repository.js",
                     "src/delivery-repository.js", "src/scm-dependency-command-service.js"])
core.SERVICES = ["mbbs-operator-app-app-1"]
core.DEPENDENCIES = ["mbbs-operator-app-webhook-worker-1", "mbbs-operator-app-db-1", "mbbs-operator-app-ollama-1"]
ARTIFACT = core.SERVER / "test-artifacts/co-direct-to"


def source_hashes():
    return {file: hashlib.sha256((core.SERVER / file).read_bytes()).hexdigest() for file in core.FILES}


def gate(*, full=True):
    result = json.loads((ARTIFACT / "checks.json").read_text())
    assert result["sourceHashes"] == source_hashes()
    assert len(result["mutationKills"]) == 9
    for coverage in result["changedLineCoverage"].values():
        assert coverage["missing"] == []
        assert coverage["executed"] == coverage["total"] > 0
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
        f"{core.SERVER / 'tools/direct-to-same-yard-live.mjs'}:/app/tools/direct-to-same-yard-live.mjs:ro",
        "-v", f"{core.SERVER / 'test/support'}:/app/test/support:ro",
        "--entrypoint", "node", image, "tools/direct-to-same-yard-live.mjs")
    return json.loads(output)


def packing(image, mode):
    output = core.run("docker", "run", "--rm", "--user", "0:0", "--network", "mbbs-operator-app_mbbs",
        "--volumes-from", core.SERVICES[0] + ":ro", "-v",
        f"{core.SERVER / 'tools/co-direct-to-live.mjs'}:/app/tools/co-direct-to-live.mjs:ro",
        "-v", f"{core.SERVER / 'test/support'}:/app/test/support:ro",
        "-v", f"{core.RELEASE}:/release", "--entrypoint", "node", image,
        "tools/co-direct-to-live.mjs", mode, "/release/repair.private.json")
    return json.loads(output)


def prepare():
    gate(full=False)
    core.RELEASE.mkdir(parents=True, exist_ok=True, mode=0o700)
    assert not (core.RELEASE / "manifest.json").exists(), "Release already prepared"
    before = core.inspect(*core.SERVICES, *core.DEPENDENCIES)
    assert before[0]["Image"] == core.BASE_IMAGE, "Live app image changed"
    baseline = {file: hashlib.sha256((ARTIFACT / "baseline" / file).read_bytes()).hexdigest()
                if (ARTIFACT / "baseline" / file).exists() else None for file in core.FILES}
    assert core.hashes(core.SERVICES[0]) == baseline
    core.save("containers.before.private.json", before)
    core.run("docker", "tag", core.BASE_IMAGE, core.ROLLBACK)
    for image, name in [(core.IMAGE, "compose.release.yml"), (core.ROLLBACK, "compose.rollback.yml")]:
        (core.RELEASE / name).write_text(f"services:\n  app:\n    image: {image}\n")
    stage = core.RELEASE / "image"
    for file in core.FILES:
        destination = stage / file
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(core.SERVER / file, destination)
    (stage / "Dockerfile").write_text(f"FROM {core.ROLLBACK}\n" + "".join(
        f"COPY --chown=node:node {file} /app/{file}\n" for file in core.FILES))
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
    rehearsal = packing(image_id, "preview")
    core.save("packing-rehearsal.json", rehearsal)
    core.save("manifest.json", {"image": core.IMAGE, "imageId": image_id,
              "before": baseline, "after": source_hashes(),
              "changedFiles": changed, "rollbackImage": core.ROLLBACK})
    print(json.dumps({"prepared": core.IMAGE, "imageId": image_id, "changedFiles": changed, "preview": replay, "packingRehearsal": rehearsal}), flush=True)


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
    replay = live(manifest["imageId"])
    return {"image": core.IMAGE, "health": core.health(), "workerAndDependenciesUnchanged": True, "preview": replay}


def apply():
    gate()
    manifest = json.loads((core.RELEASE / "manifest.json").read_text())
    before = json.loads((core.RELEASE / "containers.before.private.json").read_text())
    assert manifest["after"] == source_hashes()
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
    parser.add_argument("mode", choices=["prepare", "apply", "verify", "check", "repair", "verify-repair"])
    mode = parser.parse_args().mode
    if mode == "check":
        gate()
    elif mode == "prepare":
        prepare()
    elif mode == "apply":
        apply()
    elif mode in ["repair", "verify-repair"]:
        gate()
        manifest = json.loads((core.RELEASE / "manifest.json").read_text())
        assert core.inspect(core.SERVICES[0])[0]["Image"] == manifest["imageId"]
        if mode == "repair":
            preview = packing(manifest["imageId"], "preview")
            core.save("packing-preview.json", preview)
            applied = packing(manifest["imageId"], "apply")
            core.save("packing-applied.json", applied)
        result = packing(manifest["imageId"], "verify")
        core.save("packing-verified.json", result)
        print(json.dumps(result), flush=True)
    else:
        print(json.dumps(verify()))
