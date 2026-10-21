"""Apply the verified one-file fix on the captured live image and repair one link."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

SERVER = Path(__file__).resolve().parents[2]
OUT = SERVER / "test-artifacts/retired-group-dependency-20261006"
RELEASE = SERVER / "deployments/retired-group-dependency-20261006"
APP = "mbbs-operator-app-app-1"
DEPENDENCIES = ["mbbs-operator-app-db-1", "mbbs-operator-app-webhook-worker-1", "mbbs-operator-app-ollama-1"]
FILE = "src/order-dependency-repository.js"
BASE = "mbbs-operator-app:retired-group-dependency-20261006-rollback"
IMAGE = "mbbs-operator-app:retired-group-dependency-20261006"


def docker(*args, **kwargs):
    return subprocess.check_output(["docker", *args], **kwargs)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def metadata(name):
    original = json.loads(docker("inspect", name))[0]
    config = {"Config": {key: value for key, value in original["Config"].items()
                         if key not in ["Image", "Labels", "Hostname"]},
              "HostConfig": original["HostConfig"]}
    config["Config"]["Env"] = sorted(config["Config"]["Env"])
    return {"image": original["Image"], "configHash": digest(json.dumps(config, sort_keys=True).encode())}


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n")


def compose(state, rollback=False):
    labels = state["compose"]
    args = ["sudo", "-n", "docker", "compose", "--project-name", labels["com.docker.compose.project"],
            "--project-directory", labels["com.docker.compose.project.working_dir"]]
    if labels.get("com.docker.compose.project.environment_file"):
        args += ["--env-file", labels["com.docker.compose.project.environment_file"]]
    for file in labels["com.docker.compose.project.config_files"].split(","):
        args += ["-f", file]
    return args + ["-f", str(RELEASE / ("compose.rollback.yml" if rollback else "compose.release.yml"))]


def prepare():
    evidence = json.loads((OUT / "results/final-summary.json").read_text())
    assert evidence["focused"]["fail"] == 0 and evidence["newFailures"] == []
    assert all(row["killed"] for row in evidence["mutations"])
    assert evidence["changedLines"]["covered"] == evidence["changedLines"]["total"]
    assert evidence["sourceHash"] == digest((SERVER / FILE).read_bytes())
    live = docker("exec", APP, "cat", "/app/" + FILE)
    assert live == (OUT / "baseline" / FILE).read_bytes(), "Live source changed; rebase and revalidate"
    original = json.loads(docker("inspect", APP))[0]
    state = {**metadata(APP), "compose": {key: value for key, value in original["Config"]["Labels"].items()
                                         if key.startswith("com.docker.compose.project")},
             "dependencies": {name: metadata(name) for name in DEPENDENCIES}}
    RELEASE.mkdir(parents=True, exist_ok=True)
    state_file = RELEASE / "state.json"
    if state_file.exists():
        captured = json.loads(state_file.read_text())
        assert {key: state[key] for key in ["image", "configHash", "dependencies"]} == {
            key: captured[key] for key in ["image", "configHash", "dependencies"]
        }, "Production changed after release preparation"
        # A successful rollback adds its override to the container's Compose
        # labels. Reuse the captured configuration once runtime equality holds.
        state = captured
    else:
        save(state_file, state)
    target = RELEASE / "overlay" / FILE
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes((SERVER / FILE).read_bytes())
    docker("tag", state["image"], BASE)
    (RELEASE / "Dockerfile").write_text("FROM " + BASE + "\nCOPY --chown=node:node overlay/" + FILE + " /app/" + FILE + "\n")
    (RELEASE / "compose.release.yml").write_text("services:\n  app:\n    image: " + IMAGE + "\n    pull_policy: never\n")
    (RELEASE / "compose.rollback.yml").write_text("services:\n  app:\n    image: " + BASE + "\n    pull_policy: never\n")
    with (OUT / "build.log").open("wb") as log:
        subprocess.run(["docker", "build", "--network=none", "--pull=false", "--provenance=false", "-t", IMAGE, str(RELEASE)],
                       stdout=log, stderr=subprocess.STDOUT, check=True)
    candidate = docker("image", "inspect", "--format", "{{.Id}}", IMAGE).decode().strip()
    service = json.loads(subprocess.check_output(compose(state) + ["config", "--format", "json"],
                                                stderr=subprocess.PIPE))["services"]["app"]
    environment = dict(value.split("=", 1) for value in original["Config"]["Env"])
    assert all(environment.get(key) == str(value) for key, value in service.get("environment", {}).items()), "Environment drift"
    manifest = {"image": candidate, "baseImage": state["image"], "file": FILE, "sourceHash": evidence["sourceHash"]}
    save(RELEASE / "manifest.json", manifest)
    print(json.dumps({"prepared": True, **manifest}))


def ready():
    for _attempt in range(50):
        current = json.loads(docker("inspect", APP))[0]
        if current["State"]["Running"] and current["State"].get("Health", {}).get("Status") == "healthy":
            return
        time.sleep(1)
    raise RuntimeError("Application did not become healthy after cutover")


def verify():
    state = json.loads((RELEASE / "state.json").read_text())
    manifest = json.loads((RELEASE / "manifest.json").read_text())
    ready()
    save(RELEASE / "verification-runtime.json", metadata(APP))
    assert metadata(APP) == {"image": manifest["image"], "configHash": state["configHash"]}
    assert digest(docker("exec", APP, "cat", "/app/" + FILE)) == manifest["sourceHash"]
    for name, previous in state["dependencies"].items():
        assert metadata(name) == previous, "Unexpected dependency change: " + name
    health = json.loads(docker("exec", APP, "node", "-e",
        "fetch('http://127.0.0.1:3000/health').then(r=>r.json()).then(v=>console.log(JSON.stringify(v)))"))
    assert health["ok"] is True
    result = {"deployed": True, "healthy": True, "configurationPreserved": True,
              "otherProductionContainersPreserved": True, **manifest}
    save(RELEASE / "deployed.json", result)
    print(json.dumps(result))


def apply():
    state = json.loads((RELEASE / "state.json").read_text())
    assert metadata(APP) == {key: state[key] for key in ["image", "configHash"]}
    assert digest((SERVER / FILE).read_bytes()) == json.loads((RELEASE / "manifest.json").read_text())["sourceHash"]
    # This is an operational precondition check; no live test data is created.
    probe = """import {query,closeDb} from './src/db.js';
try {console.log(JSON.stringify((await query(`SELECT
 (SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')) AS operator_posting,
 (SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing') AS driver_executing,
 (SELECT count(*) FROM regular_stock_handoffs WHERE status='executing') AS stock_executing,
 (SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating') AS special_creating`)).rows[0]));}
finally {await closeDb();}"""
    active = json.loads(docker("exec", "-i", "-w", "/app", APP, "node", "--input-type=module", input=probe.encode()))
    assert not any(int(value) for value in active.values()), "Operational work is active: " + json.dumps(active)
    try:
        with (OUT / "publish.log").open("wb") as log:
            subprocess.run(compose(state) + ["up", "-d", "--no-deps", "--no-build", "--pull", "never", "app"],
                           stdout=log, stderr=subprocess.STDOUT, check=True)
        verify()
    except BaseException:
        with (OUT / "rollback.log").open("wb") as log:
            subprocess.run(compose(state, rollback=True) + ["up", "-d", "--no-deps", "--no-build", "--pull", "never", "app"],
                           stdout=log, stderr=subprocess.STDOUT, check=True)
        ready()
        raise


def live(mode):
    source = (SERVER / "tools/retired-group-dependency-20261006/live.mjs").read_bytes()
    args = ["docker", "exec", "-i", "-w", "/app", "-e", "RETIRED_GROUP_MODE=" + mode]
    if mode != "inspect":
        args += ["-e", "RETIRED_GROUP_EXPECTED=" + (OUT / "live-before.json").read_text()]
    result = json.loads(subprocess.check_output(args + [APP, "node", "--input-type=module"], input=source))
    save(OUT / ("live-before.json" if mode == "inspect" else "live-" + mode + ".json"), result)
    if mode == "inspect":
        print(json.dumps({"mode": mode, "dependencyId": 272, "target": result["before"]["dependency"]["dispatch_target_ref"]}))
    else:
        print(json.dumps({key: value for key, value in result.items() if key != "after"}))


if __name__ == "__main__":
    action = sys.argv[1]
    if action in ["prepare", "apply", "verify"]:
        globals()[action]()
    else:
        assert action in ["inspect", "repair", "verify-link"]
        live("verify" if action == "verify-link" else action)
