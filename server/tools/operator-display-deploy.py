"""Package and deploy only the approved Delivery Prep display fix."""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("release_core", SERVER / "tools/operator-display-settings-deploy.py")
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE = Path("/home/ubuntu/operatorapp-deploy-backups/operator-display-refresh-20260918-v1")
core.BEFORE = SERVER / "test-artifacts/operator-display-fix/baseline"
core.IMAGE = "mbbs-operator-app:operator-display-refresh-20260918-v1"
core.ROLLBACK = "mbbs-operator-app:rollback-operator-display-refresh-20260918-v1"
core.EXISTING = ["public/operator.js", "public/operator.html", "public/service-worker.js",
                 "src/operator-linked-quantity-domain.js", "src/delivery-repository.js"]
core.ADDED = ["public/operator-delivery-refresh.js"]
core.FILES = sorted(core.EXISTING + core.ADDED)
VERSION = "20260918-display-refresh-v1"


def source_gate():
    artifacts = SERVER / "test-artifacts/operator-display-fix/final"
    for file, expected in json.loads((artifacts / "source.json").read_text()).items():
        assert core.digest((SERVER / file).read_bytes()) == expected, "Verified workspace changed: " + file
    assert json.loads((artifacts / "full-comparison.json").read_text())["unexpected"] == []
    assert all(row["killed"] for row in json.loads((artifacts / "mutations.json").read_text()))
    assert all(not row["missing"] for row in json.loads((artifacts / "changed-coverage.json").read_text()))


def shell_assets(file, text):
    text, count = re.subn(r'/operator\.js\?v=[^"\s]+', '/operator.js?v=' + VERSION, text)
    assert count == 1
    assert "operator-delivery-refresh.js" not in text
    if file.endswith(".html"):
        anchor = '    <script src="/operator.js?v=' + VERSION + '"></script>'
        assert text.count(anchor) == 1
        text = text.replace(anchor, '    <script src="/operator-delivery-refresh.js?v=' + VERSION + '"></script>\n' + anchor)
    else:
        text, count = re.subn(r'const CACHE_NAME = "[^"]+";', 'const CACHE_NAME = "mbbs-yard-operator-' + VERSION + '";', text)
        assert count == 1
        anchor = '  "/operator.js?v=' + VERSION + '",'
        assert text.count(anchor) == 1
        text = text.replace(anchor, '  "/operator-delivery-refresh.js?v=' + VERSION + '",\n' + anchor)
    return text


core.shell_assets = shell_assets


def prepare():
    source_gate()
    core.prepare()
    candidate = core.RELEASE / "candidate"
    # Test-only mounts are not included in the six-file image overlay.
    for name in ["test", "tools", "contracts"]:
        (candidate / name).symlink_to(SERVER / name, target_is_directory=True)
    for pattern in ["*.js", "*.json", "Dockerfile*"]:
        for path in SERVER.glob(pattern):
            if not (candidate / path.name).exists():
                shutil.copy2(path, candidate / path.name)


def check():
    state = core.manifest()
    source_gate()
    core.current(state)
    env = {**os.environ, "DISPLAY_FIX_SOURCE_ROOT": str(core.RELEASE / "candidate"),
           "DISPLAY_FIX_ARTIFACTS": "test-artifacts/operator-display-fix/deployment-browser"}
    catalog = (SERVER / "tools/operator-display-files.mjs").read_text()
    tests = []
    for name in ["unit", "database"]:
        tests.extend(json.loads(re.search(r"export const " + name + r" = (\[.*?\]);", catalog, re.S)[1]))
    commands = {
        "candidate-focused.log": ["db", "node", "--test", "--test-concurrency=1", *tests],
        "candidate-browser.log": ["browser", "node", "--test", "test/mbt/e2e/operator-delivery-refresh.test.js"],
    }
    for name, arguments in commands.items():
        with (core.RELEASE / name).open("wb") as output:
            subprocess.run(["sudo", "-n", "--preserve-env=DISPLAY_FIX_SOURCE_ROOT,DISPLAY_FIX_ARTIFACTS", "bash",
                            "tools/operator-display-test.sh", *arguments], cwd=SERVER, env=env,
                           stdout=output, stderr=subprocess.STDOUT, check=True)
        print(json.dumps({"passed": name}), flush=True)
    core.current(state)
    core.save("verified.json", {"passed": True, "imageId": state["candidateImageId"], "sources": state["after"]})


def live(after=False):
    state = core.manifest()
    runtime = json.loads(core.docker("inspect", core.APP))[0]
    environment = core.RELEASE / "live-env.private"
    environment.write_text("\n".join(runtime["Config"]["Env"]) + "\n")
    environment.chmod(0o600)
    network = next(iter(runtime["NetworkSettings"]["Networks"]))
    image_id = runtime["Image"] if after else state["candidateImageId"]
    try:
        result = json.loads(core.docker("run", "--rm", "--network", network, "--volumes-from", core.APP + ":ro",
            "--env-file", str(environment), "-v", str(SERVER / "tools/operator-display-live.mjs") + ":/app/display-live.mjs:ro",
            "--entrypoint", "node", image_id, "/app/display-live.mjs"))
        core.save("live-after.json" if after else "live-before.json", {**result, "imageId": image_id})
        print(json.dumps(result), flush=True)
        return result
    finally:
        environment.unlink()


def verify():
    state = core.manifest()
    core.ready(state["candidateImageId"])
    after = core.metadata(core.APP)
    assert after["configuration"] == state["app"]["configuration"], "Application configuration changed"
    assert [core.metadata(name) for name in core.DEPENDENCIES] == state["dependencies"], "Dependency changed"
    actual = core.docker("exec", core.APP, "sha256sum", *["/app/" + file for file in core.FILES]).decode().splitlines()
    assert {line.split()[1].removeprefix("/app/"): line.split()[0] for line in actual} == state["after"]
    assets = {file: sha for file, sha in state["after"].items() if file.startswith("public/")}
    script = """import assert from 'node:assert/strict'; import crypto from 'node:crypto';
for (const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
  for (const [file, expected] of Object.entries(ASSETS)) {
    const response = await fetch(base+'/'+file.replace(/^public\\//,''), {headers:{'Cache-Control':'no-cache'}});
    assert.equal(response.status,200,file);
    assert.equal(crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),expected,file);
  }
  const health=await fetch(base+'/health'); assert.equal(health.status,200); assert.equal((await health.json()).ok,true);
  assert.equal((await fetch(base+'/api/delivery/orders?locationId=1')).status,401);
}
console.log(JSON.stringify({health:200,anonymousDelivery:401,publicAssetsVerified:true}));
""".replace("ASSETS", json.dumps(assets))
    http = json.loads(core.docker("exec", "-i", core.APP, "node", "--input-type=module", input=script.encode()))
    data = live(after=True)
    result = {"deployed": True, "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "image": core.IMAGE, "imageId": after["imageId"], "configurationPreserved": True,
              "dependenciesUnchanged": True, "readOnlyOrderCheck": data["passed"], **http}
    core.save("deployment-result.json", result)
    print(json.dumps(result), flush=True)


def apply():
    source_gate()
    state = core.manifest()
    core.current(state)
    verified = json.loads((core.RELEASE / "verified.json").read_text())
    assert verified == {"passed": True, "imageId": state["candidateImageId"], "sources": state["after"]}
    assert json.loads((core.RELEASE / "live-before.json").read_text())["passed"]
    assert core.docker("image", "inspect", "--format", "{{.Id}}", core.IMAGE).decode().strip() == state["candidateImageId"]
    resolved = json.loads(subprocess.check_output(core.compose(state, "compose.release.yml") + ["config", "--format", "json"], cwd=core.ROOT))["services"]["app"]
    image = json.loads(core.docker("image", "inspect", state["candidateImageId"]))[0]["Config"]
    runtime = json.loads(core.docker("inspect", core.APP))[0]["Config"]
    expected = dict(entry.split("=", 1) for entry in image["Env"])
    expected.update({key: str(value) for key, value in resolved.get("environment", {}).items()})
    assert expected == dict(entry.split("=", 1) for entry in runtime["Env"]), "Compose would change environment"
    for field, option in [("Cmd", "command"), ("Entrypoint", "entrypoint"), ("User", "user"), ("WorkingDir", "working_dir")]:
        assert (image.get(field) if resolved.get(option) is None else resolved[option]) == runtime.get(field)
    active = core.database("SELECT (SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing')) + (SELECT count(*) FROM dispatch_sales_order_if_candidates WHERE status='posting');").strip()
    assert active == "0", "A fulfillment is actively posting; retry once it is idle"
    command = ["up", "-d", "--no-build", "--no-deps", "--pull", "never", "app"]
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    print(json.dumps({"cutoverStarted": started}), flush=True)
    try:
        with (core.RELEASE / "cutover.log").open("wb") as output:
            subprocess.run(core.compose(state, "compose.release.yml") + command, cwd=core.ROOT,
                           stdout=output, stderr=subprocess.STDOUT, check=True, timeout=100)
        verify()
        logs = core.docker("logs", "--since", started, core.APP, stderr=subprocess.STDOUT).decode()
        (core.RELEASE / "startup.log").write_text(logs)
        assert not re.search(r"SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND|uncaughtException", logs)
    except Exception:
        with (core.RELEASE / "rollback.log").open("wb") as output:
            subprocess.run(core.compose(state, "compose.rollback.yml") + command, cwd=core.ROOT,
                           stdout=output, stderr=subprocess.STDOUT, check=True, timeout=100)
        core.ready(state["app"]["imageId"])
        core.save("rolled-back.json", {"at": datetime.datetime.now(datetime.timezone.utc).isoformat()})
        raise


if __name__ == "__main__":
    os.umask(0o077)
    {"prepare": prepare, "build": core.build, "check": check, "preflight": live, "apply": apply, "verify": verify}[sys.argv[1]]()
