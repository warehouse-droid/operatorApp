"""Deploy only the verified packed-group review guard over the current app image."""
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
core.RELEASE = core.ROOT / "backups/dispatch-packed-group-review-20260916"
core.BASE_IMAGE = "sha256:91582e969a5823a39862f086b2a8154b48926b595ef038a56f9a2993a1721372"
core.IMAGE = "mbbs-operator-app:dispatch-packed-group-review-20260916-v1"
core.ROLLBACK = "mbbs-operator-app:rollback-packed-group-review-20260916"
core.FILES = ["src/dispatch-plan-repository.js"]
core.SERVICES = ["mbbs-operator-app-app-1"]
core.DEPENDENCIES = ["mbbs-operator-app-webhook-worker-1", "mbbs-operator-app-db-1", "mbbs-operator-app-ollama-1"]
BEFORE = {"src/dispatch-plan-repository.js": "bd10da11523508a1caaeabd39894d58d91bda0c80c695a88cce77fb9c843f0fd"}
ARTIFACT = core.SERVER / "test-artifacts/packed-group-review"
compose_command = core.compose


def compose(before, override):
    command = compose_command(before, override)
    paths = before[0]["Config"]["Labels"]["com.docker.compose.project.config_files"].split(",")
    # Earlier releases have root-owned private Compose overrides. Read them
    # through sudo without broadening their permissions or printing secrets.
    return command if all(os.access(path, os.R_OK) for path in paths) else ["sudo", "-n", *command]


core.compose = compose


def source_hash():
    return hashlib.sha256((core.SERVER / "src/dispatch-plan-repository.js").read_bytes()).hexdigest()


def regression_gate():
    checks = json.loads((ARTIFACT / "checks.json").read_text())
    assert checks["sourceSha256"] == source_hash()
    assert len(checks["mutationKills"]) == 11 and checks["changedLineCoverage"] == 1
    for name in ["final-focused.log", "focused.log"]:
        log = (ARTIFACT / name).read_text()
        assert re.search(r"(?:#|ℹ) fail 0\b", log), name
        assert not re.search(r"^not ok |^✖ ", log, re.M), name
    for name in ["full-baseline.log", "full-final.log"]:
        assert "Isolated MBT main run failed in 1/505" in (ARTIFACT / name).read_text()
    for mode, before, after in [("compare", "full-baseline.log", "full-final.log"),
                                ("types", "types-baseline.log", "types-final.log")]:
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
    shutil.copy2(core.SERVER / "src/dispatch-plan-repository.js", stage / "src/dispatch-plan-repository.js")
    (stage / "Dockerfile").write_text(f"FROM {core.ROLLBACK}\nCOPY --chown=node:node src/dispatch-plan-repository.js /app/src/dispatch-plan-repository.js\n")
    with (core.RELEASE / "build.log").open("wb") as output:
        subprocess.run(["docker", "build", "--network", "none", "--pull=false", "-t", core.IMAGE, str(stage)],
                       stdout=output, stderr=subprocess.STDOUT, check=True)
    image_id = core.inspect(core.IMAGE)[0]["Id"]
    original, candidate = core.image_files(core.BASE_IMAGE), core.image_files(image_id)
    changed = sorted(file for file in original.keys() | candidate.keys() if original.get(file) != candidate.get(file))
    assert changed == core.FILES
    assert candidate["src/dispatch-plan-repository.js"] == source_hash()
    for file, digest in candidate.items():
        if file.startswith(("src/", "public/", "migrations/")) or file in ["package.json", "package-lock.json"]:
            assert hashlib.sha256((core.SERVER / file).read_bytes()).hexdigest() == digest, f"Candidate differs from tested source: {file}"
    core.save("candidate-files.json", candidate)
    core.config_gate(before[:1], core.compose(before, "compose.release.yml"), image_id)
    core.candidate_smoke(image_id)
    preview = json.loads(core.run("docker", "run", "--rm", "--network", "mbbs-operator-app_mbbs",
        "--volumes-from", core.SERVICES[0] + ":ro", "-v",
        f"{core.SERVER / 'tools/refresh-dispatch-packed-group-reviews.mjs'}:/app/tools/refresh-dispatch-packed-group-reviews.mjs:ro",
        "--entrypoint", "node", image_id, "tools/refresh-dispatch-packed-group-reviews.mjs"))
    core.save("cache-preview.json", preview)
    assert {"GOA-8601-8604", "GOB-120487-120489"}.issubset({row["groupRef"] for row in preview["cleared"]})
    manifest = {"image": core.IMAGE, "imageId": image_id, "before": BEFORE,
                "after": {"src/dispatch-plan-repository.js": source_hash()}, "changedFiles": changed, "rollbackImage": core.ROLLBACK}
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
    replay = core.node_read("""import {query,withTransaction,closeDb} from './src/db.js';
      import {getDispatchPlan} from './src/dispatch-plan-repository.js';
      try {await withTransaction(async()=>{await query('SET TRANSACTION READ ONLY');
        const groups=(await query(`SELECT group_ref,source_plan_id FROM dispatch_global_order_groups
          WHERE group_ref=ANY($1::text[])`,[['GOA-8601-8604','GOB-120487-120489']])).rows;
        const result=[];
        for(const group of groups){const plan=await getDispatchPlan(group.source_plan_id);
          const order=plan.orders.find(row=>row.id===group.group_ref);
          result.push({groupRef:group.group_ref,status:order.reconciliationApplicationStatus,blocked:order.reconciliationBlocked});}
        console.log(JSON.stringify(result));});}finally{await closeDb();}""")
    assert len(replay) == 2 and all(row["blocked"] is False and row["status"] == "Queued" for row in replay)
    return {"image": core.IMAGE, "health": core.health(), "workerAndDependenciesUnchanged": True, "replay": replay}


def apply():
    regression_gate()
    manifest = json.loads((core.RELEASE / "manifest.json").read_text())
    before = json.loads((core.RELEASE / "containers.before.private.json").read_text())
    assert manifest["after"] == {"src/dispatch-plan-repository.js": source_hash()}
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
        backup = core.node_read("""import {query,closeDb} from './src/db.js';
          try{console.log(JSON.stringify((await query(`SELECT * FROM dispatch_global_order_groups
            WHERE active AND order_type='SO' AND full_order->>'reconciliationStatus'='review'`)).rows));}
          finally{await closeDb();}""")
        core.save("group-cache.before.private.json", backup)
        refresh = json.loads(core.run("docker", "run", "--rm", "--network", "mbbs-operator-app_mbbs",
            "--volumes-from", core.SERVICES[0] + ":ro", "-v",
            f"{core.SERVER / 'tools/refresh-dispatch-packed-group-reviews.mjs'}:/app/tools/refresh-dispatch-packed-group-reviews.mjs:ro",
            "--entrypoint", "node", manifest["imageId"], "tools/refresh-dispatch-packed-group-reviews.mjs", "--apply"))
        core.save("cache-refresh.json", refresh)
        result["cacheRefresh"] = refresh
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
