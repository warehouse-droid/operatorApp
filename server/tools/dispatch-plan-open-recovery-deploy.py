"""Publish only the verified Dispatch opening fix, with an exact image rollback."""
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
ARTIFACT = SERVER / "test-artifacts/dispatch-save-after-2967-20261008"
RELEASE = SERVER / "deployments/dispatch-plan-open-recovery-20261008"
FILES = ["public/dispatch.js", "public/dispatch.html"]
APP = "mbbs-operator-app-app-1"
DEPENDENCIES = ["mbbs-operator-app-webhook-worker-1", "mbbs-operator-app-db-1", "mbbs-operator-app-ollama-1"]
IMAGE = "mbbs-operator-app:dispatch-plan-open-recovery-20261008"
ROLLBACK = "mbbs-operator-app:rollback-dispatch-plan-open-recovery-20261008"
spec = importlib.util.spec_from_file_location("release_core", SERVER / "tools/operator-display-settings-deploy.py")
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
docker = core.docker


def hashes():
    return {name: hashlib.sha256((SERVER / name).read_bytes()).hexdigest() for name in FILES}


def live_hashes():
    rows = docker("exec", APP, "sha256sum", *["/app/" + name for name in FILES]).decode().splitlines()
    return {row.split()[1].removeprefix("/app/"): row.split()[0] for row in rows}


def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + "\n")


def manifest():
    return json.loads((RELEASE / "manifest.json").read_text())


def compose(info, override="compose.release.yml"):
    args = ["sudo", "-n", "docker", "compose", "-p", "mbbs-operator-app"]
    for filename in info["app"]["configFiles"].split(","):
        args += ["-f", filename]
    return args + ["-f", str(RELEASE / override), "--env-file", str(ROOT / "docker/env/.env")]


def current(info):
    assert core.metadata(APP) == info["app"], "Live app changed; rebase release"
    assert live_hashes() == info["before"], "Live browser files changed"
    assert hashes() == info["after"], "Verified browser source changed"
    assert [core.metadata(name) for name in DEPENDENCIES] == info["dependencies"], "Dependency changed"


def config_gate(info):
    config = json.loads(subprocess.check_output(compose(info) + ["config", "--format", "json"], cwd=ROOT))["services"]["app"]
    image = json.loads(docker("image", "inspect", IMAGE))[0]["Config"]
    live = json.loads(docker("inspect", APP))[0]["Config"]
    env = dict(entry.split("=", 1) for entry in image["Env"])
    env.update({key: str(value) for key, value in config.get("environment", {}).items()})
    assert env == dict(entry.split("=", 1) for entry in live["Env"]), "Environment drift"
    for field, key in [("Cmd", "command"), ("Entrypoint", "entrypoint"), ("User", "user"), ("WorkingDir", "working_dir")]:
        assert (image.get(field) if config.get(key) is None else config[key]) == live.get(field), "Command drift"


def prepare():
    os.umask(0o077)
    log = (ARTIFACT / "verification/checks.log").read_text()
    assert '"uncovered":[]' in log and "Mutation: 7/7" in log, "Verification incomplete"
    assert '"sourceSha256":"' + hashes()["public/dispatch.js"] + '"' in log, "Source differs from tests"
    before = {name: hashlib.sha256((ARTIFACT / "baseline" / name).read_bytes()).hexdigest() for name in FILES}
    info = {"app": core.metadata(APP), "dependencies": [core.metadata(name) for name in DEPENDENCIES],
            "before": before, "after": hashes(), "files": FILES}
    current(info)
    RELEASE.mkdir(mode=0o700, exist_ok=False)
    stage = RELEASE / "stage"
    for name in FILES:
        target = stage / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SERVER / name, target)
    docker("tag", info["app"]["imageId"], ROLLBACK)
    (stage / "Dockerfile").write_text("FROM " + ROLLBACK + "\n" + "".join(
        "COPY --chown=node:node " + name + " /app/" + name + "\n" for name in FILES))
    with (RELEASE / "build.log").open("wb") as output:
        subprocess.run(["sudo", "-n", "docker", "build", "--network", "none", "--pull=false", "-t", IMAGE, str(stage)],
                       stdout=output, stderr=subprocess.STDOUT, check=True)
    info["imageId"] = docker("image", "inspect", "--format", "{{.Id}}", IMAGE).decode().strip()
    (RELEASE / "compose.release.yml").write_text("services:\n  app:\n    image: " + IMAGE + "\n")
    (RELEASE / "compose.rollback.yml").write_text("services:\n  app:\n    image: " + info["app"]["imageId"] + "\n")
    save("manifest.json", info)
    name = "mbbs-dispatch-open-release-check"
    try:
        # Teardown is registered before the bounded candidate test starts.
        result = docker("run", "--rm", "--init", "--name", name, "--label", "com.mbbs.lifecycle=disposable-test",
                        "--cgroup-parent=mbbs-tests.slice", "--cpus=1", "--memory=512m", "--memory-swap=512m",
                        "--pids-limit=128", "--read-only", "--network", "none", "--tmpfs", "/tmp:size=64m",
                        "--mount", "type=bind,src=" + str(SERVER / "test/dispatch/frontend/dispatch-plan-open-recovery.test.js")
                        + ",dst=/app/test/dispatch/frontend/dispatch-plan-open-recovery.test.js,readonly",
                        "--entrypoint", "node", IMAGE, "--test", "test/dispatch/frontend/dispatch-plan-open-recovery.test.js")
        (RELEASE / "candidate-tests.log").write_bytes(result)
    finally:
        subprocess.run(["sudo", "-n", "docker", "rm", "-f", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    current(info)
    config_gate(info)
    print(json.dumps({"prepared": True, "files": FILES, "image": IMAGE}))


def verify():
    info = manifest()
    core.ready(info["imageId"])
    assert core.metadata(APP)["configuration"] == info["app"]["configuration"], "Runtime configuration changed"
    assert live_hashes() == info["after"]
    assert [core.metadata(name) for name in DEPENDENCIES] == info["dependencies"], "Dependency changed"
    script = """import assert from 'node:assert/strict'; import {createHash} from 'node:crypto';
const expected=EXPECTED; const results=[];
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
  const health=await fetch(base+'/health',{signal:AbortSignal.timeout(15000)});
  assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
  for(const [name,digest] of Object.entries(expected)) {
    const response=await fetch(base+'/'+name.replace('public/','')+'?v=20261008-plan-open-recovery-v1',
      {headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(15000)});
    assert.equal(response.status,200);assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),digest);
  }
  const auth=await fetch(base+'/api/dispatch/plans/350',{signal:AbortSignal.timeout(15000)});assert.equal(auth.status,401);
  results.push({base,health:200,browserFilesVerified:2,unauthenticatedPlan:401});
}console.log(JSON.stringify(results));""".replace("EXPECTED", json.dumps(info["after"]))
    checks = json.loads(docker("exec", "-i", APP, "node", "--input-type=module", input=script.encode()))
    result = {"deployed": True, "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "imageId": info["imageId"], "files": FILES, "configurationPreserved": True,
              "dependenciesUnchanged": True, "http": checks}
    save("result.json", result)
    print(json.dumps(result))


def apply():
    info = manifest()
    current(info)
    config_gate(info)
    sql = """SELECT json_build_object(
      'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
      'quantityApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE quantity_review->>'status'='applying'))"""
    active = json.loads(docker("exec", DEPENDENCIES[1], "psql", "-U", "mbbs_app", "-d", "mbbs_yard", "-XAt", "-c", sql))
    assert not any(active.values()), "Active operations; retry cutover when idle"
    current(info)
    try:
        with (RELEASE / "publish.log").open("wb") as output:
            subprocess.run(compose(info) + ["up", "-d", "--no-build", "--no-deps", "--pull", "never", "app"],
                           cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except Exception:
        with (RELEASE / "rollback.log").open("wb") as output:
            subprocess.run(compose(info, "compose.rollback.yml") + ["up", "-d", "--no-build", "--no-deps", "--pull", "never", "app"],
                           cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=60)
        core.ready(info["app"]["imageId"])
        raise


if __name__ == "__main__":
    {"prepare": prepare, "apply": apply, "verify": verify}[sys.argv[1]]()
