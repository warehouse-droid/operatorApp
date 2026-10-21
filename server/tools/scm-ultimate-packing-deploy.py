"""Release only the validated urgency overlay, retaining an automatic rollback."""
import atexit
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / "server"
ARTIFACT = SERVER / "test-artifacts/scm-ultimate-packing-20261005"
RELEASE = SERVER / "deployments/scm-ultimate-packing-20261005"
APP = "mbbs-operator-app-app-1"
DEPENDENCIES = ["mbbs-operator-app-db-1", "mbbs-operator-app-webhook-worker-1", "mbbs-operator-app-ollama-1"]
FILES = ["src/smart-scm-planning-repository.js", "public/scm-smart-proposals.js", "public/scm-smart.html"]
IMAGE = "mbbs-operator-app:scm-ultimate-packing-20261005-v1"
ROLLBACK = "mbbs-operator-app:rollback-scm-ultimate-packing-20261005-v1"
TEST_NAME = "mbbs-scm-ultimate-image-check"
test_registered = False


def docker(*args, **kwargs):
    return subprocess.check_output(["sudo", "-n", "docker", *args], **kwargs)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + "\n")


def metadata(name):
    row = json.loads(docker("inspect", name))[0]
    config = {key: row["Config"].get(key) for key in ["Cmd", "Entrypoint", "User", "WorkingDir", "Healthcheck"]}
    config["env"] = sorted(row["Config"].get("Env", []))
    config["mounts"] = sorted(row["Mounts"], key=lambda item: item["Destination"])
    config["host"] = {key: row["HostConfig"].get(key) for key in ["PortBindings", "RestartPolicy", "Memory", "MemorySwap",
        "MemoryReservation", "NanoCpus", "PidsLimit", "Init", "ReadonlyRootfs", "Tmpfs", "SecurityOpt", "CapDrop"]}
    return {"id": row["Id"], "image": row["Config"]["Image"], "imageId": row["Image"],
            "configuration": digest(json.dumps(config, sort_keys=True).encode()),
            "configFiles": row["Config"]["Labels"]["com.docker.compose.project.config_files"],
            "projectDirectory": row["Config"]["Labels"]["com.docker.compose.project.working_dir"]}


def state():
    return json.loads((RELEASE / "manifest.json").read_text())


def hashes(container, files):
    output = docker("exec", container, "sha256sum", *["/app/" + file for file in files]).decode().splitlines()
    return {line.split()[1].removeprefix("/app/"): line.split()[0] for line in output}


def verified_source():
    manifest = json.loads((ARTIFACT / "final/source-manifest.json").read_text())
    assert all(digest((SERVER / file).read_bytes()) == expected for file, expected in manifest["sourceHashes"].items()), "Validated source changed"
    assert all(digest((ARTIFACT / "candidate" / file).read_bytes()) == manifest["sourceHashes"][file] for file in FILES)
    stages = json.loads((ARTIFACT / "final/stages.json").read_text())
    assert {row["label"] for row in stages} == {"focused", "static", "candidate", "shuffled", "replay", "mutations", "runtime", "coverage"}
    assert all(row["exitCode"] == 0 for row in stages), "Final gauntlet required"
    assert json.loads((ARTIFACT / "final/review.json").read_text())["secretMatches"] == 0
    return manifest


def current(data):
    assert metadata(APP) == data["app"], "Application changed during release preparation"
    assert [metadata(name) for name in DEPENDENCIES] == data["dependencies"], "Dependency changed during release preparation"
    assert hashes(APP, FILES) == data["before"], "Live source changed"
    assert all(digest((SERVER / file).read_bytes()) == data["after"][file] for file in FILES)


def prepare():
    os.umask(0o077)
    manifest = verified_source()
    capture = json.loads((ARTIFACT / "capture.json").read_text())
    app = metadata(APP)
    assert app["id"] == capture["containerId"] and app["imageId"] == capture["baseImageId"], "Live image changed since the verified capture"
    RELEASE.mkdir(parents=True, exist_ok=False)
    data = {"app": app, "dependencies": [metadata(name) for name in DEPENDENCIES],
            "before": {file: capture["sourceHashes"][file] for file in FILES},
            "after": {file: manifest["sourceHashes"][file] for file in FILES},
            "sourceTreeHash": manifest["sourceTreeHash"], "files": FILES}
    current(data)
    stage = RELEASE / "stage"
    for file in FILES:
        (stage / file).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ARTIFACT / "candidate" / file, stage / file)
    (stage / "Dockerfile").write_text("FROM " + ROLLBACK + "\n" +
        "".join("COPY --chown=node:node " + file + " /app/" + file + "\n" for file in FILES))
    (RELEASE / "compose.release.yml").write_text("services:\n  app:\n    image: " + IMAGE + "\n")
    (RELEASE / "compose.rollback.yml").write_text("services:\n  app:\n    image: " + ROLLBACK + "\n")
    shutil.copy2(ARTIFACT / "release.patch", RELEASE / "release.patch")
    save("manifest.json", data)
    print(json.dumps({"prepared": True, "files": FILES, "sourceTreeHash": manifest["sourceTreeHash"]}), flush=True)


def cleanup_test():
    global test_registered
    if not test_registered:
        return
    subprocess.run(["sudo", "-n", "docker", "rm", "-fv", TEST_NAME], capture_output=True)
    for args, filename in [(["ps"], "docker-ps.log"), (["ps", "-a"], "docker-ps-a.log")]:
        (RELEASE / filename).write_bytes(docker(*args, "--format", "{{.Names}}\t{{.Status}}"))
    assert not docker("ps", "-a", "--filter", "name=^/" + TEST_NAME + "$", "--format", "{{.ID}}").strip()
    assert docker("inspect", "--format", "{{.State.Health.Status}}", APP).decode().strip() == "healthy"
    assert docker("inspect", "--format", "{{.State.Health.Status}}", DEPENDENCIES[0]).decode().strip() == "healthy"
    test_registered = False


def build():
    global test_registered
    data = state()
    current(data)
    docker("tag", data["app"]["imageId"], ROLLBACK)
    with (RELEASE / "build.log").open("wb") as output:
        subprocess.run(["sudo", "-n", "docker", "build", "--network", "none", "--pull=false", "-t", IMAGE,
                        str(RELEASE / "stage")], stdout=output, stderr=subprocess.STDOUT, check=True, timeout=120)
    image = json.loads(docker("image", "inspect", IMAGE))[0]
    assert not any(re.search(r"(?:PASSWORD|SECRET|TOKEN|PRIVATE_KEY)=.+", entry, re.I) for entry in image["Config"].get("Env", [])), "Image contains credential environment variables"
    data["candidateImageId"] = image["Id"]
    assert not docker("ps", "-a", "--filter", "name=^/" + TEST_NAME + "$", "--format", "{{.ID}}").strip()
    test_registered = True
    atexit.register(cleanup_test)
    script = """import assert from 'node:assert/strict'; import fs from 'node:fs'; import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const expected=EXPECTED;
for(const [file,hash] of Object.entries(expected)){
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync('/app/'+file)).digest('hex'),hash,file);
  if(file.endsWith('.js')) execFileSync(process.execPath,['--check','/app/'+file]);
}
console.log(JSON.stringify({verifiedFiles:Object.keys(expected).length,syntaxChecks:2}));
""".replace("EXPECTED", json.dumps(data["after"]))
    try:
        output = docker("run", "--rm", "--name", TEST_NAME, "--network", "none", "--cgroup-parent=mbbs-tests.slice", "--init",
            "--label", "com.mbbs.lifecycle=disposable-test", "--memory=512m", "--memory-swap=512m", "--cpus=1", "--pids-limit=128",
            "--read-only", "--tmpfs", "/tmp:uid=1000,gid=1000,mode=1777,size=32m", "--tmpfs", "/app/data:uid=1000,gid=1000,mode=0700,size=16m",
            "--env", "NODE_ENV=test", "--entrypoint", "node", data["candidateImageId"], "--input-type=module", "-e", script)
        (RELEASE / "image-check.log").write_bytes(output)
    finally:
        cleanup_test()
    data["imageVerified"] = True
    save("manifest.json", data)
    print(json.dumps({"built": IMAGE, "imageId": image["Id"], "verifiedFiles": len(FILES)}), flush=True)


def compose(data, override):
    args = ["sudo", "-n", "docker", "compose", "--project-directory", data["app"]["projectDirectory"], "-p", "mbbs-operator-app"]
    for file in data["app"]["configFiles"].split(","):
        args.extend(["-f", file])
    return args + ["-f", str(RELEASE / override), "--env-file", str(ROOT / "docker/env/.env")]


def preflight_config(data):
    service = json.loads(subprocess.check_output(compose(data, "compose.release.yml") + ["config", "--format", "json"], cwd=ROOT))["services"]["app"]
    config = json.loads(docker("inspect", APP))[0]["Config"]
    image_config = json.loads(docker("image", "inspect", data["candidateImageId"]))[0]["Config"]
    expected_env = dict(entry.split("=", 1) for entry in image_config.get("Env", []))
    expected_env.update({key: str(value) for key, value in service.get("environment", {}).items()})
    assert expected_env == dict(entry.split("=", 1) for entry in config["Env"]), "Compose would change runtime environment"
    for field, key in [("Cmd", "command"), ("Entrypoint", "entrypoint"), ("User", "user"), ("WorkingDir", "working_dir")]:
        value = service.get(key)
        assert (image_config.get(field) if value is None else value) == config.get(field), "Compose would change " + field
    return service


def ready(image_id):
    probe = "fetch('http://127.0.0.1:3000/health').then(async r=>{if(!r.ok||(await r.json()).ok!==true)process.exit(1)}).catch(()=>process.exit(1))"
    for _ in range(60):
        row = json.loads(docker("inspect", APP))[0]
        if row["Image"] == image_id and row["State"]["Running"] and row["RestartCount"] == 0 and row["State"].get("Health", {}).get("Status") == "healthy":
            result = subprocess.run(["sudo", "-n", "docker", "exec", APP, "node", "-e", probe], capture_output=True, timeout=5)
            if result.returncode == 0:
                return
        time.sleep(0.5)
    raise RuntimeError("Application did not become healthy")


def verify():
    data = state()
    ready(data["candidateImageId"])
    after = metadata(APP)
    assert after["configuration"] == data["app"]["configuration"], "Runtime configuration changed"
    assert [metadata(name) for name in DEPENDENCIES] == data["dependencies"], "Dependency container changed"
    assert hashes(APP, FILES) == data["after"], "Runtime source mismatch"
    script = """import assert from 'node:assert/strict'; import crypto from 'node:crypto';
const files=FILES;
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
 const health=await fetch(base+'/health',{signal:AbortSignal.timeout(15000)}); assert.equal(health.status,200); assert.equal((await health.json()).ok,true);
 for(const [file,expected] of Object.entries(files)){
  const response=await fetch(base+'/'+file.replace(/^public\\//,''),{headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(15000)});
  assert.equal(response.status,200); assert.equal(crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),expected,file);
 }
 const anonymous=await fetch(base+'/api/scm/smart/planning-runs',{signal:AbortSignal.timeout(15000)});assert.equal(anonymous.status,401);
}
console.log(JSON.stringify({localHealth:200,publicHealth:200,publicAssetHashes:2,anonymousPlanning:401}));
""".replace("FILES", json.dumps({file: value for file, value in data["after"].items() if file.startswith("public/")}))
    http = json.loads(docker("exec", "-i", APP, "node", "--input-type=module", input=script.encode(), timeout=75))
    result = {"deployed": True, "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "image": IMAGE, "imageId": after["imageId"], "sourceTreeHash": data["sourceTreeHash"],
              "runtimeFilesVerified": len(FILES), "configurationPreserved": True, "dependenciesUnchanged": True,
              "schemaChanges": 0, "historicalPlansRewritten": False, **http}
    save("deployment-result.json", result)
    print(json.dumps(result), flush=True)


def apply():
    data = state()
    verified_source()
    current(data)
    assert data.get("imageVerified"), "Image verification required"
    assert docker("image", "inspect", "--format", "{{.Id}}", IMAGE).decode().strip() == data["candidateImageId"]
    preflight_config(data)
    # Avoid restarting the application while it is finalizing an operator post.
    sql = "BEGIN READ ONLY; SET LOCAL statement_timeout='5s'; SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing'); COMMIT;"
    idle = docker("exec", "-i", DEPENDENCIES[0], "psql", "-U", "mbbs_app", "-d", "mbbs_yard", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", input=sql.encode()).decode().strip()
    assert idle == "0", "Active operator post: defer application restart"
    current(data)
    command = ["up", "-d", "--no-build", "--no-deps", "--pull", "never", "app"]
    print(json.dumps({"cutoverStarted": datetime.datetime.now(datetime.timezone.utc).isoformat()}), flush=True)
    try:
        with (RELEASE / "cutover.log").open("wb") as output:
            subprocess.run(compose(data, "compose.release.yml") + command, cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=100)
        verify()
    except BaseException:
        with (RELEASE / "rollback.log").open("wb") as output:
            subprocess.run(compose(data, "compose.rollback.yml") + command, cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=100)
        ready(data["app"]["imageId"])
        save("rolled-back.json", {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "restoredImageId": data["app"]["imageId"]})
        raise


if __name__ == "__main__":
    {"prepare": prepare, "build": build, "apply": apply, "verify": verify}[sys.argv[1]]()
