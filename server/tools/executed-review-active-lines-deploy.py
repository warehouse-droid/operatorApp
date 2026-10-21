"""Deploy the verified Dispatch notice changes over the current application image."""
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
RELEASE = SERVER / "deployments/dispatch-source-replan-20260928"
ARTIFACT = SERVER / "test-artifacts/executed-review-active-lines-release-20260928"
EVIDENCE = SERVER / "test-artifacts/executed-review-active-lines"
APP = "mbbs-operator-app-app-1"
DEPENDENCIES = ["mbbs-operator-app-webhook-worker-1", "mbbs-operator-app-db-1", "mbbs-operator-app-ollama-1"]
BASE_IMAGE = "sha256:16a294ccd97316dc7d65c0fce811fe3645174bb6bdd1a45db68804e3f176b67c"
IMAGE = "mbbs-operator-app:dispatch-source-replan-20260928"
ROLLBACK = "mbbs-operator-app:rollback-dispatch-source-replan-20260928"
FILES = ["src/dispatch-repository.js", "src/dispatch-executed-order-review-repository.js",
         "src/dispatch-executed-order-review.js", "public/dispatch.js"]
spec = importlib.util.spec_from_file_location("release_core", SERVER / "tools/operator-display-settings-deploy.py")
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
docker = core.docker


def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + "\n")


def load():
    return json.loads((RELEASE / "manifest.json").read_text())


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def evidence():
    result = json.loads((EVIDENCE / "validation.json").read_text())
    assert result["suites"]["current"]["failures"] == result["suites"]["baseline"]["failures"]
    assert result["mutationsKilled"] == result["mutationsTotal"] == 8
    assert result["static"]["static"] == "no new diagnostics"
    assert all(row["covered"] == row["total"] for row in result["changedLineCoverage"])
    for name, expected in result["sourceHashes"].items():
        assert digest(SERVER / name) == expected, "Verified source changed: " + name
    return {name: result["sourceHashes"][name] for name in FILES}


def live_hashes():
    rows = docker("exec", APP, "sha256sum", *["/app/" + name for name in FILES]).decode().splitlines()
    return {row.split()[1].removeprefix("/app/"): row.split()[0] for row in rows}


def current(info):
    assert core.metadata(APP) == info["app"], "Live application changed; prepare a new release"
    assert [core.metadata(name) for name in DEPENDENCIES] == info["dependencies"], "Dependency changed"
    assert evidence() == info["files"], "Verified files changed"
    assert live_hashes() == info["baseline"], "Live baseline changed"


def compose(info, override="compose.release.yml"):
    args = ["sudo", "-n", "docker", "compose", "-p", "mbbs-operator-app"]
    for filename in info["app"]["configFiles"].split(","):
        args += ["-f", filename]
    return args + ["-f", str(RELEASE / override), "--env-file", str(ROOT / "docker/env/.env")]


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
    hashes = evidence()
    info = {"app": core.metadata(APP), "dependencies": [core.metadata(name) for name in DEPENDENCIES],
            "files": hashes, "baseline": {name: digest(EVIDENCE / "baseline" / Path(name).name) for name in FILES}}
    assert info["app"]["imageId"] == BASE_IMAGE, "Unexpected production release"
    current(info)
    RELEASE.mkdir(mode=0o700, exist_ok=False)
    ARTIFACT.mkdir(mode=0o700, exist_ok=False)
    stage = ARTIFACT / "stage"
    for name in FILES:
        target = stage / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SERVER / name, target)
    docker("tag", BASE_IMAGE, ROLLBACK)
    (stage / "Dockerfile").write_text("FROM " + ROLLBACK + "\n" + "".join(
        "COPY --chown=node:node " + name + " /app/" + name + "\n" for name in FILES))
    with (ARTIFACT / "build.log").open("wb") as log:
        subprocess.run(["sudo", "-n", "docker", "build", "--network", "none", "--pull=false", "-t", IMAGE, str(stage)],
                       stdout=log, stderr=subprocess.STDOUT, check=True)
    info["imageId"] = docker("image", "inspect", "--format", "{{.Id}}", IMAGE).decode().strip()
    for name, image in [("compose.release.yml", IMAGE), ("compose.rollback.yml", ROLLBACK)]:
        (RELEASE / name).write_text("services:\n  app:\n    image: " + image + "\n")
    rows = docker("run", "--rm", "--network", "none", "--entrypoint", "sha256sum", IMAGE,
                  *["/app/" + name for name in FILES]).decode().splitlines()
    assert {row.split()[1].removeprefix("/app/"): row.split()[0] for row in rows} == hashes
    smoke = "import assert from 'node:assert/strict'; import {buildPlannedOrderReviews} from './src/dispatch-executed-order-review.js'; import './src/dispatch-repository.js'; import './src/dispatch-executed-order-review-repository.js'; import {closeDb} from './src/db.js'; assert.equal(typeof buildPlannedOrderReviews,'function'); await closeDb();"
    docker("run", "--rm", "--network", "none", "--entrypoint", "node", IMAGE, "--input-type=module", "-e", smoke)
    for name in FILES:
        docker("run", "--rm", "--network", "none", "--entrypoint", "node", IMAGE, "--check", name)
    source = ARTIFACT / "candidate"
    source.mkdir()
    container = docker("create", "--network", "none", IMAGE).decode().strip()
    try:
        for name in ["src", "public", "migrations", "package.json", "package-lock.json"]:
            docker("cp", container + ":/app/" + name, str(source / name))
    finally:
        docker("rm", container)
    subprocess.run(["sudo", "-n", "chown", "-R", f"{os.getuid()}:{os.getgid()}", str(source)], check=True)
    for name in ["test", "tools", "contracts"]:
        shutil.copytree(SERVER / name, source / name)
    info["candidateRuntime"] = {str(path.relative_to(source)): digest(path)
                                for folder in ["src", "public", "migrations"]
                                for path in (source / folder).rglob("*") if path.is_file()}
    save("manifest.json", info)
    current(info)
    config_gate(info)
    print(json.dumps({"prepared": True, "image": IMAGE, "files": FILES}), flush=True)


def check():
    info = load()
    current(info)
    source = ARTIFACT / "candidate"
    assert {name: digest(source / name) for name in info["candidateRuntime"]} == info["candidateRuntime"]
    check_name = "dispatch-source-replan-release-20260928"
    environment = dict(os.environ, BIN_PLANNING_SOURCE_ROOT=str(source), BIN_PLANNING_CHECK=check_name)
    with (ARTIFACT / "release-tests.log").open("wb") as log:
        subprocess.run(["bash", str(SERVER / "tools/bin-planning-test.sh"), "node",
                        "tools/executed-review-active-lines-check.mjs", "coverage"],
                       cwd=SERVER, env=environment, stdout=log, stderr=subprocess.STDOUT, check=True)
    info_hashes = json.loads((SERVER / "test-artifacts/mbt-bin-planning/checks" / check_name /
                             "executed-review-active-lines/source-hashes.json").read_text())
    assert {name: info_hashes[name] for name in FILES} == info["files"]
    save("verified.json", {"passed": True, "imageId": info["imageId"], "log": str(ARTIFACT / "release-tests.log")})
    print(json.dumps({"candidateTestsPassed": True, "imageId": info["imageId"]}), flush=True)


def verify():
    info = load()
    core.ready(info["imageId"])
    actual = core.metadata(APP)
    assert actual["configuration"] == info["app"]["configuration"], "Runtime configuration changed"
    assert live_hashes() == info["files"]
    assert [core.metadata(name) for name in DEPENDENCIES] == info["dependencies"], "Dependency changed"
    script = r'''
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const expected = EXPECTED;
const checks = [];
for (const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
  const health = await fetch(base + '/health', {signal: AbortSignal.timeout(15000)});
  assert.equal(health.status,200); assert.equal((await health.json()).ok,true);
  const response = await fetch(base + '/dispatch.js?v=20260927-readonly-loads-v3',
    {headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(15000)});
  assert.equal(response.status,200);
  assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),expected);
  const auth = await fetch(base + '/api/dispatch/plans/340/executed-order-reviews', {signal:AbortSignal.timeout(15000)});
  assert.equal(auth.status,401);
  checks.push({base,health:200,dispatchAssetMatches:true,unauthenticatedReviews:401,cacheControl:response.headers.get('cache-control')});
}
console.log(JSON.stringify(checks));
'''.replace("EXPECTED", json.dumps(info["files"]["public/dispatch.js"]))
    http = json.loads(docker("exec", "-i", APP, "node", "--input-type=module", input=script.encode()))
    result = {"deployed": True, "at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "image": IMAGE,
              "imageId": info["imageId"], "configurationPreserved": True, "dependenciesUnchanged": True,
              "files": FILES, "http": http}
    save("deployment-result.json", result)
    print(json.dumps(result), flush=True)


def apply():
    info = load()
    current(info)
    verified = json.loads((RELEASE / "verified.json").read_text())
    assert verified["passed"] and verified["imageId"] == info["imageId"]
    assert docker("image", "inspect", "--format", "{{.Id}}", IMAGE).decode().strip() == info["imageId"]
    assert docker("image", "inspect", "--format", "{{.Id}}", ROLLBACK).decode().strip() == BASE_IMAGE
    config_gate(info)
    sql = """SELECT json_build_object(
      'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
      'quantityApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE quantity_review->>'status'='applying'))"""
    active = json.loads(docker("exec", DEPENDENCIES[1], "psql", "-U", "mbbs_app", "-d", "mbbs_yard",
                               "-XAt", "-v", "ON_ERROR_STOP=1", "-c", sql))
    assert not any(active.values()), "Active operations; retry cutover when idle"
    current(info)
    try:
        with (ARTIFACT / "publish.log").open("wb") as log:
            subprocess.run(compose(info) + ["up", "-d", "--no-build", "--no-deps", "--pull", "never", "app"],
                           cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except Exception:
        with (ARTIFACT / "rollback.log").open("wb") as log:
            subprocess.run(compose(info, "compose.rollback.yml") + ["up", "-d", "--no-build", "--no-deps", "--pull", "never", "app"],
                           cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        core.ready(BASE_IMAGE)
        raise


if __name__ == "__main__":
    {"prepare": prepare, "check": check, "apply": apply, "verify": verify}[sys.argv[1]]()
