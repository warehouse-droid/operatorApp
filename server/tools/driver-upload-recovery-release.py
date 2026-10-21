#!/usr/bin/env python3
"""Ship only upload recovery and the requested GPS radius on the live image."""
import atexit
import difflib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tarfile

SERVER = Path(__file__).resolve().parents[1]
TASK = SERVER / "test-artifacts/driver-upload-recovery-20261015"
RELEASE = SERVER / "deployments/driver-upload-recovery-20261015"
IMAGE = "mbbs-operator-app:driver-upload-recovery-20261015"
FILES = ["public/driver.js", "public/driver-upload.js", "public/driver.html", "public/driver-service-worker.js", "src/server.js"]
spec = importlib.util.spec_from_file_location("recovery_release", SERVER / "tools/delivery-timeslot-notifications-release.py")
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
base.TASK, base.RELEASE, base.IMAGE = TASK, RELEASE, IMAGE
core = base.core
core.RELEASE, core.IMAGE, core.ROLLBACK = RELEASE, IMAGE, IMAGE + "-rollback"
core.READ_NAME, core.CHECK_NAME = "mbbs-driver-recovery-reader", "mbbs-driver-recovery-image-check"


def gps_function(source):
    start = source.index("async function checkDriverJobLocation(job)")
    end = source.index("\nasync function ", start + 1)
    return source[start:end]


def capture():
    os.umask(0o077)
    before = core.metadata(core.APP)
    dependencies = [core.metadata(name) for name in core.DEPENDENCIES]
    RELEASE.mkdir(parents=True, exist_ok=False)
    baseline = RELEASE / "before"
    baseline.mkdir()
    archive = core.docker("exec", core.APP, "tar", "-cf", "-", "-C", "/app", "src", "public", "migrations", "package.json", "package-lock.json")
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(baseline, filter="data")
    assert core.metadata(core.APP) == before
    candidate = RELEASE / "candidate"
    shutil.copytree(baseline, candidate)
    for name in FILES:
        original = (baseline / name).read_text()
        if name == "src/server.js":
            function = gps_function(original)
            assert function.count("const thresholdMeters = 500;") == 1
            replacement = function.replace("const thresholdMeters = 500;", "const thresholdMeters = 1000;")
            assert gps_function((SERVER / name).read_text()) == replacement, "GPS implementation differs from tested function"
            (candidate / name).write_text(original.replace(function, replacement))
        else:
            assert core.sha((baseline / name).read_bytes()) == core.sha((TASK / "baseline" / name).read_bytes()), "Driver runtime changed since investigation: " + name
            shutil.copy2(SERVER / name, candidate / name)
    before_tree, after_tree = core.files_at(baseline), core.files_at(candidate)
    changed = sorted(name for name in before_tree.keys() | after_tree.keys() if before_tree.get(name) != after_tree.get(name))
    assert changed == sorted(FILES)
    patch = "".join("".join(difflib.unified_diff((baseline / name).read_text().splitlines(True),
        (candidate / name).read_text().splitlines(True), fromfile="a/" + name, tofile="b/" + name, n=0)) for name in FILES)
    (RELEASE / "changes.patch").write_text(patch)
    for directory, _directories, files in os.walk(RELEASE):
        os.chmod(directory, 0o755)
        for filename in files:
            os.chmod(Path(directory) / filename, 0o644)
    data = {"capturedAt": core.now(), "app": before, "dependencies": dependencies,
        "files": changed, "beforeTree": before_tree, "candidateTree": after_tree,
        "candidateTreeHash": core.sha(json.dumps(after_tree, sort_keys=True).encode()),
        "workspace": {name: core.sha((SERVER / name).read_bytes()) for name in FILES},
        "packages": {name: core.sha((candidate / name).read_bytes()) for name in ["package.json", "package-lock.json"]}}
    core.save("manifest.json", data)
    core.current(data)
    print(json.dumps({"captured": True, "files": FILES, "unrelatedRuntimeFilesPreserved": len(before_tree) - len(FILES)}), flush=True)


def tested_inputs():
    data = core.state()
    evidence = json.loads((TASK / "evidence.json").read_text())
    assert evidence["passed"] is True
    assert evidence["candidateTreeHash"] == data["candidateTreeHash"]
    for name in FILES:
        assert evidence["runtimeHashes"][name] == data["candidateTree"][name]
    return data["workspace"]


def validate():
    data = core.state()
    core.current(data)
    tested_inputs()
    core.save("validation-passed.json", {"passed": True, "at": core.now(), "candidateTreeHash": data["candidateTreeHash"]})
    print(json.dumps({"validated": True}), flush=True)


def verify():
    data = core.state()
    core.ready(data["candidateImageId"])
    live = core.metadata(core.APP)
    assert live["imageId"] == data["candidateImageId"]
    assert live["configuration"] == data["app"]["configuration"]
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data["dependencies"]
    actual = json.loads(core.docker("exec", core.APP, "node", "-e", core.HASH_SCRIPT))
    assert actual == data["candidateTree"]
    http = core.http_check({name: actual[name] for name in FILES if name.startswith("public/")}, [])
    script = r"""import assert from 'node:assert/strict';
const version='20261015-driver-upload-recovery-v1';
for(const origin of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
  const html=await (await fetch(origin+'/driver',{signal:AbortSignal.timeout(15000)})).text();
  assert.ok(html.includes('/driver.js?v='+version));assert.ok(html.includes('/driver-upload.js?v='+version));
  const missingVersion=await fetch(origin+'/api/driver/next-job',{signal:AbortSignal.timeout(15000)});
  assert.equal(missingVersion.status,426);
  const unauthenticated=await fetch(origin+'/api/driver/next-job',{headers:{'X-MBBS-Driver-Version':'2026.08.12.3'},signal:AbortSignal.timeout(15000)});
  assert.equal(unauthenticated.status,401);
}
console.log(JSON.stringify({driverPageVersionVerified:true,driverVersionGatePreserved:true,driverAuthenticationPreserved:true}));
"""
    page = json.loads(core.docker("exec", "-i", core.APP, "node", "--input-type=module", input=script.encode(), timeout=60))
    result = {"deployed": True, "at": core.now(), "image": IMAGE, "imageId": live["imageId"],
        "candidateTreeHash": data["candidateTreeHash"], "changedFiles": FILES, "gpsRadiusMetres": 1000,
        "driverShell": "v46", "configurationPreserved": True, "dependenciesPreserved": True,
        "schemaChanged": False, "runtimeFilesVerified": len(actual), "http": http, **page}
    core.save("deployment-result.json", result)
    print(json.dumps(result), flush=True)


def acknowledge_rollback():
    data = core.state()
    rollback = json.loads((RELEASE / "rollback-result.json").read_text())
    live = core.metadata(core.APP)
    assert rollback["restoredImageId"] == live["imageId"] == data["app"]["imageId"]
    assert live["configuration"] == data["app"]["configuration"]
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data["dependencies"]
    assert json.loads(core.docker("exec", core.APP, "node", "-e", core.HASH_SCRIPT)) == data["beforeTree"]
    core.save("manifest-before-verification-header-fix.json", data)
    data["app"] = live
    core.save("manifest.json", data)
    core.current(data)
    print(json.dumps({"rollbackVerified": True, "candidateUnchanged": True}), flush=True)


base.tested_inputs, base.verify = tested_inputs, verify
if __name__ == "__main__":
    atexit.register(core.cleanup_manual)
    {"capture": capture, "validate": validate, "build": core.build, "apply": base.apply, "verify": verify,
     "acknowledge-rollback": acknowledge_rollback}[sys.argv[1]]()
