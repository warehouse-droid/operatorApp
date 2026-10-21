#!/usr/bin/env python3
"""Validate and deploy the sound/taskbar-badge follow-up over the live image."""
import atexit
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
TASK = SERVER / "test-artifacts/app-notification-attention-20261014"
RELEASE = SERVER / "deployments/app-notification-attention-20261014"
OUT = TASK / "release-final"
IMAGE = "mbbs-operator-app:app-notification-attention-20261014"
FILES = ["public/app-alert-sound.js", "public/app-notifications.js",
         "public/app-sidebar.js", "public/staff-manifest.webmanifest"]
spec = importlib.util.spec_from_file_location("attention_release", SERVER / "tools/delivery-timeslot-notifications-release.py")
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
base.TASK, base.OUT, base.RELEASE, base.IMAGE = TASK, OUT, RELEASE, IMAGE
core = base.core
core.RELEASE, core.IMAGE, core.ROLLBACK = RELEASE, IMAGE, IMAGE + "-rollback"
core.READ_NAME = "mbbs-app-notification-attention-reader"
core.CHECK_NAME = "mbbs-app-notification-attention-import"


def inputs():
    assert (TASK / "green/teardown.log").read_text().endswith("teardown_exit=0\n")
    log = (TASK / "green/run.log").read_text()
    assert "# pass 10\n" in log and "# fail 0\n" in log
    return {name: core.sha((SERVER / name).read_bytes()) for name in FILES}


base.tested_inputs = inputs


def validate():
    data = core.state()
    core.current(data)
    environment = {**os.environ, "DELIVERY_ENHANCEMENTS_SOURCE": str(RELEASE / "candidate"),
                   "ATTENTION_ARTIFACT": str(OUT), "ATTENTION_PROJECT": "mbbs-app-notification-attention-release-final"}
    with (RELEASE / "validation.log").open("wb") as log:
        result = subprocess.run(["bash", str(SERVER / "tools/app-notification-attention-test.sh"), "final"],
                                cwd=SERVER.parent, env=environment, stdout=log, stderr=subprocess.STDOUT)
    assert result.returncode == 0, "Exact release candidate verification failed; see validation.log"
    assert (OUT / "teardown.log").read_text().endswith("teardown_exit=0\n")
    tests = json.loads((OUT / "results/test-results.json").read_text())
    assert tests["tests"] > 10 and tests["failed"] == 2 and tests["knownBaselineFailures"] and tests["skipped"] == 0
    mutants = json.loads((OUT / "results/mutations.json").read_text())
    assert len(mutants) == 3 and all(row["killed"] and row["restored"] for row in mutants)
    core.current(data)
    core.save("validation-passed.json", {"passed": True, "at": core.now(),
              "candidateTreeHash": data["candidateTreeHash"], "testResults": tests, "mutantsKilled": len(mutants)})
    print(json.dumps({"validated": True, "testResults": tests, "mutantsKilled": len(mutants)}), flush=True)


def verify():
    data = core.state()
    core.ready(data["candidateImageId"])
    live = core.metadata(core.APP)
    assert live["imageId"] == data["candidateImageId"]
    assert live["configuration"] == data["app"]["configuration"]
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data["dependencies"]
    actual = json.loads(core.docker("exec", core.APP, "node", "-e", core.HASH_SCRIPT))
    assert actual == data["candidateTree"], "Live runtime differs from verified source"
    assets = {name: data["candidateTree"][name] for name in FILES}
    http = core.http_check(assets, ["/api/sales/delivery-requests/meta", "/api/dispatch/delivery-requests/meta"])
    script = """import assert from 'node:assert/strict';
for(const origin of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
 const response=await fetch(origin+'/staff-manifest.webmanifest',{signal:AbortSignal.timeout(15000)});
 assert.equal(response.status,200);const manifest=await response.json();
 assert.equal(manifest.id,'/staff');assert.equal(manifest.scope,'/');assert.equal(manifest.display,'standalone');
 const sidebar=await(await fetch(origin+'/app-sidebar.js?verify=attention',{signal:AbortSignal.timeout(15000)})).text();
 assert.ok(sidebar.includes('/app-alert-sound.js?v=20261014-attention'));
 assert.ok(sidebar.includes('/app-notifications.js?v=20261014-attention'));
}
console.log(JSON.stringify({staffManifestServed:true,soundAndNotificationAssetsVersioned:true}));"""
    extra = json.loads(core.docker("exec", "-i", core.APP, "node", "--input-type=module", input=script.encode(), timeout=90))
    core.save("deployment-result.json", {"deployed": True, "at": core.now(), "image": IMAGE,
              "imageId": live["imageId"], "candidateTreeHash": data["candidateTreeHash"],
              "changedFiles": FILES, "runtimeFilesVerified": len(actual),
              "configurationPreserved": True, "workerAndDependenciesUnchanged": True,
              "schemaChanged": False, "http": http, **extra})
    print(json.dumps({"deployed": True, "image": IMAGE, "http": http, **extra}), flush=True)


base.verify = verify


if __name__ == "__main__":
    atexit.register(core.cleanup_manual)
    {"capture": base.capture, "rebase": base.rebase, "validate": validate,
     "build": core.build, "apply": base.apply, "verify": verify}[sys.argv[1]]()
