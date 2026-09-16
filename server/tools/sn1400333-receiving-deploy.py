"""Deploy the approved two-file receipt correction with verified rollback."""
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
RELEASE = Path("/home/ubuntu/operatorapp-deploy-backups/sn1400333-20260915")
IMAGE = "mbbs-operator-app:sn1400333-receiving-20260915-v1"
ROLLBACK = "mbbs-operator-app:rollback-sn1400333-20260915"
BASE_IMAGE = "sha256:ae0c3c65519eb3ee48082b974bb5403fe57914d92bab2fce7144a9ef976c8f4c"
SERVICES = ["mbbs-operator-app-app-1", "mbbs-operator-app-webhook-worker-1"]
DEPENDENCIES = ["mbbs-operator-app-db-1", "mbbs-operator-app-ollama-1"]
FILES = ["src/operator-netsuite-posting-domain.js", "src/operator-netsuite-posting-targets.js"]


def run(*args, **kwargs):
    return subprocess.check_output(args, cwd=ROOT, **kwargs)


def save(name, value):
    path = RELEASE / name
    path.write_text(json.dumps(value, indent=2) + "\n")
    path.chmod(0o600)


def inspect(*containers):
    return json.loads(run("docker", "inspect", *containers))


def hashes(container):
    output = run("docker", "exec", container, "sha256sum", *["/app/" + name for name in FILES]).decode()
    return {row.split()[1].removeprefix("/app/"): row.split()[0] for row in output.splitlines()}


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
    changes = json.loads((SERVER / "test/sn1400333-receiving-changes.json").read_text())
    report = json.loads((SERVER / "test-artifacts/sn1400333-receiving/verified-results.json").read_text())
    assert report["newFailures"] == 0 and report["focused"]["fail"] == 0
    for file, digest in report["staticAndMutation"]["sources"].items():
        assert hashlib.sha256((SERVER / file).read_bytes()).hexdigest() == digest, f"Untested source: {file}"
    return {row["file"]: row["beforeSha256"] for row in changes}, {row["file"]: row["afterSha256"] for row in changes}


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
    temporary = run("docker", "create", "--entrypoint", "true", image_id).decode().strip()
    try:
        run("docker", "cp", f"{temporary}:/app/src", str(RELEASE / "candidate-src"))
    finally:
        run("docker", "rm", temporary)
    tests = json.loads((SERVER / "test-artifacts/sn1400333-receiving/summary.json").read_text())["shuffledFiles"]
    tests = [file for file in tests if "/integration/" not in file]
    with (RELEASE / "candidate-tests.log").open("wb") as output:
        subprocess.run(["docker", "run", "--rm", "--network", "none", "--user", "0:0",
            "-e", "NODE_ENV=test", "-e", "MBBS_ENV_FILE=/nonexistent", "-e", "MBT_TEST_ISOLATED=1",
            "-v", f"{RELEASE / 'candidate-src'}:/app/src:ro", "-v", f"{SERVER / 'test'}:/app/test:ro",
            "--entrypoint", "node", "mbbs-retired-confirm-test:20260914", "--test", "--test-concurrency=1", *tests],
            stdout=output, stderr=subprocess.STDOUT, check=True)
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
            assert not re.search(r"SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND|uncaughtException", logs)
            if name == "worker":
                assert "NetSuite order webhook serial worker" in logs and "started." in logs
        result = {"deployed": True, "image": IMAGE, "imageId": manifest["imageId"], "health": ready,
                  "readyAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  "configurationPreserved": True, "dependenciesUnchanged": True, "changedFiles": FILES,
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


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["prepare", "apply"])
    mode = parser.parse_args().mode
    prepare() if mode == "prepare" else cutover()
