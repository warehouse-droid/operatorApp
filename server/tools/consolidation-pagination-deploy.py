"""Deploy verified Operator file overlays with health checks and image rollback."""
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
import time
import urllib.error
import urllib.request

HELPER = Path(__file__).with_name("operator-improvements-deploy.py")
SPEC = importlib.util.spec_from_file_location("operator_deploy", HELPER)
core = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(core)
core.RELEASE = Path("/home/ubuntu/operatorapp-deploy-backups/consolidation-pagination-20260916")
core.BASE_IMAGE = "sha256:0ce822ac692745f914776588ecd77f58f5798cbe9047e9dc1b2694f4ad1102fb"
core.IMAGE = "mbbs-operator-app:consolidation-pagination-20260916-v1"
core.ROLLBACK = "mbbs-operator-app:rollback-consolidation-pagination-20260916"
core.SERVICES = ["mbbs-operator-app-app-1"]
core.DEPENDENCIES = ["mbbs-operator-app-webhook-worker-1", "mbbs-operator-app-db-1", "mbbs-operator-app-ollama-1"]
core.FILES = sorted(["public/operator.js", "public/operator.css", "public/operator.html", "public/service-worker.js", "public/i18n.js"])
VERSION = "20260916-consolidation-pagination-v1"
BASE_WORKER_IMAGE = core.BASE_IMAGE
SOURCE_MANIFEST = core.SERVER / "test-artifacts/consolidation-pagination/changes.json"
UNIT_TESTS = [f"test/mbt/unit/{name}.test.js" for name in ["operator-yard-assets", "operator-customer-pickup-photo-gate-ui.contract",
    "operator-page-confirm-ui.contract", "operations-navigation-enhancements", "operator-posting-photo-client", "operator-receiving-return"]]
BROWSER_TESTS = ["test/dispatch/frontend/consolidation-load.browser.test.mjs"]
EXPECTED_UNIT_PASSES = 21
EXPECTED_BROWSER_PASSES = 7
UPDATE_WORKER = False
WORKER_ROLLBACK = ""
VERIFY_WORKSPACE_RUNTIME = False


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def source_gate():
    rows = json.loads(SOURCE_MANIFEST.read_text())
    for row in rows:
        assert hashlib.sha256((core.SERVER / row["file"]).read_bytes()).hexdigest() == row["afterSha256"], row["file"]
    runtime = [row for row in rows if row["file"].startswith(("public/", "src/"))]
    assert sorted(row["file"] for row in runtime) == core.FILES
    return ({row["file"]: row["beforeSha256"] for row in runtime}, {row["file"]: row["afterSha256"] for row in runtime})


def logged(name, command):
    with (core.RELEASE / name).open("wb") as output:
        subprocess.run(command, cwd=core.ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=180)


def prepare():
    os.umask(0o077)
    core.RELEASE.mkdir(mode=0o700, parents=True, exist_ok=True)
    assert not (core.RELEASE / "manifest.json").exists(), "Release already prepared"
    expected_before, expected_after = source_gate()
    before = core.inspect(*core.SERVICES, *core.DEPENDENCIES)
    assert before[0]["Image"] == core.BASE_IMAGE
    assert before[1]["Image"] == BASE_WORKER_IMAGE
    assert core.hashes(core.SERVICES[0]) == expected_before, "Live assets changed"
    if UPDATE_WORKER:
        worker_before = core.hashes(core.SERVICES[1])
        assert all(worker_before[file] == digest for file, digest in expected_before.items() if file.startswith("src/"))
        core.save("worker-files.before.json", worker_before)
    core.health()
    core.save("containers.before.private.json", before)
    for image, name in [(core.IMAGE, "compose.release.yml"), (core.ROLLBACK, "compose.rollback.yml")]:
        contents = f"services:\n  app:\n    image: {image}\n"
        if UPDATE_WORKER:
            worker_image = core.IMAGE if name == "compose.release.yml" else WORKER_ROLLBACK
            contents += f"  webhook-worker:\n    image: {worker_image}\n"
        (core.RELEASE / name).write_text(contents)
    stage = core.RELEASE / "image"
    for file in core.FILES:
        destination = stage / file
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(core.SERVER / file, destination)
    core.run("docker", "tag", core.BASE_IMAGE, core.ROLLBACK)
    if UPDATE_WORKER:
        core.run("docker", "tag", BASE_WORKER_IMAGE, WORKER_ROLLBACK)
    (stage / "Dockerfile").write_text(f"FROM {core.ROLLBACK}\n" + "\n".join(f"COPY --chown=node:node {file} /app/{file}" for file in core.FILES) + "\n")
    logged("build.log", ["docker", "build", "--network", "none", "--pull=false", "-t", core.IMAGE, str(stage)])
    image_id = core.inspect(core.IMAGE)[0]["Id"]
    original, candidate_files = core.image_files(core.BASE_IMAGE), core.image_files(image_id)
    changed = sorted(file for file in original.keys() | candidate_files.keys() if original.get(file) != candidate_files.get(file))
    assert changed == sorted(file for file in core.FILES if expected_before[file] != expected_after[file]), changed
    assert {file: candidate_files[file] for file in core.FILES} == expected_after
    if VERIFY_WORKSPACE_RUNTIME:
        for file, digest in candidate_files.items():
            if file.startswith(("src/", "public/", "migrations/")) or file in ["package.json", "package-lock.json"]:
                assert hashlib.sha256((core.SERVER / file).read_bytes()).hexdigest() == digest, f"Untested runtime: {file}"
    core.save("candidate-files.json", candidate_files)
    core.config_gate(before, core.compose(before, "compose.release.yml"), image_id)
    candidate = core.RELEASE / "candidate"
    candidate.mkdir(exist_ok=True)
    directories = ["public"] + (["src"] if any(file.startswith("src/") for file in core.FILES) else [])
    for directory in directories:
        if (candidate / directory).exists():
            shutil.rmtree(candidate / directory)
    temporary = core.run("docker", "create", "--entrypoint", "true", image_id).decode().strip()
    try:
        for directory in directories:
            core.run("docker", "cp", f"{temporary}:/app/{directory}", str(candidate / directory))
    finally:
        core.run("docker", "rm", temporary)
    shutil.copytree(core.SERVER / "test", candidate / "test", dirs_exist_ok=True)
    artifacts = core.RELEASE / "test-artifacts"
    artifacts.mkdir(exist_ok=True)
    browser_uid = int(core.run("docker", "run", "--rm", "--network", "none", "--entrypoint", "id", "mbbs-mbt-p1-test-e2e:latest", "-u"))
    browser_gid = int(core.run("docker", "run", "--rm", "--network", "none", "--entrypoint", "id", "mbbs-mbt-p1-test-e2e:latest", "-g"))
    os.chown(artifacts, browser_uid, browser_gid)
    mounts = ["-v", f"{candidate / 'public'}:/app/public:ro", "-v", f"{candidate / 'test'}:/app/test:ro",
              "-v", f"{artifacts}:/app/test-artifacts"]
    if "src" in directories:
        mounts += ["-v", f"{candidate / 'src'}:/app/src:ro"]
    logged("candidate-unit.log", ["docker", "run", "--rm", "--network", "none", *mounts,
        "--entrypoint", "node", "mbbs-retired-confirm-test:20260914", "--test", *UNIT_TESTS])
    logged("candidate-browser.log", ["docker", "run", "--rm", "--network", "none", "--ipc=host", *mounts,
        "--entrypoint", "node", "mbbs-mbt-p1-test-e2e:latest", "--test", *BROWSER_TESTS])
    for name, count in [("candidate-unit.log", EXPECTED_UNIT_PASSES), ("candidate-browser.log", EXPECTED_BROWSER_PASSES)]:
        output = (core.RELEASE / name).read_text()
        assert f"# pass {count}\n" in output and "# fail 0\n" in output
    core.save("manifest.json", {"image": core.IMAGE, "imageId": image_id, "rollbackImage": core.ROLLBACK,
        "before": expected_before, "after": expected_after, "changedFiles": changed, "imageFileCount": len(candidate_files),
        "unitPassed": EXPECTED_UNIT_PASSES, "browserPassed": EXPECTED_BROWSER_PASSES, "preparedAt": now()})
    print(json.dumps({"prepared": core.IMAGE, "imageId": image_id, "changedFiles": changed,
        "testsPassed": EXPECTED_UNIT_PASSES + EXPECTED_BROWSER_PASSES}), flush=True)


def verify():
    manifest = json.loads((core.RELEASE / "manifest.json").read_text())
    before = json.loads((core.RELEASE / "containers.before.private.json").read_text())
    after = core.inspect(*core.SERVICES, *core.DEPENDENCIES)
    assert after[0]["State"]["Health"]["Status"] == "healthy"
    assert all(row["State"]["Running"] for row in after)
    for index, service in enumerate(core.SERVICES):
        prior, current = before[index], after[index]
        assert current["Image"] == manifest["imageId"] and current["RestartCount"] == 0
        assert core.hashes(service) == manifest["after"]
        assert sorted(prior["Config"]["Env"]) == sorted(current["Config"]["Env"])
        for field in ["Cmd", "Entrypoint", "User", "WorkingDir"]:
            assert prior["Config"][field] == current["Config"][field], field
        assert sorted(prior["Mounts"], key=lambda mount: mount["Destination"]) == sorted(current["Mounts"], key=lambda mount: mount["Destination"])
        assert prior["HostConfig"]["PortBindings"] == current["HostConfig"]["PortBindings"]
    count = len(core.SERVICES)
    assert [(row["Id"], row["State"]["StartedAt"]) for row in before[count:]] == [(row["Id"], row["State"]["StartedAt"]) for row in after[count:]]
    probes = []
    for origin in ["http://127.0.0.1:3000", "https://test.mbbsoperation.com"]:
        for route, file in [("/operator", "public/operator.html"), (f"/operator.js?v={VERSION}", "public/operator.js"),
                            (f"/operator.css?v={VERSION}", "public/operator.css"), (f"/i18n.js?v={VERSION}", "public/i18n.js"),
                            ("/service-worker.js", "public/service-worker.js")]:
            request = urllib.request.Request(origin + route, headers={"User-Agent": "Mozilla/5.0", "Cache-Control": "no-cache"})
            with urllib.request.urlopen(request, timeout=15) as response:
                assert response.status == 200
                body = response.read()
                if origin.startswith("https:") and file == "public/operator.html":
                    body, _ = core.normalize_edge_html(body)
                assert hashlib.sha256(body).hexdigest() == manifest["after"][file], origin + route
                probes.append({"url": origin + route, "status": 200, "hashMatched": True})
        health_request = urllib.request.Request(origin + "/health", headers={"User-Agent": "Mozilla/5.0", "Cache-Control": "no-cache"})
        with urllib.request.urlopen(health_request, timeout=15) as response:
            assert response.status == 200 and json.load(response)["ok"] is True
    try:
        urllib.request.urlopen("http://127.0.0.1:3000/api/delivery/consolidation-loads/orders?locationId=1", timeout=10)
        raise AssertionError("Anonymous consolidation API unexpectedly allowed")
    except urllib.error.HTTPError as error:
        assert error.code == 401
    result = {"imageId": manifest["imageId"], "health": "healthy", "restarts": 0, "assets": probes,
        "configurationPreserved": True, "dependenciesUnchanged": True, "workerUpdated": UPDATE_WORKER,
        "anonymousApiStatus": 401, "verifiedAt": now()}
    core.save("live-verification.json", result)
    return result


def apply():
    os.umask(0o077)
    manifest = json.loads((core.RELEASE / "manifest.json").read_text())
    before = json.loads((core.RELEASE / "containers.before.private.json").read_text())
    current = core.inspect(*core.SERVICES, *core.DEPENDENCIES)
    source_gate()
    assert [row["Id"] for row in current] == [row["Id"] for row in before]
    assert core.hashes(core.SERVICES[0]) == manifest["before"]
    if UPDATE_WORKER:
        assert core.hashes(core.SERVICES[1]) == json.loads((core.RELEASE / "worker-files.before.json").read_text())
    assert core.inspect(core.IMAGE)[0]["Id"] == manifest["imageId"]
    core.config_gate(before, core.compose(before, "compose.release.yml"), manifest["imageId"])
    active = core.node_read("""import {query,withTransaction,pool} from './src/db.js';
      try {await withTransaction(async()=>{await query('SET TRANSACTION READ ONLY');
        console.log(JSON.stringify((await query(`SELECT
          (SELECT count(*)::int FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing')) AS postings,
          (SELECT count(*)::int FROM operator_posting_photo_uploads WHERE status='uploading' AND lease_expires_at>now()) AS photos,
          (SELECT count(*)::int FROM netsuite_order_webhook_inbox WHERE status='running') AS webhooks`)).rows[0]));
      });} finally {await pool.end();}""")
    core.save("active-work-before.json", active)
    assert not any(active.values()), "Active work detected; retry when idle"
    core.health()
    started = now()
    print(json.dumps({"cutoverStartedAt": started}), flush=True)
    ending = ["up", "-d", "--no-deps", "--no-build", "--pull", "never", "app"] + (["webhook-worker"] if UPDATE_WORKER else [])
    try:
        logged("cutover.log", core.compose(before, "compose.release.yml") + ending)
        core.wait_ready(manifest["imageId"])
        for index, service in enumerate(core.SERVICES):
            logs = core.run("docker", "logs", "--since", started, service, stderr=subprocess.STDOUT).decode()
            (core.RELEASE / f"service-{index}-startup.log").write_text(logs)
            assert not re.search(r"SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND|uncaughtException|operator_photo_worker_error", logs)
            if index == 1:
                assert "NetSuite order webhook serial worker" in logs and "started." in logs
        result = {"deployed": True, "image": core.IMAGE, "startedAt": started, **verify()}
        core.save("result.json", result)
        print(json.dumps(result), flush=True)
    except Exception:
        logged("rollback.log", core.compose(before, "compose.rollback.yml") + ending)
        if UPDATE_WORKER:
            wait_for_rollback()
        else:
            core.wait_ready(core.BASE_IMAGE)
        core.save("rolled-back.json", {"at": now()})
        raise


def wait_for_rollback():
    for _ in range(55):
        restored = core.inspect(*core.SERVICES)
        if (all(row["Image"] == expected and row["State"]["Running"] for row, expected in zip(restored, [core.BASE_IMAGE, BASE_WORKER_IMAGE]))
                and restored[0]["State"].get("Health", {}).get("Status") == "healthy"):
            return core.health()
        time.sleep(1)
    raise RuntimeError("Rollback did not become healthy")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["prepare", "apply", "verify"])
    mode = parser.parse_args().mode
    if mode == "prepare":
        prepare()
    elif mode == "apply":
        apply()
    else:
        print(json.dumps(verify()))
