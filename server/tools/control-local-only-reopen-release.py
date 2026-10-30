"""Publish only the verified Control reopen files, preserving live configuration."""
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
RELEASE = SERVER / "deployments/control-local-only-reopen-20261021"
IMAGE = "mbbs-operator-app:control-local-only-reopen-20261021"
APP = "mbbs-operator-app-app-1"
DEPENDENCIES = ["mbbs-operator-app-db-1", "mbbs-operator-app-webhook-worker-1", "mbbs-operator-app-ollama-1"]
spec = importlib.util.spec_from_file_location("release_core", SERVER / "tools/operator-display-settings-deploy.py")
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
docker, metadata = core.docker, core.metadata


def digest(value):
    return hashlib.sha256(value).hexdigest()


def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + "\n")


def evidence():
    data = json.loads((SERVER / "test/control-local-only-reopen-evidence.json").read_text())
    assert not data["newFailures"] and not data["types"]["newTypes"]
    assert len(data["manualMutantsKilled"]) == 6 and data["lint"] == 0
    assert not data["changedLines"]["missing"]
    assert data["restoredPrimary"]["pass"] == data["restoredPrimary"]["tests"]
    for name, expected in data["sourceHashes"].items():
        assert digest((SERVER / name).read_bytes()) == expected, "Source changed after verification: " + name
    return data


def live(name):
    return docker("exec", APP, "cat", "/app/" + name)


def compose(data, suffix):
    args = ["sudo", "-n", "docker", "compose", "-p", "mbbs-operator-app"]
    for name in data["app"]["configFiles"].split(","):
        args += ["-f", name]
    return args + ["-f", str(RELEASE / ("compose." + suffix + ".yml"))]


def current(data):
    assert metadata(APP) == data["app"], "Live application changed; rebase before release"
    assert [metadata(name) for name in DEPENDENCIES] == data["dependencies"]
    for name, expected in data["evidence"]["baselineHashes"].items():
        assert digest(live(name)) == expected, "Live file changed: " + name


def prepare():
    checked = evidence()
    RELEASE.mkdir(parents=True, exist_ok=True)
    data = {"app": metadata(APP), "dependencies": [metadata(name) for name in DEPENDENCIES], "evidence": checked}
    assert data["app"]["imageId"] == checked["baseImage"]
    for name in checked["sourceHashes"]:
        for folder, content in [("before", live(name)), ("candidate", (SERVER / name).read_bytes())]:
            path = RELEASE / folder / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
    base = "mbbs-operator-app:control-reopen-base-" + checked["baseImage"].split(":")[-1][:12]
    current(data)
    docker("tag", checked["baseImage"], base)
    (RELEASE / "candidate/Dockerfile").write_text("FROM " + base + "\n" + "".join(
        f"COPY --chown=node:node {name} /app/{name}\n" for name in checked["sourceHashes"]))
    (RELEASE / "compose.release.yml").write_text("services:\n  app:\n    image: " + IMAGE + "\n")
    (RELEASE / "compose.rollback.yml").write_text("services:\n  app:\n    image: " + checked["baseImage"] + "\n")
    with (RELEASE / "build.log").open("wb") as log:
        subprocess.run(["sudo", "-n", "docker", "build", "--pull=false", "--network=none", "-t", IMAGE,
                        str(RELEASE / "candidate")], stdout=log, stderr=subprocess.STDOUT, check=True, timeout=120)
    data["candidateImageId"] = docker("image", "inspect", "--format", "{{.Id}}", IMAGE).decode().strip()
    before = json.loads(subprocess.check_output(compose(data, "rollback") + ["config", "--format", "json"], cwd=ROOT))
    after = json.loads(subprocess.check_output(compose(data, "release") + ["config", "--format", "json"], cwd=ROOT))
    before["services"]["app"].pop("image")
    assert after["services"]["app"].pop("image") == IMAGE
    assert before == after, "Compose configuration would change"
    save("manifest.json", data)
    print(json.dumps({"prepared": True, "files": list(checked["sourceHashes"]), "imageId": data["candidateImageId"]}), flush=True)


def verify(data):
    core.ready(data["candidateImageId"])
    actual = metadata(APP)
    assert actual["imageId"] == data["candidateImageId"]
    assert actual["configuration"] == data["app"]["configuration"]
    assert [metadata(name) for name in DEPENDENCIES] == data["dependencies"]
    for name, expected in data["evidence"]["sourceHashes"].items():
        assert digest(live(name)) == expected
        if name.startswith("public/"):
            served = subprocess.check_output(["curl", "-fsS", "http://127.0.0.1:3000/" + name.removeprefix("public/")])
            assert digest(served) == expected
    result = {"deployed": True, "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "imageId": actual["imageId"], "onlyAppChanged": True, "configurationPreserved": True,
              "runtimeHashes": data["evidence"]["sourceHashes"], "noNetSuiteRequests": True,
              "dockerPs": docker("ps", "--format", "{{.Names}} {{.Status}}").decode(),
              "dockerPsA": docker("ps", "-a", "--format", "{{.Names}} {{.Status}}").decode()}
    assert not docker("ps", "-aq", "--filter", "label=com.mbbs.lifecycle=disposable-test").strip()
    save("deployment-result.json", result)
    print(json.dumps(result), flush=True)


def apply():
    evidence()
    data = json.loads((RELEASE / "manifest.json").read_text())
    current(data)
    assert docker("image", "inspect", "--format", "{{.Id}}", IMAGE).decode().strip() == data["candidateImageId"]
    code = b"import {query,closeDb} from './src/db.js';try{console.log(JSON.stringify((await query(\"SELECT count(*)::int AS count FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing')\")).rows[0]));}finally{await closeDb();}"
    assert json.loads(docker("exec", "-i", "-w", "/app", APP, "node", "--input-type=module", input=code))["count"] == 0, "Local posting is active"
    try:
        with (RELEASE / "publish.log").open("wb") as log:
            subprocess.run(compose(data, "release") + ["up", "-d", "--no-build", "--no-deps", "--pull", "never", "app"],
                           cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=100)
        verify(data)
    except Exception:
        with (RELEASE / "rollback.log").open("wb") as log:
            subprocess.run(compose(data, "rollback") + ["up", "-d", "--no-build", "--no-deps", "--pull", "never", "app"],
                           cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=100)
        core.ready(data["app"]["imageId"])
        save("rollback-result.json", {"restored": True})
        raise


if __name__ == "__main__":
    {"prepare": prepare, "apply": apply}[sys.argv[1]]()
