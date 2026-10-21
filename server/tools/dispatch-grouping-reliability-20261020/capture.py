"""Snapshot the running source without pulling unrelated workspace edits."""
import importlib.util
import io
import json
from pathlib import Path
import shutil
import tarfile

TASK = Path(__file__).resolve().parent
SERVER = TASK.parents[1]
spec = importlib.util.spec_from_file_location("core", SERVER / "tools/operator-display-settings-deploy.py")
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)

before = core.metadata(core.APP)
baseline = TASK / "baseline"
baseline.mkdir(exist_ok=False)
for name in ["src", "public", "migrations", "package.json", "package-lock.json"]:
    archive_bytes = core.docker("cp", core.APP + ":/app/" + name, "-")
    with tarfile.open(fileobj=io.BytesIO(archive_bytes)) as archive:
        archive.extractall(baseline, filter="data")
assert before == core.metadata(core.APP)
shutil.copytree(baseline, TASK / "candidate")
shutil.copytree(SERVER / "test", TASK / "tests")
workspace = TASK / "workspace-before"
workspace.mkdir()
for name in ["dispatch.js", "dispatch.html"]:
    shutil.copy2(SERVER / "public" / name, workspace / name)
data = {"app": before, "dependencies": [core.metadata(name) for name in core.DEPENDENCIES],
        "beforeTree": core.files_at(baseline),
        "workspace": {name: core.digest((workspace / name).read_bytes()) for name in ["dispatch.js", "dispatch.html"]}}
(TASK / "capture.json").write_text(json.dumps(data, indent=2) + "\n")
print(json.dumps({"captured": True, "image": before["image"],
                  "workspaceMatchesLive": {name: (workspace / name).read_bytes() == (baseline / "public" / name).read_bytes()
                    for name in ["dispatch.js", "dispatch.html"]}}))
