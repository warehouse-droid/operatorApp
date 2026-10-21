"""Capture the live source for a one-module fulfillment evidence correction."""
import importlib.util
import io
import difflib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
RELEASE = SERVER / "deployments/split-fulfillment-evidence-20261020"
MODULE = "src/sales-order-auto-fulfillment-repository.js"
spec = importlib.util.spec_from_file_location(
    "release_core", SERVER / "tools/operator-display-settings-deploy.py")
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
IMAGE = "mbbs-operator-app:split-fulfillment-evidence-20261020"


def capture():
    RELEASE.mkdir(exist_ok=False)
    before = core.metadata(core.APP)
    baseline = RELEASE / "before"
    baseline.mkdir()
    for name in ["src", "public", "migrations", "package.json", "package-lock.json"]:
        archive_bytes = core.docker("cp", core.APP + ":/app/" + name, "-")
        with tarfile.open(fileobj=io.BytesIO(archive_bytes)) as archive:
            archive.extractall(baseline, filter="data")
    assert before == core.metadata(core.APP), "Live application changed during capture."
    assert (baseline / MODULE).read_bytes() == (SERVER / MODULE).read_bytes()
    shutil.copytree(baseline, RELEASE / "candidate")
    shutil.copytree(SERVER / "test", RELEASE / "tests")
    for name in [".c8rc.json", "eslint.mbt.config.js", "tsconfig.mbt.json"]:
        shutil.copy2(SERVER / name, RELEASE / name)
    data = {
        "before": before,
        "dependencies": {name: core.metadata(name) for name in core.DEPENDENCIES},
        "module": MODULE,
        "baselineHash": core.digest((baseline / MODULE).read_bytes()),
        "beforeTree": core.files_at(baseline),
    }
    (RELEASE / "capture.json").write_text(json.dumps(data, indent=2) + "\n")
    print(json.dumps({"captured": True, "image": before["image"], "module": MODULE}))


def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + "\n")


def current(data):
    assert core.metadata(core.APP) == data["before"], "Live application changed; recapture before release."
    assert {name: core.metadata(name) for name in core.DEPENDENCIES} == data["dependencies"]
    actual = core.docker("exec", core.APP, "sha256sum", "/app/" + MODULE).decode().split()[0]
    assert actual == data["baselineHash"], "Live posting module changed."


def check_results():
    result = json.loads((RELEASE / "evidence/final/result.json").read_text())
    baseline = json.loads((RELEASE / "evidence/baseline/result.json").read_text())
    assert result["sourceHash"] == core.digest((RELEASE / "candidate" / MODULE).read_bytes())
    assert all(row["exit"] == 0 for row in result["results"]
               if row["label"] in ["regression", "syntax", "coverage"])
    assert len([row for row in result["results"]
                if row["label"].startswith("mutant-") and row["failed"] and row["tests"] == 13]) == 5
    assert all(row["covered"] for row in json.loads((RELEASE / "evidence/final/changed-lines.json").read_text()))
    for label in ["subsystem", "lint", "types"]:
        old = (RELEASE / f"evidence/baseline/{label}.log").read_text()
        new = (RELEASE / f"evidence/final/{label}.log").read_text()
        if label == "subsystem":
            old_failures = [line.split(" - ", 1)[1] for line in old.splitlines() if line.startswith("not ok ")]
            new_failures = [line.split(" - ", 1)[1] for line in new.splitlines() if line.startswith("not ok ")]
            assert old_failures == new_failures, (label, old_failures, new_failures)
        elif any(row["label"] == label and row["exit"] != 0 for row in result["results"]):
            # Existing diagnostics must be unchanged in the deployed module.
            normalize = lambda value: [
                line.strip() for line in value.splitlines()
                if ("error" in line.lower() or "warning" in line.lower()) and line.strip()
            ]
            assert normalize(old) == normalize(new), label + " introduced diagnostics"
    assert baseline["sourceHash"] != result["sourceHash"]
    return result


def prepare():
    data = json.loads((RELEASE / "capture.json").read_text())
    current(data)
    check_results()
    before, candidate = RELEASE / "before", RELEASE / "candidate"
    tree = core.files_at(candidate)
    changed = sorted(file for file in tree if tree[file] != data["beforeTree"].get(file))
    assert changed == [MODULE], changed
    assert (SERVER / MODULE).read_bytes() == (candidate / MODULE).read_bytes()
    patch = "".join(difflib.unified_diff((before / MODULE).read_text().splitlines(True),
        (candidate / MODULE).read_text().splitlines(True), fromfile="a/" + MODULE, tofile="b/" + MODULE))
    (RELEASE / "changes.patch").write_text(patch)
    parent = "mbbs-operator-app:split-if-parent-" + data["before"]["imageId"].removeprefix("sha256:")[:12]
    core.docker("tag", data["before"]["imageId"], parent)
    stage = RELEASE / "stage"
    (stage / "src").mkdir(parents=True, exist_ok=True)
    shutil.copy2(candidate / MODULE, stage / MODULE)
    (stage / "Dockerfile").write_text("FROM " + parent + "\nCOPY --chown=node:node " + MODULE + " /app/" + MODULE + "\n")
    with (RELEASE / "build.log").open("wb") as log:
        subprocess.run(["docker", "build", "--network", "none", "--pull=false", "-t", IMAGE, str(stage)],
            stdout=log, stderr=subprocess.STDOUT, check=True)
    data["imageId"] = core.docker("image", "inspect", "--format", "{{.Id}}", IMAGE).decode().strip()
    data["sourceHash"] = tree[MODULE]
    verification = ["run", "--rm", "--init", "--network", "none", "--read-only",
        "--cgroup-parent=mbbs-tests.slice", "--memory=256m", "--memory-swap=256m",
        "--cpus=0.5", "--pids-limit=64", "--tmpfs=/tmp:size=32m",
        "--label=com.mbbs.lifecycle=disposable-test", "--label=com.mbbs.task=split-if-image",
        "-e", "MBBS_ENV_FILE=/nonexistent", "-e", "NETSUITE_DIRECT_ACCESS_ENABLED=false",
        "-e", "NETSUITE_MIRROR_ROLE=disabled", "--entrypoint", "node", IMAGE, "--input-type=module", "-e"]
    code = """import {readdirSync,readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
const hashes={};function walk(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){
const file=dir+'/'+entry.name;if(entry.isDirectory())walk(file);else if(entry.isFile())
hashes[file]=createHash('sha256').update(readFileSync(file)).digest('hex');}}
for(const dir of ['src','public','migrations'])walk(dir);
await import('./src/sales-order-auto-fulfillment-repository.js');
const ordered=Object.fromEntries(Object.keys(hashes).sort().map(key=>[key,hashes[key]]));
console.log(createHash('sha256').update(JSON.stringify(ordered)).digest('hex'));process.exit(0);"""
    actual = core.docker(*verification, code).decode().strip()
    expected = core.digest(json.dumps(tree, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode())
    assert actual == expected, "Release changed unrelated files"
    current(data)
    for kind, image in [("release", IMAGE), ("rollback", data["before"]["imageId"])]:
        (RELEASE / f"compose.{kind}.yml").write_text(f"services:\n  app:\n    image: {image}\n")
    save("manifest.json", data)
    print(json.dumps({"prepared": True, "changed": changed, "image": IMAGE, "smokePassed": True}))


def publish():
    data = json.loads((RELEASE / "manifest.json").read_text())
    current(data)
    check_results()
    assert core.digest((RELEASE / "candidate" / MODULE).read_bytes()) == data["sourceHash"]
    args = ["sudo", "-n", "docker", "compose", "--project-directory", str(ROOT), "--env-file", str(ROOT / "docker/env/.env")]
    for filename in data["before"]["configFiles"].split(","):
        args.extend(["-f", filename])
    def apply(override):
        result = subprocess.run(args + ["-f", str(RELEASE / f"compose.{override}.yml"),
            "up", "-d", "--no-deps", "--no-build", "app"], capture_output=True, text=True)
        (RELEASE / f"{override}.log").write_text(result.stdout + result.stderr)
        if result.returncode:
            raise RuntimeError(f"Compose {override} failed; inspect {override}.log.")
    try:
        apply("release")
        core.ready(data["imageId"])
        after = core.metadata(core.APP)
        assert after["configuration"] == data["before"]["configuration"]
        assert {name: core.metadata(name) for name in core.DEPENDENCIES} == data["dependencies"]
        assert core.docker("exec", core.APP, "sha256sum", "/app/" + MODULE).decode().split()[0] == data["sourceHash"]
        save("published.json", {"healthy": True, "after": after, "sourceHash": data["sourceHash"],
            "configurationPreserved": True, "dependenciesUnchanged": True})
        print(json.dumps({"published": True, "healthy": True, "image": IMAGE}))
    except Exception:
        if core.metadata(core.APP)["imageId"] != data["before"]["imageId"]:
            apply("rollback")
            core.ready(data["before"]["imageId"])
            save("rollback.json", {"rolledBack": True})
        raise


if __name__ == "__main__":
    {"capture": capture, "prepare": prepare, "publish": publish}[sys.argv[1]]()
