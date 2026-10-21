#!/usr/bin/env python3
"""Deploy the personal notification preferences UI over the current live image."""
import atexit
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
TASK = SERVER / "test-artifacts/app-notification-preferences-20261014"
RELEASE = SERVER / "deployments/app-notification-preferences-20261014"
OUT = TASK / "release-final"
IMAGE = "mbbs-operator-app:app-notification-preferences-20261014"
FILES = ["public/app-notifications.js", "public/app-sidebar.js"]
spec = importlib.util.spec_from_file_location("preferences_release", SERVER / "tools/delivery-timeslot-notifications-release.py")
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
base.TASK, base.OUT, base.RELEASE, base.IMAGE = TASK, OUT, RELEASE, IMAGE
core = base.core
core.RELEASE, core.IMAGE, core.ROLLBACK = RELEASE, IMAGE, IMAGE + "-rollback"
core.READ_NAME = "mbbs-app-notification-preferences-reader"
core.CHECK_NAME = "mbbs-app-notification-preferences-import"


def inputs():
    assert (TASK / "green/teardown.log").read_text().endswith("teardown_exit=0\n")
    log = (TASK / "green/run.log").read_text()
    assert "# pass 21\n" in log and "# fail 0\n" in log
    hashes = json.loads((TASK / "green/results/runtime-hashes.json").read_text())
    assert set(hashes) == set(FILES)
    for name, sha in hashes.items():
        assert core.sha((SERVER / name).read_bytes()) == sha, "Tested input changed: " + name
    return hashes


base.tested_inputs = inputs


def validate():
    data = core.state()
    core.current(data)
    environment = {**os.environ, "DELIVERY_ENHANCEMENTS_SOURCE": str(RELEASE / "candidate"),
                   "PREFERENCES_ARTIFACT": str(OUT), "PREFERENCES_PROJECT": "mbbs-app-notification-preferences-release-final"}
    with (RELEASE / "validation.log").open("wb") as log:
        result = subprocess.run(["bash", str(SERVER / "tools/app-notification-preferences-test.sh"), "final"],
                                cwd=SERVER.parent, env=environment, stdout=log, stderr=subprocess.STDOUT)
    assert result.returncode == 0, "Exact release candidate verification failed; see validation.log"
    assert (OUT / "teardown.log").read_text().endswith("teardown_exit=0\n")
    tests = json.loads((OUT / "results/test-results.json").read_text())
    assert tests["tests"] == 107 and tests["passed"] == 105 and tests["failed"] == 2
    assert tests["knownBaselineFailures"] and tests["skipped"] == 0 and tests["runtimeHashes"] == data["workspace"]
    core.current(data)
    core.save("validation-passed.json", {"passed": True, "at": core.now(),
              "candidateTreeHash": data["candidateTreeHash"], "testResults": tests})
    print(json.dumps({"validated": True, "testResults": tests}), flush=True)


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
    core.save("deployment-result.json", {"deployed": True, "at": core.now(), "image": IMAGE,
              "imageId": live["imageId"], "candidateTreeHash": data["candidateTreeHash"],
              "changedFiles": FILES, "runtimeFilesVerified": len(actual),
              "configurationPreserved": True, "workerAndDependenciesUnchanged": True,
              "schemaChanged": False, "http": http})
    print(json.dumps({"deployed": True, "image": IMAGE, "http": http}), flush=True)


base.verify = verify


if __name__ == "__main__":
    atexit.register(core.cleanup_manual)
    {"capture": base.capture, "rebase": base.rebase, "validate": validate,
     "build": core.build, "apply": base.apply, "verify": verify}[sys.argv[1]]()
