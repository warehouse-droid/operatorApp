"""Release the verified Edit Mode and grouping correction over the captured image."""
import datetime
import difflib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys

TASK = Path(__file__).resolve().parent
SERVER = TASK.parents[1]
ROOT = SERVER.parent
RELEASE = SERVER / "deployments/dispatch-grouping-reliability-20261020"
OUT = SERVER / "test-artifacts/dispatch-grouping-reliability-20261020"
IMAGE = "mbbs-operator-app:dispatch-grouping-reliability-20261020"
FILES = ["public/dispatch.js", "public/dispatch.html", "src/server.js", "src/dispatch-planner-v2-repository.js", "src/dispatch-delivery-group-repository.js"]
spec = importlib.util.spec_from_file_location("core", SERVER / "tools/operator-display-settings-deploy.py")
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)


def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + "\n")


def evidence():
    read = lambda name: json.loads((OUT / name).read_text())
    for mode in ["final", "health"]:
        result = read(mode + ".json")
        assert result["tests"] == 91 and result["pass"] == 90 and result["fail"] == 1
        assert result["failures"] == ["DP-33 frontend: active CO projection retains every current relationship pickup"]
    static = read("static.json")
    assert not static["newTypes"] and not static["newLint"]
    mutations = read("mutations.json")
    assert len(mutations["mutations"]) == 5 and all(row["killed"] for row in mutations["mutations"])
    coverage = read("changed-coverage.json")
    assert not coverage["missing"]
    for file, entry in coverage["files"].items():
        assert entry["sha256"] == core.digest((TASK / "candidate" / file).read_bytes())
    for mode in ["api-red", "final", "static", "mutations", "health"]:
        cleanup = read("cleanup-" + mode + ".json")
        assert cleanup["teardownExit"] == 0 and cleanup["productionHealthy"]
        assert not cleanup["ownTestContainers"] and not cleanup["networks"] and not cleanup["volumes"]


def current(data):
    assert core.metadata(core.APP) == data["app"], "Running application changed; rebase before release."
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data["dependencies"]
    for file in FILES:
        actual = core.docker("exec", core.APP, "sha256sum", "/app/" + file).decode().split()[0]
        assert actual == data["beforeTree"][file]
        assert core.digest((SERVER / file).read_bytes()) == json.loads((TASK / "workspace-merge.json").read_text())[file]


def compose(data, kind):
    args = ["sudo", "-n", "docker", "compose", "--project-directory", str(ROOT),
            "--env-file", str(ROOT / "docker/env/.env")]
    for filename in data["app"]["configFiles"].split(","):
        args.extend(["-f", filename])
    return args + ["-f", str(RELEASE / f"compose.{kind}.yml")]


def prepare():
    data = json.loads((TASK / "capture.json").read_text())
    evidence()
    current(data)
    RELEASE.mkdir(exist_ok=True)
    tree = core.files_at(TASK / "candidate")
    assert sorted(file for file in tree if tree[file] != data["beforeTree"].get(file)) == sorted(FILES)
    patch = ""
    for file in FILES:
        patch += "".join(difflib.unified_diff(
            (TASK / "baseline" / file).read_text().splitlines(True),
            (TASK / "candidate" / file).read_text().splitlines(True),
            fromfile="a/" + file, tofile="b/" + file))
    (RELEASE / "changes.patch").write_text(patch)
    parent = "mbbs-operator-app:edit-group-parent-" + data["app"]["imageId"].removeprefix("sha256:")[:12]
    core.docker("tag", data["app"]["imageId"], parent)
    stage = RELEASE / "stage"
    (stage / "public").mkdir(parents=True, exist_ok=True)
    for file in FILES:
        (stage / file).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(TASK / "candidate" / file, stage / file)
    (stage / "Dockerfile").write_text("FROM " + parent + "\n" + "".join(
        "COPY --chown=node:node " + file + " /app/" + file + "\n" for file in FILES))
    with (RELEASE / "build.log").open("wb") as log:
        subprocess.run(["sudo", "-n", "docker", "build", "--network=none", "--pull=false",
            "-t", IMAGE, str(stage)], stdout=log, stderr=subprocess.STDOUT, check=True)
    data["imageId"] = core.docker("image", "inspect", "--format", "{{.Id}}", IMAGE).decode().strip()
    code = """const {readdirSync,readFileSync}=require('node:fs'),{createHash}=require('node:crypto');
const hashes={};function walk(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){
const file=dir+'/'+entry.name;if(entry.isDirectory())walk(file);else if(entry.isFile())
hashes[file]=createHash('sha256').update(readFileSync(file)).digest('hex');}}
for(const dir of ['src','public','migrations'])walk(dir);
const ordered=Object.fromEntries(Object.keys(hashes).sort().map(key=>[key,hashes[key]]));
console.log(createHash('sha256').update(JSON.stringify(ordered)).digest('hex'));"""
    try:
        actual = core.docker("run", "--name", "mbbs-grouping-image-check", "--rm", "--init", "--network", "none", "--read-only",
        "--cgroup-parent=mbbs-tests.slice", "--memory=256m", "--memory-swap=256m",
        "--cpus=0.5", "--pids-limit=64", "--tmpfs=/tmp:size=32m",
        "--label=com.mbbs.lifecycle=disposable-test", "--label=com.mbbs.task=edit-group-image",
        "--entrypoint", "node", IMAGE, "-e", code).decode().strip()
    finally:
        subprocess.run(["sudo", "-n", "docker", "rm", "-f", "-v", "mbbs-grouping-image-check"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        save("image-check-cleanup.json", {"dockerPs": core.docker("ps", "--format", "{{.Names}} {{.Status}}").decode(),
            "dockerPsA": core.docker("ps", "-a", "--format", "{{.Names}} {{.Status}}").decode()})
    expected = core.digest(json.dumps(tree, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode())
    assert actual == expected, "Image differs from tested source"
    data["treeHash"] = expected
    data["after"] = {file: tree[file] for file in FILES}
    for kind, image in [("release", IMAGE), ("rollback", data["app"]["imageId"])]:
        (RELEASE / f"compose.{kind}.yml").write_text(f"services:\n  app:\n    image: {image}\n")
    before = json.loads(subprocess.check_output(compose(data, "rollback") + ["config", "--format", "json"]))
    after = json.loads(subprocess.check_output(compose(data, "release") + ["config", "--format", "json"]))
    before["services"]["app"].pop("image")
    assert after["services"]["app"].pop("image") == IMAGE
    assert before == after
    current(data)
    save("manifest.json", data)
    print(json.dumps({"prepared": True, "files": FILES, "image": IMAGE, "sourceTreeVerified": True}))


def verify(data):
    core.ready(data["imageId"])
    after = core.metadata(core.APP)
    assert after["configuration"] == data["app"]["configuration"]
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data["dependencies"]
    for file in FILES:
        assert core.docker("exec", core.APP, "sha256sum", "/app/" + file).decode().split()[0] == data["after"][file]
    code = """const {createHash}=require('node:crypto');(async()=>{const result={};
for(const file of ['dispatch.js','dispatch.html']){const r=await fetch('http://127.0.0.1:3000/'+file+'?v=20261020-split-draft-identity-v1');
if(!r.ok)throw Error(file);result['public/'+file]=createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex');}
console.log(JSON.stringify(result));})().catch(e=>{console.error(e.message);process.exitCode=1});"""
    served = json.loads(core.docker("exec", core.APP, "node", "-e", code))
    assert served == {key: value for key, value in data["after"].items() if key.startswith("public/")}
    result = {"published": True, "healthy": True, "image": IMAGE,
        "configurationPreserved": True, "dependenciesUnchanged": True, "served": served,
        "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "dockerPs": core.docker("ps", "--format", "{{.Names}}\t{{.Status}}").decode(),
        "dockerPsA": core.docker("ps", "-a", "--format", "{{.Names}}\t{{.Status}}").decode()}
    save("published.json", result)
    print(json.dumps({key: value for key, value in result.items() if key not in ["dockerPs", "dockerPsA"]}))


def publish():
    data = json.loads((RELEASE / "manifest.json").read_text())
    evidence()
    current(data)
    active = core.docker("exec", "-i", core.APP, "node", "--input-type=module", input=b"""
import {pool,query,closeDb} from '/app/src/db.js';
pool.options.options='-c default_transaction_read_only=on -c statement_timeout=15000';
try{console.log(JSON.stringify((await query("SELECT count(*)::int AS count FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing')")).rows[0]));}
finally{await closeDb();}""")
    assert json.loads(active)["count"] == 0, "Posting is in progress; defer restart."
    def apply(kind):
        with (RELEASE / (kind + ".log")).open("wb") as log:
            result = subprocess.run(compose(data, kind) + ["up", "-d", "--no-deps", "--no-build", "app"],
                cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, timeout=100)
        assert result.returncode == 0, kind + " failed; see release log"
    try:
        apply("release")
        verify(data)
    except Exception:
        apply("rollback")
        core.ready(data["app"]["imageId"])
        save("rollback.json", {"previousImageRestored": True})
        raise


if __name__ == "__main__":
    {"prepare": prepare, "publish": publish}[sys.argv[1]]()
