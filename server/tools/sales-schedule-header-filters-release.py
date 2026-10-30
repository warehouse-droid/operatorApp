"""Deploy the Sales schedule header filters over the current live image."""
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
RELEASE = SERVER / "deployments/sales-schedule-header-filters-20261021"
IMAGE = "mbbs-operator-app:sales-schedule-header-filters-20261021"
APP = "mbbs-operator-app-app-1"
DEPENDENCIES = ["mbbs-operator-app-db-1", "mbbs-operator-app-webhook-worker-1", "mbbs-operator-app-ollama-1"]
FILES = ["public/scm-schedule.js", "public/scm-schedule.html", "src/server.js"]
TESTED_HASHES = {
    "public/scm-schedule.js": "e77767c5ca6b110f3e02a0850d87788a5266a6ccad9ff05d48f604fd8e742950",
    "public/scm-schedule.html": "144152844a9a6a9fa81e0dcc1170d5fca9fd8dbc8222015126ecdf0e8abe40a8",
    "src/server.js": "01e10e12e3e9c38077a9cbc2d2dcc7d10ddeddde83a8b234b52fb06d50bc8cb6",
}
spec = importlib.util.spec_from_file_location("release_core", SERVER / "tools/operator-display-settings-deploy.py")
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
docker, metadata = core.docker, core.metadata


def digest(value):
    return hashlib.sha256(value).hexdigest()


def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + "\n")


def manifest():
    return json.loads((RELEASE / "manifest.json").read_text())


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
    for name in FILES:
        assert digest((SERVER / name).read_bytes()) == TESTED_HASHES[name], "Tested workspace source changed: " + name
        assert digest(live(name)) == data["beforeHashes"][name], "Live file changed: " + name
        assert digest((RELEASE / "candidate" / name).read_bytes()) == data["sourceHashes"][name]


def route(source):
    start = source.index('app.get("/api/sales/schedule",')
    end = source.index('app.get("/api/sales/schedule-preferences",', start)
    return source[start:end]


def prepare():
    os.umask(0o077)
    RELEASE.mkdir(parents=True, exist_ok=False)
    data = {"app": metadata(APP), "dependencies": [metadata(name) for name in DEPENDENCIES],
            "beforeHashes": {}, "sourceHashes": {}, "workspaceHashes": TESTED_HASHES,
            "verification": {"scheduleRegressionChecks": 37, "salesBrowserContexts": ["signed-in", "public"]}}
    for name in FILES:
        old = live(name)
        baseline = subprocess.check_output(["git", "show", "HEAD:server/" + name], cwd=ROOT)
        new = (SERVER / name).read_bytes()
        assert digest(new) == TESTED_HASHES[name], "Tested source changed: " + name
        for folder in ["before", "candidate"]:
            path = RELEASE / folder / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(old)
        if name != "src/server.js":
            assert old == baseline, "Live UI changed since implementation: " + name
            (RELEASE / "candidate" / name).write_bytes(new)
        data["beforeHashes"][name] = digest(old)
    patch = subprocess.check_output(["git", "diff", "--", "server/src/server.js"], cwd=ROOT)
    (RELEASE / "server.patch").write_bytes(patch)
    result = subprocess.run(["patch", "--batch", "--fuzz=0", "--no-backup-if-mismatch", "-p2", "-d", str(RELEASE / "candidate")],
                            input=patch, capture_output=True)
    (RELEASE / "patch.log").write_bytes(result.stdout + result.stderr)
    assert result.returncode == 0, "Server patch requires review"
    candidate_server = (RELEASE / "candidate/src/server.js").read_text()
    assert route(candidate_server) == route((SERVER / "src/server.js").read_text()), "Sales route differs from tested source"
    before_server = (RELEASE / "before/src/server.js").read_text()
    assert candidate_server.replace(route(candidate_server), route(before_server), 1) == before_server, "Unrelated live server code changed"
    data["sourceHashes"] = {name: digest((RELEASE / "candidate" / name).read_bytes()) for name in FILES}
    current(data)
    base = "mbbs-operator-app:sales-filter-base-" + data["app"]["imageId"].split(":")[-1][:12]
    docker("tag", data["app"]["imageId"], base)
    (RELEASE / "candidate/Dockerfile").write_text("FROM " + base + "\n" + "".join(
        f"COPY --chown=node:node {name} /app/{name}\n" for name in FILES))
    (RELEASE / "compose.release.yml").write_text("services:\n  app:\n    image: " + IMAGE + "\n")
    (RELEASE / "compose.rollback.yml").write_text("services:\n  app:\n    image: " + data["app"]["imageId"] + "\n")
    with (RELEASE / "build.log").open("wb") as log:
        subprocess.run(["sudo", "-n", "docker", "build", "--pull=false", "--network=none", "-t", IMAGE,
                        str(RELEASE / "candidate")], stdout=log, stderr=subprocess.STDOUT, check=True, timeout=120)
    data["candidateImageId"] = docker("image", "inspect", "--format", "{{.Id}}", IMAGE).decode().strip()
    previous = json.loads(subprocess.check_output(compose(data, "rollback") + ["config", "--format", "json"], cwd=ROOT))
    resolved = json.loads(subprocess.check_output(compose(data, "release") + ["config", "--format", "json"], cwd=ROOT))
    previous["services"]["app"].pop("image")
    assert resolved["services"]["app"].pop("image") == IMAGE
    assert previous == resolved, "Compose configuration would change"
    actual = json.loads(docker("inspect", APP))[0]["Config"]
    image_config = json.loads(docker("image", "inspect", IMAGE))[0]["Config"]
    app_config = resolved["services"]["app"]
    expected_env = dict(item.split("=", 1) for item in image_config.get("Env", []))
    expected_env.update({key: str(value) for key, value in app_config.get("environment", {}).items()})
    assert expected_env == dict(item.split("=", 1) for item in actual.get("Env", [])), "Environment drift"
    for field, key in [("Cmd", "command"), ("Entrypoint", "entrypoint"), ("User", "user"), ("WorkingDir", "working_dir")]:
        value = app_config.get(key)
        assert (image_config.get(field) if value is None else value) == actual.get(field), "Runtime drift: " + field
    current(data)
    save("manifest.json", data)
    print(json.dumps({"prepared": True, "image": IMAGE, "changedFiles": FILES, "unrelatedLiveServerCodePreserved": True}), flush=True)


def verify(data):
    core.ready(data["candidateImageId"])
    actual = metadata(APP)
    assert actual["imageId"] == data["candidateImageId"]
    assert actual["configuration"] == data["app"]["configuration"]
    assert [metadata(name) for name in DEPENDENCIES] == data["dependencies"]
    for name, expected in data["sourceHashes"].items():
        assert digest(live(name)) == expected, "Runtime source mismatch: " + name
    http = []
    for base in ["http://127.0.0.1:3000", "https://test.mbbsoperation.com"]:
        for path, name in [("/sales/schedule", "public/scm-schedule.html"),
                           ("/scm-schedule.js?v=20261021-sales-header-filters-v1", "public/scm-schedule.js")]:
            served = subprocess.check_output(["curl", "-fsS", "--max-time", "20", "--retry", "2", base + path])
            assert digest(served) == data["sourceHashes"][name], "Served source mismatch: " + base + path
            http.append({"url": base + path, "status": 200, "hashMatches": True})
        health = json.loads(subprocess.check_output(["curl", "-fsS", "--max-time", "20", base + "/health"]))
        assert health["ok"] is True
    result = {"deployed": True, "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "image": IMAGE, "imageId": actual["imageId"], "changedFiles": FILES,
              "configurationPreserved": True, "dependenciesUnchanged": True, "schemaChanged": False,
              "sourceHashes": data["sourceHashes"], "http": http,
              "dockerPs": docker("ps", "--format", "{{.Names}} {{.Status}}").decode(),
              "dockerPsA": docker("ps", "-a", "--format", "{{.Names}} {{.Status}}").decode()}
    assert not docker("ps", "-aq", "--filter", "label=com.mbbs.lifecycle=disposable-test").strip()
    save("deployment-result.json", result)
    print(json.dumps(result), flush=True)


def apply():
    data = manifest()
    validation = json.loads((RELEASE / "validation.json").read_text())
    assert validation["passed"] and validation["cleanupVerified"]
    assert validation["sourceHashes"] == data["sourceHashes"]
    assert validation["imageId"] == data["candidateImageId"]
    current(data)
    assert docker("image", "inspect", "--format", "{{.Id}}", IMAGE).decode().strip() == data["candidateImageId"]
    query = b"import {query,closeDb} from './src/db.js';try{console.log(JSON.stringify((await query(\"SELECT count(*)::int AS count FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing')\")).rows[0]));}finally{await closeDb();}"
    active = json.loads(docker("exec", "-i", "-w", "/app", APP, "node", "--input-type=module", input=query))
    save("active-before-release.json", active)
    assert active["count"] == 0, "Wait for local posting to finish"
    current(data)
    try:
        with (RELEASE / "publish.log").open("wb") as log:
            subprocess.run(compose(data, "release") + ["up", "-d", "--no-build", "--no-deps", "--pull", "never", "app"],
                           cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=100)
        verify(data)
    except BaseException:
        with (RELEASE / "rollback.log").open("wb") as log:
            subprocess.run(compose(data, "rollback") + ["up", "-d", "--no-build", "--no-deps", "--pull", "never", "app"],
                           cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=100)
        core.ready(data["app"]["imageId"])
        save("rollback-result.json", {"restored": True})
        raise


if __name__ == "__main__":
    {"prepare": prepare, "apply": apply, "verify": lambda: verify(manifest())}[sys.argv[1]]()
